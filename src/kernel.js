/**
 * 内核桥接层：dsh 的 agent / 会话 / 事件 → 本前门。
 *
 * 这一层是**唯一**允许 import `@deepseek-ai/*` 的地方（除了 startup.js 需要
 * dsh-cmdline）。加这道边界是因为内核还在 0.x：升级时改动只会落在这个文件
 * 和 startup.js 里，而不是散进整个界面代码。
 *
 * 职责边界：
 *   - 建/恢复 agent，驱动它（followup / cancel / whenIdle）
 *   - 订阅事件并交给投影层
 *   - 它**不**知道任何界面细节：不 import pi-tui，不碰 registry。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installModelSelection, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference'
import { applySessionEvent, applyStreamFrame, replay, textOfContent } from './projection.js'
import { readSessionEvents } from './session-events.js'
import { parseModelRefCandidates } from './model-catalog.js'

/**
 * 决定本次会话的模型路由。
 * 优先 `--model provider/model`，否则用内核的中立默认（ctx.agentDefaultModel）。
 *
 * @returns {{provider:string,model:string,reasoningEffort?:string}|undefined} 拿不到可用选择时返回
 *   `undefined`，**不是** `{provider:undefined,model:undefined}`。后者是一个
 *   「字段齐全但值为 undefined」的假对象，交给 `installModelSelection` 会被
 *   当成一次真实选择，从而把 undefined 当模型名去发请求。
 */
export function resolveSelection(ctx, startup) {
  const override = startup?.model
  if (typeof override === 'string' && override.includes('/')) {
    const idx = override.indexOf('/')
    const provider = override.slice(0, idx).trim()
    const model = override.slice(idx + 1).trim()
    if (provider !== '' && model !== '') {
      return {
        provider,
        model,
        ...(typeof startup?.reasoningEffort === 'string' && startup.reasoningEffort !== ''
          ? { reasoningEffort: startup.reasoningEffort }
          : {}),
      }
    }
  }

  try {
    const current = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (typeof current?.provider === 'string' && typeof current?.model === 'string') {
      return {
        provider: current.provider,
        model: current.model,
        ...(typeof current.reasoningEffort === 'string' && current.reasoningEffort !== ''
          ? { reasoningEffort: current.reasoningEffort }
          : {}),
      }
    }
  } catch {
    // A missing or partially mounted default-model service is equivalent to no selection.
  }
  return undefined
}

/**
 * 启动路径的模型路由解析：**只在存在歧义时**才向 llm 目录求证。
 *
 * 背景（实机事故）：provider id 可以含斜杠（`roundrobin/<组id>` 虚拟路由），
 * 单纯的「第一个斜杠拆分」会把 `roundrobin/round-glm-5-3f/round-glm-5-3f`
 * 读成 provider=`roundrobin`，于是首次请求报
 * `NO_ADAPTER: no adapter registered for provider "roundrobin"`。
 * 记住的偏好与 `--model` 都走这条路径，所以必须在**建 agent 之前**裁决。
 *
 * 为什么不总是校验：
 * - 无歧义的普通 ref（`my-opencode-go/deepseek-v4.1-flash`）保持原行为——
 *   零延迟，也避免启动早期适配器尚未注册时的误判；
 * - 有歧义时才等目录就绪（有界），再逐个候选试 `resolveCallConfig`。
 *
 * @param {object} ctx
 * @param {object} startup
 * @returns {Promise<{provider:string,model:string,reasoningEffort?:string}|undefined>}
 */
