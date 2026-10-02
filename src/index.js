/**
 * @arcaneorion/dsh-tui —— 插件入口。
 *
 * 组装顺序（也是本目录的分层顺序，从下往上）：
 *
 *   kernel.js      内核桥：建 agent、驱动、订阅事件      ← 唯一碰 @deepseek-ai/*
 *   projection.js  投影：dsh 事件 → 视图模型（行）
 *   registry.js    实现点：每个界面区域都可整体替换
 *   messages.js    默认消息渲染器（注册进 registry，不是写死）
 *   app.js         pi-tui 外壳：把区域组装成终端应用
 *
 * 本文件只负责：判定启动身份 → 装配上述各层 → 接退出路径。
 */

import { createRequire } from 'node:module'
import path from 'node:path'

import { createApp } from './app.js'
import { renderWelcomeBox, welcomeRow } from './banner.js'
import { collectStartupSections } from './startup-info.js'
import { createCommandAutocomplete, createCommandSystem, helpText, parseCommandLine } from './commands.js'
import { installConsoleGuard } from './console-guard.js'
import { createFooterInfo } from './footer.js'
import { HostMode, resolveHostMode } from './host.js'
import { installInteractive } from './interactive.js'
import { logTerminalState, tapStdin } from './keylog.js'
import { combineAutocomplete, createFileIndex, createMentionAutocomplete, createNativeMentionAutocomplete } from './mentions.js'
import { createPrefs } from './prefs.js'
import { loadModelCatalog, modelOptions, parseModelRefCandidates, providerOptions, reasoningOptions } from './model-catalog.js'

const pkg = createRequire(import.meta.url)('../package.json')
import { createKernel } from './kernel.js'
import { installDefaultRenderers } from './messages.js'
import { applySessionEvent, createView } from './projection.js'
import { createRegistry } from './registry.js'
import { createTheme, listThemes, tokensForTheme, THEMES, DEFAULT_THEME_ID } from './theme.js'
import { createWorkbench } from './workbench.js'
import { createSessionSwitcher } from './session-switch.js'

/** 稳定的 Cordis 插件名。 */
export const name = 'dsh-tui'

/**
 * 代码级依赖保持最小：只等启动参数。
 * 其余服务（agents / sessions / agentDefaultModel）在下面用 `ctx.get` 软解析，
 * 缺了就报一条清晰的错，而不是让整棵树卡在 "waiting for service"。
 */
export const inject = ['dshTuiStartup']

