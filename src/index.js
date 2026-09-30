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

import { createApp } from './app.js'
import { createBanner } from './banner.js'
import { createCommandAutocomplete, createCommandSystem, helpText, parseCommandLine } from './commands.js'
import { createFooterInfo } from './footer.js'
import { HostMode, resolveHostMode } from './host.js'
import { installInteractive } from './interactive.js'
import { combineAutocomplete, createFileIndex, createMentionAutocomplete } from './mentions.js'
import { createPrefs } from './prefs.js'
import { collectStartupSections } from './startup-info.js'

const pkg = createRequire(import.meta.url)('../package.json')
import { createKernel } from './kernel.js'
import { installDefaultRenderers } from './messages.js'
import { applySessionEvent, createView } from './projection.js'
import { createRegistry } from './registry.js'
import { createTheme } from './theme.js'

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
  const appliedSavedModel = startup.model === undefined && typeof saved.model === 'string' && saved.model.includes('/')
  const effectiveStartup = appliedSavedModel ? { ...startup, model: saved.model } : startup

  const theme = createTheme()
  const registry = createRegistry()
  const view = createView()
  const disposeDefaultRenderers = installDefaultRenderers(registry)

  /** @type {ReturnType<typeof createApp> | undefined} */
  let app

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

  const modelLabel =
    kernel.selection === undefined ? '' : [kernel.selection.provider, kernel.selection.model].filter(Boolean).join('/')

  // 底栏的数据源。它负责所有取数（token 计量、沙箱模式、git 分支、模型窗口），
  // 组件本身只做纯渲染。任何一个服务缺失都会让对应那一段消失，而不是显示假数据。
  const footerInfo = createFooterInfo({
    ctx,
    getAgent: () => kernel.agent,
    getSelection: () => kernel.selection,
  })

  // 斜杠命令：本地命令自己处理，其余交给内核的注册表。
  const commandSystem = createCommandSystem({ ctx, getAgent: () => kernel.agent })

  // 补全：命令走 `/`，文件引用走 `@`。
  const mentionAutocomplete = createMentionAutocomplete({ listFiles: createFileIndex(process.cwd()) })

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
      `  approval     ${mark('approval')}   ← 授权弹窗`,
      `  userQuestions ${mark('userQuestions')}   ← 提问弹窗`,
      `  偏好文件     ${prefs.file}`,
    ].join('\n')
  }

  /** 执行一行斜杠命令。 */
  async function runCommand(line) {
    const parsed = parseCommandLine(line)
    if (parsed === undefined) return

    if (commandSystem.isLocal(parsed.name)) {
      if (parsed.name === 'exit' || parsed.name === 'quit') {
        void shutdown(0)
        return
      }
      if (parsed.name === 'help') {
        app?.notice?.(helpText(commandSystem.listAll()))
        return
      }
      if (parsed.name === 'doctor') {
        app?.notice?.(doctorReport())
        return
      }
      if (parsed.name === 'model') {
        if (parsed.rest === '') {
          const current =
            kernel.selection === undefined ? '(内核默认)' : `${kernel.selection.provider}/${kernel.selection.model}`
          app?.notice?.(
            `当前模型：${current}\n记忆的默认：${prefs.read().model ?? '(无)'}\n用法：/model provider/model`,
          )
          return
        }
        if (!parsed.rest.includes('/')) {
          app?.notice?.('/model 需要 provider/model 形式，例如 /model deepseek-official/deepseek-flash')
          return
        }
        const result = prefs.write({ model: parsed.rest })
        app?.notice?.(
          result.ok
            ? `已记住默认模型：${result.value.model}\n本次会话仍是 ${modelLabel === '' ? '内核默认' : modelLabel}（切换模型需要重开会话）`
            : `无法写入偏好文件（${prefs.file}）——本次设置**没有保存**`,
        )
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
      onSubmit: (text) => {
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
      getState: () => ({
        turnActive: view.turnActive === true,
        statusText: view.turnActive === true ? 'working' : undefined,
      }),
    })
  } catch (error) {
    await teardown({ flush: true })
    throw new Error(`dsh-tui: failed to mount the terminal UI — ${error?.message ?? error}`)
  }

  // 模型上下文窗口只能异步解析，预热一次即可；失败就永远不显示上限那半截。
  void footerInfo.warmUp()

  // 顶部 banner 走注册表（可被 setHeader 整体换掉），配色取自本 TUI 的主题。
  registry.setHeader(
    createBanner({
      theme,
      getSubtitle: () => `dsh-tui ${pkg.version} · ${modelLabel === '' ? 'default model' : modelLabel}`,
    }),
  )

  try {
    app.start()
  } catch (error) {
    await teardown({ flush: true })
    throw new Error(`dsh-tui: failed to start the terminal UI — ${error?.message ?? error}`)
  }

  // 人机回环：不装这两个 waterfall，任何需要授权的工具都会 fail-closed，
  // 模型提问也会直接失败——那样这个 TUI 就只是个聊天框。
  try {
    uninstallInteractive = installInteractive({ ctx, app, isAvailable: () => !exiting })
  } catch (error) {
    await teardown({ flush: true })
    throw new Error(`dsh-tui: failed to install the interactive loops — ${error?.message ?? error}`)
  }

  if (typeof startup.prompt === 'string' && startup.prompt.trim() !== '') {
    kernel.submit(startup.prompt)
  }

  // 启动信息块：照 pi 的做法，开机把「我加载了什么」写进对话区，随对话自然
  // 滚进终端 scrollback。异步收集，失败就整块不出现——绝不阻塞启动。
  void collectStartupSections({
    ctx,
    listCommands: () => commandSystem.listAll(),
    theme,
    version: pkg.version,
  })
    .then((sections) => {
      if (sections.length > 0) app?.pushRow?.({ role: 'info', sections })
    })
    .catch(() => {
      // 信息块只是开机问候，收集失败不该影响任何东西。
    })

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