export async function resolveSelectionValidated(ctx, startup) {
  const override = typeof startup?.model === 'string' ? startup.model.trim() : ''
  const candidates = override === '' ? [] : parseModelRefCandidates(override)
  if (candidates.length <= 1) return resolveSelection(ctx, startup)

  const llm = ctx.get?.('llm')
  if (llm === undefined || typeof llm.resolveCallConfig !== 'function') return candidates[0]

  // 等适配器注册（有界）：llm-pi-ai 的渠道是设置驱动、异步注册的。
  const deadline = Date.now() + 5000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
      if (Array.isArray(providers) && providers.length > 0) {
        ready = true
        break
      }
    } catch {
      // 注册表读不到不算致命，继续等。
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200).unref?.())
  }
  // 目录始终没起来：交回未校验的约定读法（请求期会给出真实错误）。
  if (!ready) return candidates[0]

  const effort =
    typeof startup?.reasoningEffort === 'string' && startup.reasoningEffort !== '' ? startup.reasoningEffort : undefined
  let lastError
  for (const candidate of candidates) {
    try {
      const resolved = await llm.resolveCallConfig({
        provider: candidate.provider,
        model: candidate.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      })
      return {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      }
    } catch (error) {
      lastError = error
    }
  }
  // 所有拆分都无效：抛错，让调用方走「忘掉坏偏好并重试一次」的既有路径。
  throw new Error(
    `无法解析模型路由 "${override}"（试过 ${candidates.length} 种 provider/model 拆分）：${lastError?.message ?? lastError}`,
  )
}

/**
 * 解析工具参数。
 *
 * 模型流式生成时 `arguments` 可能还不是合法 JSON；那时不解析，让工具的
 * `presentCall` 自己兜底，而不是在这里抛错把这次调用丢掉。
 */
function parseToolArgs(rawArgs) {
  if (typeof rawArgs !== 'string' || rawArgs.trim() === '') return undefined
  try {
    return JSON.parse(rawArgs)
  } catch {
    return undefined
  }
}

/**
 * 创建内核桥。
 *
 * @param {object} options
 * @param {object} options.ctx       - 插件上下文
 * @param {object} options.view      - 投影层的视图模型（原地更新）
 * @param {object} options.startup   - dshTuiStartup 服务的值
 * @param {(event:{type:string,payload?:any})=>void} [options.onEvent] - 内核事件回调（状态栏用）
 * @param {()=>void} options.onUpdate - 视图发生变化，请求重绘
 */