/**
 * 挂载终端前门。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function apply(ctx) {
  const mode = resolveHostMode()
  if (mode.mode !== HostMode.INTERACTIVE) {
    // 写 stderr 而不是 logger：这是**用户需要立刻看到**的诊断，不是内部调试
    // 信息。否则 `dsh tui` 在管道下会静默挂起，看起来像坏了。
    //
    // 但**不主动退出**：本 bundle 可能被装进一个由别的宿主（Web/GUI）拥有的
    // profile，那种情况下擅自退出会连宿主一起杀掉。降级 + 说明才是安全行为。
    process.stderr.write(
      `dsh-tui: not mounting — ${mode.reason}.\n` +
        'dsh-tui: this profile is a terminal front door; run it from an interactive terminal.\n',
    )
    return
  }

  const startup = ctx.get('dshTuiStartup')
  if (startup === undefined) return

  const agents = ctx.get('agents')
  if (agents === undefined) {
    throw new Error('dsh-tui: ctx.agents is unavailable — the profile must include a bundle that provides the agent registry (e.g. @deepseek-ai/dsh-base)')
  }

  // 偏好持久化：记住上次用的模型。与 harness 状态（~/.dsh/）分开存。
  const prefs = createPrefs()
  const saved = prefs.read()
  // 命令行显式给的 --model 永远优先于记住的。
  const appliedSavedModel = startup.resume === undefined && startup.model === undefined && typeof saved.model === 'string' && saved.model.includes('/')
  const effectiveStartup = appliedSavedModel ? { ...startup, model: saved.model } : startup

  // 主题：上次选的优先（未知 id 退回默认）。theme 对象支持热切，/theme
  // 运行中换 token 表即可，不必重启。
  let currentThemeId = typeof saved.theme === 'string' && THEMES[saved.theme] !== undefined
    ? saved.theme
    : DEFAULT_THEME_ID
  const theme = createTheme(tokensForTheme(currentThemeId))
  const registry = createRegistry()
  const view = createView()
  const disposeDefaultRenderers = installDefaultRenderers(registry)

  /** @type {ReturnType<typeof createApp> | undefined} */
  let app
  let workbench
  let sessionSwitcher
  /** welcome 行渲染器的卸载函数（注册得比 teardown 晚，用 let 避开 TDZ）。 */
  let disposeWelcomeRenderer

  // ── 内核桥 ────────────────────────────────────────────────────────────

  /**
   * agent 状态 → 视图的回合标记。
   *
   * `agent/status` 是「现在到底有没有回合在跑」的唯一权威来源。只靠
   * turn/start 与 turn/end 推断是有洞的：日志可能停在 turn/start（上次进程
   * 崩在回合中间），于是 turnActive 永远为 true —— spinner 一直转，
   * 而且 Ctrl+C 永远只会走「中断」分支，退不出程序。
   */
  const onEvent = (event) => {
    if (event?.type !== 'status') return
    const status = event.payload?.status
    if (status === undefined) return
    const active = status === 'running'
    if (view.turnActive !== active) {
      view.turnActive = active
      view.revision += 1
      app?.requestRender()
    }
  }

  let kernel
  try {
    kernel = await createKernel({
      ctx,
      view,
      startup: effectiveStartup,
      onUpdate: () => app?.requestRender(),
      onEvent,
    })
  } catch (error) {
    // 记住的模型可能已经失效（渠道下线、改名）。这时**忘掉它并重试一次**，
    // 否则用户会被一个自己都改不掉的偏好锁在门外——启动都起不来，自然也
    // 跑不了 /model。
    if (appliedSavedModel) {
      prefs.write({ model: undefined })
      try {
        kernel = await createKernel({
          ctx,
          view,
          startup,
          onUpdate: () => app?.requestRender(),
          onEvent,
        })
      } catch (retryError) {
        disposeDefaultRenderers()
        throw new Error(`dsh-tui: failed to start the agent session — ${retryError?.message ?? retryError}`)
      }
    } else {
      disposeDefaultRenderers()
      throw new Error(`dsh-tui: failed to start the agent session — ${error?.message ?? error}`)
    }
  }

  // ── 界面 ──────────────────────────────────────────────────────────────

  let exiting = false
  /** 人机回环的卸载器，在 app 起好之后才装上。 */
  let uninstallInteractive = () => {}
  /** 杂散输出防护的还原函数；app 起好之后才真正装上。 */
  let restoreConsole = () => {}

  /**
   * 退出清理，幂等。shutdown 与 ctx.effect 都走这里。
   * 顺序很重要：先摘掉交互回环（不再接新的审批/提问），再把会话刷进存储，
   * 然后拆界面，最后销毁 agent——反过来会丢最后一段对话。
   */
  async function teardown({ flush = true } = {}) {
    try {
      uninstallInteractive()
    } catch {
      // 卸载失败不能阻止退出。
    }
    try {
      restoreConsole()
    } catch {
      // 还原 console 失败也不能阻止退出。
    }
    // **在 flush 之前**结算还等着的弹窗。否则 `await kernel.flush()` /
    // `await kernel.dispose()` 可能在等一个永远不来的审批回答，
    // shutdown 就永远走不到 process.exit。
    try {
      app?.cancelPrompts?.()
    } catch {
      // 结算失败也要继续往下走。
    }
    if (flush) {
      try {
        await kernel.flush()
      } catch {
        // 刷盘失败不能阻止退出。
      }
    }
    try {
      app?.dispose()
    } catch {
      // 终端还原失败不能阻止进程退出。
    }
    try {
      await kernel.dispose()
    } catch {
      // 同上。
    }
    disposeDefaultRenderers()
    try {
      disposeWelcomeRenderer?.()
    } catch {
      // 卸载渲染器失败不影响退出。
    }
  }

  async function shutdown(code = 0) {
    if (exiting) return
    exiting = true

    // **硬超时兜底。** flush / dispose 任何一个卡住（内核侧还在等、存储慢、
    // 有未结算的审批），用户就会被困在一个退不出去的 TUI 里，只能强杀进程。
    // 实机上表现为终端提示符出现 `INT` 标记。清理是尽力而为，退出必须可达。
    const forceExit = setTimeout(() => {
      process.stderr.write('dsh-tui: 退出清理超时，强制退出。\n')
      try {
        app?.dispose()
      } catch {
        // 已经尽力了。
      }
      process.exit(code)
    }, 3000)
    forceExit.unref?.()

    await teardown({ flush: true })
    clearTimeout(forceExit)

    const exit = ctx.get('appExit')
    if (typeof exit === 'function') exit(code)
    else process.exit(code)
  }

  let modelLabel =
    kernel.selection === undefined ? '' : [kernel.selection.provider, kernel.selection.model].filter(Boolean).join('/')
  let presetLabel = kernel.preset ?? ''
  let modelCatalog
  let modelCatalogPromise

  async function getModelCatalog() {
    if (modelCatalog !== undefined) return modelCatalog
    if (modelCatalogPromise !== undefined) return modelCatalogPromise
    modelCatalogPromise = loadModelCatalog(ctx.get('llm')).then((catalog) => {
      modelCatalog = catalog
      modelCatalogPromise = undefined
      return catalog
    })
    return modelCatalogPromise
  }

  async function selectModelInteractively() {
    const catalog = await getModelCatalog()
    if (catalog.providers.length === 0) {
      app?.notice?.(['没有可用的已注册渠道。', ...catalog.errors.map((x) => `  · ${x}`)].join('\n'))
      return
    }
    const provider = await app.choose({
      title: '选择渠道商',
      detail: catalog.dormant.length > 0 ? `另有 ${catalog.dormant.length} 个渠道已声明但尚未激活` : undefined,
      options: providerOptions(catalog),
    })
    if (provider === undefined) return
    const providerRow = catalog.providers.find((row) => row.provider === provider)
    const model = await app.choose({ title: `选择模型 · ${providerRow?.name ?? provider}`, options: modelOptions(providerRow) })
    if (model === undefined) return
    let reasoningEffort
    try {
      const info = await ctx.get('llm')?.resolveModelInfo?.(provider, model)
      const efforts = reasoningOptions(info)
      if (efforts.length > 0) {
        reasoningEffort = await app.choose({ title: '选择推理强度', options: efforts })
        if (reasoningEffort === undefined) return
      }
    } catch (error) {
      app?.notice?.(`模型元数据读取失败，将使用提供方默认推理强度：${error?.message ?? error}`)
    }
    try {
      const selected = await kernel.selectModel({ provider, model, reasoningEffort })
      modelLabel = `${selected.provider}/${selected.model}`
      const savedPreference = prefs.write({ model: modelLabel })
      app?.notice?.(
        `已切换模型：${modelLabel}${selected.reasoningEffort ? ` · reasoning:${selected.reasoningEffort}` : ''}` +
          `\n下一步请求生效。${selected.defaultSaved === false || !savedPreference.ok ? '\n默认偏好未完整保存。' : ''}`,
      )
      app?.requestRender?.()
    } catch (error) {
      app?.notice?.(`模型切换失败：${error?.message ?? error}`)
    }
  }

  async function selectPresetInteractively() {
    const presets = ctx.get('agentPresets')
    if (presets === undefined || typeof presets.list !== 'function') {
      app?.notice?.('当前 profile 未启用会话预设。需要挂载 agent-preset-registry 与 preset 定义。')
      return
    }
    const rows = await presets.list()
    const available = rows.filter((row) => row?.broken === undefined)
    if (available.length === 0) {
      app?.notice?.('没有可用的会话预设。')
      return
    }

    // 创造模式（对齐 Web 表面的引导）：preset 不是运行时对象，创建 = 让
    // Agent 在 cordis 预设里起草一个「声明 preset 的 bundle」再安装。
    // roster 带 cordis 预设时才出现这个入口——它自带 tool-cordis 与
    // plugin-manager 工具，正是起草与安装所需的能力面。
    const CREATOR_VALUE = '__creator__'
    const options = available.map((row) => ({
      value: row.id,
      label: `${row.name ?? row.id}${row.id === presetLabel ? '  ✓' : ''}`,
      description: row.description ?? row.id,
    }))
    if (available.some((row) => row.id === 'cordis')) {
      options.unshift({
        value: CREATOR_VALUE,
        label: '✦ 创造模式 · 起草新预设',
        description: '切到 cordis 预设，由 Agent 起草并安装声明预设的 bundle（空白会话）',
      })
    }

    const chosen = await app.choose({ title: '选择会话预设', options })
    if (chosen === undefined) return
    if (chosen === CREATOR_VALUE) {
      await startCreatorMode()
      return
    }
    if (chosen === presetLabel) return
    try {
      presetLabel = await kernel.selectPreset(chosen)
      app?.notice?.(`已选择预设：${presetLabel}`)
    } catch (error) {
      app?.notice?.(`预设切换失败：${error?.message ?? error}`)
    }
  }

  /**
   * 创造模式：把空白会话切到 cordis 预设，并预填一段引导输入。
   *
   * 与 Web 的 Creator 入口同一模式：preset 的创建由 Agent 完成（写成
   * bundle → 安装），TUI 只负责把用户带进正确的预设和正确的起点。
   * 仅空白会话可切——这是内核「会话产出过内容后工具集不可换」的规则，
   * 失败时如实说明出路。
   */
  async function startCreatorMode() {
    try {
      presetLabel = await kernel.selectPreset('cordis')
    } catch (error) {
      app?.notice?.(`进入创造模式失败：${error?.message ?? error}\n（预设只能切换空白会话；已有对话时请重开一个会话再用 /preset create。）`)
      return
    }
    app?.notice?.('已进入创造模式（cordis 预设）。说明你想要的预设——工具集、人格、提示段、技能——Agent 会起草 bundle 并安装；新预设装好后即可 /preset 选择。')
    app?.setEditorText?.('帮我创建一个会话预设：')
  }

  // 底栏的数据源。它负责所有取数（token 计量、沙箱模式、git 分支、模型窗口），
  // 组件本身只做纯渲染。任何一个服务缺失都会让对应那一段消失，而不是显示假数据。
  const footerInfo = createFooterInfo({
    ctx,
    getAgent: () => kernel.agent,
    getSelection: () => kernel.selection,
    onUpdate: () => app?.requestRender(),
  })

  // 斜杠命令：本地命令自己处理，其余交给内核的注册表。
  const commandSystem = createCommandSystem({ ctx, getAgent: () => kernel.agent })

  // 补全：命令走 `/`，文件引用走 `@`。
  let localFileCwd
  let localFileIndex
  const fallbackFiles = () => {
    const cwd = kernel.agent.session.header?.cwd ?? process.cwd()
    if (cwd !== localFileCwd) { localFileCwd = cwd; localFileIndex = createFileIndex(cwd, { warm: false }) }
    return localFileIndex()
  }
  const mentionAutocomplete = createNativeMentionAutocomplete({ runtime: {
    parseMention: (...args) => kernel.runtime.parseMention(...args),
    formatMention: (...args) => kernel.runtime.formatMention(...args),
    files: (...args) => kernel.runtime.files(...args),
  },
    fallback: createMentionAutocomplete({ listFiles: fallbackFiles }) })

  /** 自检报告：直接回答「哪些内核服务接上了、哪些没有」。 */
  function doctorReport() {
    const mark = (name) => (ctx.get(name) === undefined ? '✗ 缺失' : '✓ 已接')
    let toolCount
    try {
      const list = ctx.get('tools')?.list
      if (typeof list === 'function') toolCount = list.call(ctx.get('tools')).length
    } catch {
      toolCount = undefined
    }
    return [
      `dsh-tui ${pkg.version} 自检`,
      `  session      ${kernel.sessionId}`,
      `  model        ${modelLabel === '' ? '(内核默认)' : modelLabel}`,
      `  cwd          ${process.cwd()}`,
      `  skills       ${mark('skills')}`,
      `  commands     ${mark('commands')}`,
      `  tools        ${toolCount === undefined ? mark('tools') : `✓ ${toolCount} 个`}`,
      `  tokenMeter   ${mark('tokenMeter')}   ← 底栏用量段`,
      `  sandboxPolicy ${mark('sandboxPolicy')}   ← 底栏沙箱段`,
      `  llm          ${mark('llm')}   ← 底栏上下文上限`,
      `  agentPresets ${mark('agentPresets')}   ← /preset 会话预设`,
      `  approval     ${mark('approval')}   ← 授权弹窗`,
      `  userQuestions ${mark('userQuestions')}   ← 提问弹窗`,
      `  偏好文件     ${prefs.file}`,
    ].join('\n')
  }

  /** 执行一行斜杠命令。 */
  async function runCommand(line) {
    const parsed = parseCommandLine(line)
    if (parsed === undefined) return
    if (sessionSwitcher?.busy && !['exit', 'quit'].includes(parsed.name)) {
      app?.notice?.('正在恢复会话，请稍候')
      return
    }
    if (await workbench?.execute(parsed.name, parsed.rest)) return

    if (commandSystem.isLocal(parsed.name)) {
      if (parsed.name === 'exit' || parsed.name === 'quit') {
        void shutdown(0)
        return
      }
      if (parsed.name === 'help') {
        await app?.document?.({ title: '命令指南', text: 'Ctrl+K 工作台 · Ctrl+O 工具全文 · Ctrl+T 思考全文\nEsc 返回 / 中断 · Ctrl+C 退出\n\n' + helpText(commandSystem.listAll()) })
        return
      }
      if (parsed.name === 'doctor') {
        await app?.document?.({ title: '运行时诊断', text: doctorReport() })
        return
      }
      if (parsed.name === 'model') {
        if (parsed.rest === '') {
          const current = kernel.selection === undefined ? '(内核默认)' : `${kernel.selection.provider}/${kernel.selection.model}`
          app?.notice?.(`当前模型：${current}\n正在打开渠道/模型选择…（也可直接输入 /model provider/model）`)
          await selectModelInteractively()
          return
        }
        // provider id 本身可能含斜杠（roundrobin/<组id> 虚拟路由），所以
        // 「第一个斜杠」拆分可能切错。每个斜杠位置都作为候选，交给 selectModel
        // 的 resolveCallConfig 校验裁决——校验是权威，文本只是候选生成。
        const candidates = parseModelRefCandidates(parsed.rest)
        if (candidates.length === 0) {
          app?.notice?.('/model 需要 provider/model 形式，例如 /model my-opencode-go/deepseek-v4.1-flash')
          return
        }
        try {
          let selected
          let lastError
          for (const candidate of candidates) {
            try {
              selected = await kernel.selectModel(candidate)
              break
            } catch (error) {
              lastError = error
            }
          }
          if (selected === undefined) throw lastError ?? new Error('没有可校验的 provider/model 拆分')
          modelLabel = `${selected.provider}/${selected.model}`
          const result = prefs.write({ model: modelLabel })
          app?.notice?.(`已切换模型：${modelLabel}${selected.reasoningEffort ? ` · reasoning:${selected.reasoningEffort}` : ''}\n下一步请求生效。${result.ok ? '默认值也已保存。' : `默认值保存失败：${prefs.file}`}`)
          app?.requestRender?.()
        } catch (error) {
          app?.notice?.(`模型切换失败：${error?.message ?? error}`)
        }
        return
      }
      if (parsed.name === 'preset') {
        if (parsed.rest === '') {
          await selectPresetInteractively()
          return
        }
        if (parsed.rest === 'create' || parsed.rest === 'creator') {
          await startCreatorMode()
          return
        }
        try {
          presetLabel = await kernel.selectPreset(parsed.rest)
          app?.notice?.(`已选择预设：${presetLabel}`)
        } catch (error) {
          app?.notice?.(`预设切换失败：${error?.message ?? error}`)
        }
        return
      }
      if (parsed.name === 'diff') {
        await app?.showDiff?.()
        return
      }
      if (parsed.name === 'pane') {
        // /pane           → auto → on → off → auto 轮换
        // /pane auto|on|off → 直接设定
        const current = app?.getPaneMode?.() ?? 'auto'
        const mode = ['auto', 'on', 'off'].includes(parsed.rest) ? parsed.rest : undefined
        const next = mode ?? (current === 'auto' ? 'on' : current === 'on' ? 'off' : 'auto')
        app?.setPaneMode?.(next)
        const hint = { auto: '有文件编辑时出现，回合结束保留最后状态（默认）', on: '常驻右栏', off: '关闭' }[next]
        app?.notice?.(`文件编辑右栏：${next} · ${hint}`)
        app?.requestRender?.()
        return
      }
      if (parsed.name === 'theme') {
        // 带参数直接切（/theme pi），否则弹选择器。切换是热切：token 表整张
        // 替换，活视口与后续渲染立即用新配色（已推进 scrollback 的历史行不变，
        // 这是终端本身的限制，pi 也一样）。
        const apply = (id) => {
          const applied = app?.setTheme?.(id)
          if (applied === undefined) return undefined
          currentThemeId = applied
          const result = prefs.write({ theme: applied })
          return { applied, remembered: result.ok }
        }

        if (parsed.rest !== '') {
          const result = apply(parsed.rest)
          if (result === undefined) {
            app?.notice?.('/theme 不可用（界面尚未就绪）')
            return
          }
          app?.notice?.(`主题：${result.applied}${result.remembered ? '（已记住）' : `（偏好保存失败：${prefs.file}）`}`)
          app?.requestRender?.()
          return
        }

        const options = listThemes().map((t) => ({
          value: t.id,
          label: `${t.name}${t.id === currentThemeId ? '  ✓' : ''}`,
          description: t.description,
        }))
        const chosen = await app.choose({ title: '选择主题', options })
        if (chosen === undefined) return
        const result = apply(chosen)
        if (result === undefined) return
        app?.notice?.(`主题已切换到 ${result.applied}${result.remembered ? '，已记住' : `（偏好保存失败：${prefs.file}）`}`)
        app?.requestRender?.()
        return
      }
      if (parsed.name === 'permission') {
        // 权限预设 = 沙箱模式 + 审批策略的组合（read-only / workspace-write /
        // danger-full-access）。切换写的是会话事件，底栏权限段与后续工具调用
        // 自动跟随。Shift+Tab 走同一条路（/permission cycle）。
        const runtime = kernel.runtime
        if (runtime.permission?.available?.() !== true) {
          app?.notice?.('当前 profile 未启用权限预设（需要 @deepseek-ai/dsh-permission-presets 行）')
          return
        }
        const describe = (name) => {
          const spec = runtime.permission.resolve?.(name)
          return spec === undefined ? String(name) : `${name} · 沙箱 ${spec.sandbox} · 审批 ${spec.approval}`
        }
        // 切换成功后**不插 notice**：状态行下面那行权限提示会立刻更新，
        // 那才是持久回执（临时 notice 会往对话里塞行，反而更吵）。
        const apply = (name) => {
          try {
            runtime.permission.set(name)
            app?.requestRender?.()
          } catch (error) {
            app?.notice?.(`权限切换失败：${error?.message ?? error}`)
          }
        }

        if (parsed.rest === 'cycle' || parsed.rest === 'next') {
          try {
            runtime.permission.cycle()
            app?.requestRender?.()
          } catch (error) {
            app?.notice?.(`权限切换失败：${error?.message ?? error}`)
          }
          return
        }
        if (parsed.rest !== '') {
          apply(parsed.rest)
          return
        }

        const catalog = runtime.permission.catalog()
        const currentName = runtime.permission.current()
        const options = (catalog?.options ?? []).map((option) => ({
          value: option.value,
          label: `${option.name ?? option.value}${option.value === currentName ? '  ✓' : ''}`,
          description: option.description ?? describe(option.value),
        }))
        if (options.length === 0) {
          app?.notice?.('没有可用的权限预设')
          return
        }
        const chosen = await app.choose({ title: '权限预设', detail: '沙箱模式 + 审批策略 · Shift+Tab 循环切换', options })
        if (chosen !== undefined) apply(chosen)
        return
      }
      return
    }

    // 内核命令：注册表与执行都归它，TUI 只把行发过去、把结果画出来。
    app?.notice?.(`/${parsed.name}`)
    try {
      const result = await commandSystem.executeKernel(line)
      if (result === undefined) {
        app?.notice?.(`未知命令：/${parsed.name}（用 /help 看可用命令）`)
        return
      }
      if (result.text !== '') app?.notice?.(result.text)
    } catch (error) {
      app?.notice?.(`命令失败：${error?.message ?? error}`)
    }
  }

  // createApp 会构造真实的终端对象（ProcessTerminal / Editor），这一步可能抛。
  // 抛了就必须把已经建起来的 agent 与监听全部回收，否则每失败一次泄漏一个会话。
  try {
    app = createApp({
      view,
      theme,
      registry,
      loadWorkspaceChanges: () => kernel.runtime.changes(),
      initialPaneMode: saved.paneMode,
      onPaneModeChange: paneMode => prefs.write({ paneMode }),
      onSubmit: (text) => {
        if (sessionSwitcher?.busy) { app?.notice?.('正在恢复会话，草稿已保留'); return false }
        // 提交环节的任何异常都必须在界面上**看得见**。静默失败会让用户
        // 以为是按键失灵，而真正的原因藏在没人看的地方。
        //
        // DSH_TUI_DEBUG_SUBMIT=1 会额外打出每一步的回执，用来区分
        // 「onSubmit 根本没被调到」和「调到了但内核没反应」——
        // 这两种症状在界面上长得一模一样。
        const debug = process.env.DSH_TUI_DEBUG_SUBMIT === '1'
        if (debug) app?.notice?.(`[debug] onSubmit 收到：${JSON.stringify(text)}`)
        try {
          kernel.submit(text)
          if (debug) app?.notice?.('[debug] agent.followup 已调用')
        } catch (error) {
          app?.notice?.(`提交失败：${error?.message ?? error}`)
          return false
        }
      },
      onCommand: (line) => {
        // 异步命令的拒绝也必须落地，不能变成 unhandledRejection。
        void runCommand(line).catch((error) => {
          app?.notice?.(`命令执行失败：${error?.message ?? error}`)
        })
      },
      listCommands: () => commandSystem.listAll(),
      combineProviders: () =>
        combineAutocomplete([createCommandAutocomplete({ list: () => commandSystem.listAll() }), mentionAutocomplete]),
      onInterrupt: () => {
        kernel.interrupt()
      },
      onExit: () => {
        void shutdown(0)
      },
      getSnapshot: () => footerInfo.snapshot(),
      getSessionLabel: () => shortSessionId(kernel.sessionId),
      getQueueState: () => kernel.runtime.snapshot(),
      getState: () => ({
        turnActive: view.turnActive === true,
        workingActive: view.turnActive === true || view.compacting === true,
        statusText: view.compacting ? '正在整理上下文' : view.turnActive ? [
          view.step ? `第 ${view.step} 步` : '准备中',
          view.rows.some((row) => row.role === 'tool' && !row.done) ? '正在执行工具' : '正在思考与回应',
        ].join(' · ') : undefined,
      }),
    })
  } catch (error) {
    await teardown({ flush: true })
    throw new Error(`dsh-tui: failed to mount the terminal UI — ${error?.message ?? error}`)
  }

  const buildWorkbench = () => createWorkbench({ app, kernel, view, registry, runCommand,
    resumeSession: (id) => sessionSwitcher.resume(id) })
  sessionSwitcher = createSessionSwitcher({ ctx, view, createKernel, getKernel: () => kernel,
    isExiting: () => exiting, onEvent, onUpdate: () => app?.requestRender(),
    onCommit: (next) => {
      kernel = next
      modelLabel = next.selection ? `${next.selection.provider}/${next.selection.model}` : ''
      presetLabel = next.preset ?? ''
      workbench = buildWorkbench()
      app.resetConversation()
      void footerInfo.warmUp()
    },
  })
  workbench = buildWorkbench()
  ctx.provide('dshTui', { version: 1, registry, notice: app.notice, document: app.document,
    setEditorText: app.setEditorText, requestRender: app.requestRender })

  // Model metadata is cached by route; a switch invalidates the old capacity.
  void footerInfo.warmUp()

  // 欢迎页是**流内容**（view.rows 的第一行），不是活表头。
  //
  // 为什么必须这样：pi-tui 只在内容**增长**时走 append 路径（发真实换行 →
  // 终端滚动 → 顶部的行进 scrollback，永久保留）；组件被原地改写/移除时走的是
  // `\x1b[2K` 擦行重写，那一屏内容不进历史。早期把欢迎页放在 header 槽、有对话
  // 就折叠成两行，实测（tmux 历史缓冲）鲸鱼从 1 行变 0 行——被原地擦掉，往上滚
  // 找不到。现在它作为一行普通对话内容，随对话增长自然滚入 scrollback。
  //
  // 只在**全新的空会话**里插入：--resume 进来的会话有历史，不该再出现欢迎页；
  // 会中 /resume 会整体换掉 view（Object.assign），这一行也随之消失。
  const disposeWelcomeRendererRegistration = registry.setMessageRenderer('welcome', ({ row, theme }) => ({
    invalidate() {},
    render(width) {
      return renderWelcomeBox({
        width,
        theme,
        subtitle: row.subtitle ?? '',
        workspace: row.workspace ?? '',
        preset: row.preset ?? '',
      })
    },
  }))
  disposeWelcomeRenderer = disposeWelcomeRendererRegistration
  if (startup.resume === undefined && view.rows.length === 0) {
    let cwd = process.cwd()
    try {
      cwd = kernel.agent.session.header?.cwd ?? cwd
    } catch {
      // 会话头还没就绪就用进程 cwd；欢迎页是快照，不重试。
    }
    view.rows.push(welcomeRow({ version: pkg.version, model: modelLabel, cwd, preset: presetLabel }))

    // 开机信息块（pi 式分节）：[Context] / [Skills] / [Commands] / [Plugins] /
    // [Theme]，写进对话区随对话滚入 scrollback——告诉你「这次加载了什么」。
    // 这套渲染一直存在（startup-info.js）却从没接上，所以用户看不到。
    try {
      const sections = await collectStartupSections({
        ctx,
        listCommands: () => commandSystem.listAll(),
        theme,
        cwd,
        version: pkg.version,
      })
      if (Array.isArray(sections) && sections.length > 0) {
        view.rows.push({ key: 'startup-info', role: 'info', sections, done: true })
      }
    } catch {
      // 采集失败就整块不出现——开机信息不该阻止启动。
    }
    view.revision += 1
  }

  try {
    logTerminalState('before-start')
    app.start()
    logTerminalState('after-start')
  } catch (error) {
    await teardown({ flush: true })
    throw new Error(`dsh-tui: failed to start the terminal UI — ${error?.message ?? error}`)
  }

  // 独立于 TUI 的 stdin 旁观器，只在 DSH_TUI_LOG_KEYS 开启时生效。
  const untapStdin = tapStdin()

  // 杂散输出防护：pi-tui 不拦截 console，任何插件在会话期间 console.log 都会
  // 直接写进终端把画面搅乱。只接管 console.*，不碰 process.stdout.write
  // （那是 pi-tui 的渲染通道）。见 src/console-guard.js。
  const restoreConsoleGuard = installConsoleGuard({
    logPath: path.join(path.dirname(prefs.file), 'stray-console.log'),
    onFirst: (message) => app?.notice?.(message),
  })
  restoreConsole = restoreConsoleGuard

  // 人机回环：不装这两个 waterfall，任何需要授权的工具都会 fail-closed，
  // 模型提问也会直接失败——那样这个 TUI 就只是个聊天框。
  try {
    uninstallInteractive = installInteractive({ ctx, app, isAvailable: () => !exiting,
      ownsAgent: (agent) => kernel.ownsAgent(agent),
      approvalDetail: (request) => {
        const row = view.tools.get(request.callId)
        return [request.reason, row?.args].filter(Boolean).join('\n\n')
      },
    })
  } catch (error) {
    await teardown({ flush: true })
    throw new Error(`dsh-tui: failed to install the interactive loops — ${error?.message ?? error}`)
  }

  if (typeof startup.prompt === 'string' && startup.prompt.trim() !== '') {
    kernel.submit(startup.prompt)
  }

  // 启动信息块：照 pi 的做法，开机把「我加载了什么」写进对话区，随对话自然
  // 滚进终端 scrollback。异步收集，失败就整块不出现——绝不阻塞启动。
  // Capability inventories are available on demand in /context, /tools and /doctor.

  // ── 生命周期 ──────────────────────────────────────────────────────────
  //
  // 插件卸载 / profile 重组时必须还原终端（alt-screen、raw mode、光标），
  // 并且**先把会话刷进存储**——否则最后一段对话会丢。

  // 信号兜底：关掉终端窗口（SIGHUP）、raw mode 之外的 SIGINT、SIGTERM 都会
  // 绕过正常退出路径直接杀死进程，留下一个坏掉的终端。
  const onSignal = () => {
    void shutdown(130)
  }
  const signals = ['SIGHUP', 'SIGINT', 'SIGTERM']
  for (const signal of signals) process.on(signal, onSignal)

  // 进程真要退时至少把终端还原。这里不能 await，只能同步尽力而为。
  const onProcessExit = () => {
    try {
      app?.dispose()
    } catch {
      // 尽力而为。
    }
  }
  process.on('exit', onProcessExit)

  ctx.effect(() => () => {
    for (const signal of signals) process.off(signal, onSignal)
    process.off('exit', onProcessExit)
    untapStdin()
    if (!exiting) {
      exiting = true
      void teardown({ flush: true })
    }
  })

  ctx.get('logger')?.info?.(`dsh-tui: mounted session ${kernel.sessionId} (${modelLabel || 'default model'})`)
}

/**
 * 会话 id 的短标签。
 *
 * dsh 的会话 id 形如 `session-<uuid>`，所以**不能**直接 `slice(0, 8)`——
 * 那只会切出 `session-` 这个前缀，uuid 一位都不显示（这是实机上踩到的）。
 */
export function shortSessionId(id) {
  const raw = String(id ?? '')
  const stripped = raw.replace(/^session-/, '')
  return (stripped === '' ? raw : stripped).slice(0, 8)
}

/**
 * 供测试与嵌入方使用：把一串事件折叠成视图，走的是与实时完全相同的路径。
 * @param {Iterable<object>} events
 */
export function foldEvents(events) {
  const view = createView()
  for (const event of events) applySessionEvent(view, event)
  return view
}
