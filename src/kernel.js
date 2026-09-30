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
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applySessionEvent, applyStreamFrame, replay } from './projection.js'

/**
 * 决定本次会话的模型路由。
 * 优先 `--model provider/model`，否则用内核的中立默认（ctx.agentDefaultModel）。
 */
export function resolveSelection(ctx, startup) {
  const override = startup?.model
  if (typeof override === 'string' && override.includes('/')) {
    const idx = override.indexOf('/')
    const provider = override.slice(0, idx)
    const model = override.slice(idx + 1)
    if (provider !== '' && model !== '') return { provider, model }
  }

  const defaultModel = ctx.get('agentDefaultModel')
  const current = defaultModel?.currentSelection?.()
  if (current !== undefined && current !== null) {
    return { provider: current.provider, model: current.model }
  }
  // 内核没有默认模型时不编造：交给 adapter 自己报错，错误信息比我们的猜测准确。
  return { provider: undefined, model: undefined }
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

  const selection = resolveSelection(ctx, startup)
  const setup = (agentCtx) => {
    // 把选定的模型路由耦合到该 agent 的装配与请求路由上。
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
  }

  const emit = (type, payload) => {
    try {
      onEvent?.({ type, payload })
    } catch {
      // 状态回调出错不能影响内核路径。
    }
  }

  // ── 建 / 恢复 agent ────────────────────────────────────────────────────

  const resuming = typeof startup?.resume === 'string' && startup.resume !== ''
  if (resuming) {
    handle = await ctx.agents.resume({
      resumeSessionId: SessionId(startup.resume),
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
  } else {
    sessionId = SessionId(`session-${randomUUID()}`)
    handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
  }

  agent = handle.agent
  const boundSessionId = agent.session.id

  // 恢复时先把已有事件重放进视图，让历史对话立刻可见。
  // 注意顺序：先 replay 再订阅，否则同一条事件会被应用两次。
  if (resuming) {
    try {
      replay(view, agent.session.events)
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
      if (applySessionEvent(view, event) === true) onUpdate()
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

  emit('ready', { selection, sessionId: String(boundSessionId), resumed: resuming })

  // ── 驱动 ──────────────────────────────────────────────────────────────

  /** 提交一条用户消息，开启（或继续）一个回合。 */
  function submit(text) {
    if (agent === undefined) return
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    )
  }

  /** 请求中断当前回合。排队中的工作一并丢弃（默认行为）。 */
  function interrupt() {
    if (agent === undefined) return
    try {
      agent.cancel({ kind: 'user' })
    } catch {
      // agent 可能刚好已经空闲/被销毁；中断失败不需要惊动用户。
    }
  }

  /** 把会话缓冲刷进持久化存储。退出前必须调用，否则最后一段对话可能丢。 */
  async function flush() {
    if (agent === undefined) return
    try {
      await ctx.get('sessions')?.flush?.(agent.session)
    } catch {
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
    get agent() {
      return agent
    },
    get sessionId() {
      return String(boundSessionId)
    },
    get selection() {
      return selection
    },
  }
}