export async function createKernel({ ctx, view, startup, onEvent, onUpdate }) {
  const disposers = []
  let handle
  let sessionId
  /** @type {import('@deepseek-ai/dsh-agent').Agent | undefined} */
  let agent

  /**
   * Mutable selection is intentional: dsh-agent's installModelSelection reads
   * `current` at every next step, so /model can take effect without destroying
   * the live agent or its session history.
   */
  const selectionRef = { current: await resolveSelectionValidated(ctx, startup), assembled: undefined }
  const presetService = ctx.get('agentPresets')
  const projectionService = ctx.get('sessionProjections')
  let selectedPreset
  const resuming = typeof startup?.resume === 'string' && startup.resume !== ''
  // 显式 --model 在 resume 时也必须赢：它比日志里记录的路由更新。
  const explicitModel =
    typeof startup?.model === 'string' && startup.model.includes('/')

  if (startup?.preset !== undefined && (presetService === undefined || typeof presetService.mount !== 'function')) {
    throw new Error('会话预设服务不可用；此 TUI profile 尚未启用 agent-preset-registry')
  }
  if (presetService !== undefined) {
    // preset 行的注册发生在各自行的 Service.init 里，与本插件的 apply() **并发**。
    // 不能 await ctx.loader（装载树在等本行激活，会死锁——实机已复现：进程静默
    // 挂起、TUI 永不渲染）。改为有界轮询 resolve()，定义就绪即通过。
    const requested = startup?.preset ?? presetService.defaultId
    const deadline = Date.now() + 20_000
    let resolved
    for (;;) {
      try {
        resolved = await presetService.resolve(requested)
        break
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(`会话预设 "${requested}" 在 20s 内未就绪（${error?.message ?? error}）——preset 声明与本 bundle 必须同装`)
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250).unref?.())
      }
    }
    if (!resuming) {
      if (resolved?.broken !== undefined) throw new Error(`预设 ${resolved.id} 不可用：${resolved.broken}`)
      selectedPreset = resolved?.id
    }
  }

  // 拿不到选择时**整个省略** agentOptions，而不是塞一个字段为 undefined 的对象。
  const selectionOptions = () => {
    const selection = selectionRef.current
    return selection === undefined
      ? {}
      : {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        }
  }

  function restoreSelectionFromSession(session) {
    let restored
    try {
      for (const event of readSessionEvents(session)) {
        if (event?.type !== 'model/selection') continue
        const data = event.data
        if (typeof data?.provider !== 'string' || typeof data?.model !== 'string') continue
        restored = {
          provider: data.provider,
          model: data.model,
          ...(typeof data.reasoningEffort === 'string' && data.reasoningEffort !== ''
            ? { reasoningEffort: data.reasoningEffort }
            : {}),
        }
      }
    } catch {
      // A malformed/old log must not prevent resume; fall through to its header.
    }
    if (restored !== undefined) return restored
    const route = session?.requestHeader?.()?.config
    if (typeof route?.provider !== 'string' || typeof route?.model !== 'string') return undefined
    return {
      provider: route.provider,
      model: route.model,
      ...(typeof route.reasoningEffort === 'string' && route.reasoningEffort !== ''
        ? { reasoningEffort: route.reasoningEffort }
        : {}),
    }
  }

  const setup = async (agentCtx, agent) => {
    if (resuming && explicitModel !== true) {
      // 恢复路由的优先级：durable `model/selection`（最新的 pending）→
      // 上一次 request/header → 什么都不设（用内核默认）。显式 --model 始终最高。
      const restored = restoreSelectionFromSession(agent?.session)
      if (restored !== undefined) selectionRef.current = restored
    }

    if (presetService !== undefined && typeof presetService.mount === 'function') {
      let presetId = selectedPreset
      if (resuming) {
        // 恢复预设的优先级：durable `agent-preset/selected`（projection）→
        // 不可变 header → registry 默认。**绝不**让新默认覆盖历史会话的组合——
        // 否则 resume 后模型看到的工具目录和日志里记录的工具调用会对不上。
        try {
          const persisted = projectionService?.stateOf?.(agent.session, 'agentPreset')
          if (typeof persisted === 'string' && persisted !== '') presetId = persisted
        } catch {
          // 旧 profile 没有 agentPreset projection，落到 header。
        }
        if (presetId === undefined && typeof agent.session.header?.agentPreset === 'string') {
          presetId = agent.session.header.agentPreset
        }
        if (presetId === undefined) presetId = presetService.defaultId
        const resolved = await presetService.resolve(presetId)
        if (resolved?.broken !== undefined) throw new Error(`恢复预设 ${resolved.id} 不可用：${resolved.broken}`)
        selectedPreset = resolved?.id
      }
      const mounted = await presetService.mount(agentCtx, presetId)
      selectedPreset = mounted?.id ?? presetId
    }

    installModelSelection(agentCtx, selectionRef)
  }

  const agentOptions = selectionOptions()

  const emit = (type, payload) => {
    try {
      onEvent?.({ type, payload })
    } catch {
      // 状态回调出错不能影响内核路径。
    }
  }

  // ── 建 / 恢复 agent ────────────────────────────────────────────────────

  if (resuming) {
    handle = await ctx.agents.resume({
      resumeSessionId: SessionId(startup.resume),
      agentOptions,
      setup,
    })
  } else {
    sessionId = SessionId(`session-${randomUUID()}`)
    handle = await ctx.agents.create({
      sessionId,
      meta: {
        cwd: process.cwd(),
        ...(selectedPreset === undefined ? {} : { agentPreset: selectedPreset }),
      },
      agentOptions,
      setup,
    })
  }

  agent = handle.agent
  const boundSessionId = agent.session.id

  // ── 工具展示意图解析器 ──────────────────────────────────────────────────
  //
  // 放在这一层是因为只有本层拿得到 `ctx.tools`；投影层是纯函数，不认识任何
  // 内核服务，也不该认识任何工具名。
  //
  // dsh 的工具通过 `presentCall` / `presentResult` 声明一种与提供方无关的卡片
  // 类型（generic/terminal/diff/search/read/web），所以**新工具装上就自带合适的
  // 卡片**，这里不需要维护一张工具名→卡片的表。
  const toolsService = agent.ctx?.get?.('tools') ?? ctx.get('tools')
  const present = {
    call(toolName, rawArgs) {
      const definition = toolsService?.get?.(toolName, assembleContextFor(agent).scope)
      if (typeof definition?.presentCall !== 'function') return undefined
      return definition.presentCall(parseToolArgs(rawArgs))
    },
    result(toolName, rawArgs, resultData) {
      const definition = toolsService?.get?.(toolName, assembleContextFor(agent).scope)
      if (typeof definition?.presentResult !== 'function') return undefined
      return definition.presentResult(parseToolArgs(rawArgs), {
        content: resultData?.message?.content ?? [],
        isError: resultData?.message?.isError === true,
        meta: resultData?.meta,
      })
    },
  }

  // 恢复时先把已有事件重放进视图，让历史对话立刻可见。
  // 注意顺序：先 replay 再订阅，否则同一条事件会被应用两次。
  if (resuming) {
    try {
      // 用 readSessionEvents 而不是 `session.events`：**活会话上 events 是空的**
      // （见 src/session-events.js），直接用它会让 resume 看不到任何历史。
      replay(view, readSessionEvents(agent.session), present)
    } catch {
      // 历史里出现投影层不认识的东西不应该阻止启动。
    }
  }

  // ── 订阅 ──────────────────────────────────────────────────────────────
  //
  // 两条流，用途严格不同：
  //   session/event           已提交的真相（可回放）
  //   agent/assistant-stream  过程态帧（只用于渲染，永不入库）

  disposers.push(
    ctx.on('session/event', (session, event) => {
      if (session === undefined || session.id !== boundSessionId) return
      if (applySessionEvent(view, event, present) === true) onUpdate()
    }),
  )

  disposers.push(
    ctx.on('agent/assistant-stream', (payload) => {
      if (payload === undefined || payload.agent !== agent) return
      if (applyStreamFrame(view, payload.frame) === true) onUpdate()
    }),
  )

  // agent/status 用于状态栏的「正在工作」提示；只观察，不轮询。
  disposers.push(
    ctx.on('agent/status', (payload) => {
      if (payload === undefined || payload.agent !== agent) return
      emit('status', payload)
    }),
  )

  emit('ready', {
    selection: selectionRef.current,
    preset: selectedPreset,
    sessionId: String(boundSessionId),
    resumed: resuming,
  })

  // ── 驱动 ──────────────────────────────────────────────────────────────

  /**
   * 提交一条用户消息，开启（或继续）一个回合。
   *
   * **失败必须抛出来**，不能静默 return。早期版本在 agent 未就绪时直接
   * `return`，而调用方也没有 catch——用户看到的就是「回车没反应，没有任何
   * 报错」。静默失败比报错难查一百倍。
   */
  function submit(text, { delivery = 'followup' } = {}) {
    if (agent === undefined) {
      throw new Error('会话还没建立，无法提交（agent is undefined）')
    }
    if (!['followup', 'steer', 'inject'].includes(delivery)) throw new Error('无法识别的输入方式')
    if (typeof agent[delivery] !== 'function') throw new Error(`当前内核不支持 ${delivery}`)
    agent[delivery](
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    )
  }

  /** 请求中断当前回合。 */
  function interrupt() {
    if (agent === undefined) return
    try {
      // keepInbox：只中止当前回合，**保留**用户已排在后面的消息。
      // 默认行为会把排队中的后续输入一并丢弃——用户按 Esc 想的是「这次别说了」，
      // 不是「顺便把我刚打的第二句也删了」。
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch {
      // agent 可能刚好已经空闲/被销毁；中断失败不需要惊动用户。
    }
  }

  /** 把会话缓冲刷进持久化存储。退出前必须调用，否则最后一段对话可能丢。 */
  async function flush({ strict = false } = {}) {
    if (agent === undefined) return
    try {
      await ctx.get('sessions')?.flush?.(agent.session)
    } catch (error) {
      if (strict) throw error
      // flush 失败不应阻止退出流程。
    }
  }

  async function dispose() {
    for (const disposeListener of disposers) {
      try {
        disposeListener()
      } catch {
        // 逐个清理，单个失败不影响其余。
      }
    }
    disposers.length = 0
    if (handle !== undefined) {
      try {
        await handle.dispose()
      } catch {
        // 内核侧可能已经自行销毁了该 agent。
      }
      handle = undefined
    }
    agent = undefined
  }

  return {
    submit,
    interrupt,
    flush,
    dispose,
    attachView(nextView) { view = nextView },
    runtime: createRuntimeAccess(ctx, () => agent),
    ownsAgent(candidate) {
      if (candidate === agent) return true
      const registry = ctx.get('agents')
      if (!candidate || !registry?.isOwnedBy) return false
      const all = registry.list()
      const owned = new Set([agent])
      for (let changed = true; changed;) {
        changed = false
        for (const child of all) {
          if (!owned.has(child) && [...owned].some((parent) => registry.isOwnedBy(child.id, parent))) { owned.add(child); changed = true }
        }
      }
      return owned.has(candidate)
    },
    get agent() {
      return agent
    },
    get sessionId() {
      return String(boundSessionId)
    },
    get selection() {
      return selectionRef.current
    },
    get preset() {
      return selectedPreset
    },
    async selectModel(next) {
      if (agent === undefined) throw new Error('会话还没建立，无法切换模型')
      const provider = typeof next?.provider === 'string' ? next.provider : ''
      const model = typeof next?.model === 'string' ? next.model : ''
      if (provider === '' || model === '') throw new Error('模型选择必须包含 provider 和 model')

      const llm = ctx.get('llm')
      if (llm === undefined || typeof llm.resolveCallConfig !== 'function') {
        throw new Error('当前 profile 没有可用的 LLM 校验服务')
      }
      const resolved = await llm.resolveCallConfig({
        provider,
        model,
        ...(typeof next.reasoningEffort === 'string' && next.reasoningEffort !== ''
          ? { reasoningEffort: next.reasoningEffort }
          : {}),
      })
      const selected = {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      }

      // Canonical durable event + the same mutable selection seam used by the
      // agent loop. Existing turns stay intact; the next request uses selected.
      agent.session.append('model/selection', selected)
      selectionRef.current = selected
      let defaultSaved = true
      try {
        await ctx.get('agentDefaultModel')?.saveSelection?.(selected)
      } catch (error) {
        // Session-local selection succeeded; default persistence is best effort
        // and the caller must be able to report it honestly (假成功是大敌).
        defaultSaved = false
        onEvent?.({ type: 'model-save-warning', payload: error })
      }
      onUpdate?.()
      return { ...selected, defaultSaved }
    },
    async selectPreset(id) {
      if (agent === undefined) throw new Error('会话还没建立，无法切换预设')
      if (typeof id !== 'string' || id.trim() === '') throw new Error('预设 id 不能为空')
      if (presetService === undefined || typeof presetService.select !== 'function') {
        throw new Error('当前 profile 没有启用会话预设')
      }
      const selected = await presetService.select(agent, id.trim())
      selectedPreset = selected
      onUpdate?.()
      return selected
    },
  }
}

/** Read-only inspection plus explicit inbox operations over the native Agent. */
export function createRuntimeAccess(ctx, getAgent) {
  const agent = () => {
    const current = getAgent()
    if (!current) throw new Error('当前会话已关闭')
    return current
  }
  /**
   * /resume 列表的短 TTL 缓存。
   *
   * 实测（DSH_TUI_DEBUG_SESSIONS=1）：listSessions 扫全库 ~250ms，
   * readTitleSnapshots 为每个候选加载完整事件日志折叠标题 ~620ms。连续打开
   * /resume（改范围、选错再开）不该反复付这笔钱。20s 足够短：期间新建的会话
   * 本来也不会成为「可恢复的历史会话」。
   */
  const sessionsCache = new Map()
  const SESSIONS_TTL_MS = 20_000
  return {
    async sessions({ all = false, signal } = {}) {
      const current = agent()
      const query = ctx.get('sessionQuery')
      if (typeof query?.listSessions !== 'function') throw new Error('当前运行时没有会话目录服务')
      const cwd = current.session.header?.cwd ?? process.cwd()
      const cacheKey = `${all ? 'all' : 'cwd'}:${cwd}`
      const cached = sessionsCache.get(cacheKey)
      if (cached !== undefined && Date.now() - cached.at < SESSIONS_TTL_MS) return [...cached.value]
      // DSH_TUI_DEBUG_SESSIONS=1 把两个阶段的耗时写进临时文件（不写 stderr，
      // 免得搅乱 TUI）。/resume 的等待就花在这两步上，排查先看这里。
      const debug = process.env.DSH_TUI_DEBUG_SESSIONS === '1'
      const t0 = Date.now()
      const listed = await query.listSessions(signal)
      const t1 = Date.now()
      const records = listed.filter((record) => record.persisted && !record.live && record.header.origin !== 'subagent'
        && (all || record.header.cwd === cwd)).slice(0, 100)
      let titles = []
      if (typeof query.readTitleSnapshots === 'function') titles = await query.readTitleSnapshots(records.map((record) => record.header.id), signal)
      const t2 = Date.now()
      if (debug) {
        try {
          fs.appendFileSync(path.join(os.tmpdir(), 'dsh-tui-sessions-timing.log'),
            `${new Date().toISOString()} listSessions=${t1 - t0}ms readTitles=${t2 - t1}ms listed=${listed.length} candidates=${records.length}\n`)
        } catch {
          // 诊断写不进去不影响功能。
        }
      }
      const titleMap = new Map(titles.filter((row) => row.status === 'fulfilled').map((row) => [row.sessionId, row.value.title]))
      const value = records.map(({ header }) => ({ id: String(header.id), cwd: header.cwd, createdAt: header.createdAt,
        title: titleMap.get(header.id)?.title, updatedAt: titleMap.get(header.id)?.updatedAt ?? header.createdAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
      sessionsCache.set(cacheKey, { at: Date.now(), value })
      return [...value]
    },
    async validateResume(id) {
      const query = ctx.get('sessionQuery')
      if (typeof query?.readTitleSnapshot === 'function') {
        const snapshot = await query.readTitleSnapshot(SessionId(id))
        if (snapshot.session.origin === 'subagent') throw new Error('子 Agent 会话请从 /agents 查看，不能作为主会话恢复')
      }
    },
    snapshot() {
      const current = agent()
      return { status: current.status,
        queued: current.inbox?.nextTurn?.length ?? 0,
        steering: current.inbox?.nextStep?.length ?? 0,
        sessionId: String(current.session.id), cwd: current.session.header?.cwd }
    },
    context() {
      const session = agent().session
      if (typeof session.deriveMessages !== 'function') throw new Error('内核未提供上下文读取能力')
      return session.deriveMessages().map((message, index) => ({
        id: String(message.id ?? index), role: message.role, source: message.source,
        text: message.content.map((block) => {
          if (block.type === 'text' || block.type === 'reasoning') return block.text ?? ''
          if (block.type === 'tool-call') return `[工具调用 ${block.name}]\n${typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments)}`
          return `[${block.type}]`
        }).join('\n'),
      }))
    },
    tools() {
      const current = agent()
      const header = current.session.requestHeader?.()
      if (header) return { ready: true, source: '最近请求', tools: header.tools ?? [] }
      const service = current.ctx?.get?.('tools') ?? ctx.get('tools')
      if (typeof service?.schemas === 'function') return { ready: true, source: '当前作用域', tools: service.schemas(assembleContextFor(current).scope) }
      return { ready: false, tools: [] }
    },
    queue() {
      const inbox = agent().inbox
      return [['next-step', inbox?.nextStep], ['next-turn', inbox?.nextTurn]].flatMap(([target, messages]) =>
        (messages ?? []).map((message) => ({ id: message.id, target, text: textOfContent(message.content) })))
    },
    removeQueued(id) { return agent().inbox?.remove?.(id) === true },
    async children(signal) {
      const parent = agent()
      const service = ctx.get('subagents')
      if (typeof service?.listChildren !== 'function') throw new Error('当前运行时未启用子 Agent 目录')
      const rows = await service.listChildren(parent.session.id, signal)
      return rows.map((row) => ({ ...row, status: ctx.get('agents')?.get?.(row.id)?.status ?? 'inactive' }))
    },
    async files(query, signal) {
      const service = ctx.get('fileReferences')
      if (typeof service?.list !== 'function') return undefined
      return service.list(agent(), query, signal)
    },
    parseMention: activeAtToken,
    formatMention: formatFileMention,
  }
}
