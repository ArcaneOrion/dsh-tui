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

import { createApp } from './app.js'
import { createFooterInfo } from './footer.js'
import { HostMode, resolveHostMode } from './host.js'
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
      startup,
      onUpdate: () => app?.requestRender(),
      onEvent,
    })
  } catch (error) {
    disposeDefaultRenderers()
    throw new Error(`dsh-tui: failed to start the agent session — ${error?.message ?? error}`)
  }

  // ── 界面 ──────────────────────────────────────────────────────────────

  let exiting = false

  /**
   * 退出清理，幂等。shutdown 与 ctx.effect 都走这里。
   * 顺序很重要：先把会话刷进存储，再拆界面，最后销毁 agent——反过来会丢最后一段对话。
   */
  async function teardown({ flush = true } = {}) {
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
    await teardown({ flush: true })
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

  // createApp 会构造真实的终端对象（ProcessTerminal / Editor），这一步可能抛。
  // 抛了就必须把已经建起来的 agent 与监听全部回收，否则每失败一次泄漏一个会话。
  try {
    app = createApp({
      view,
      theme,
      registry,
      onSubmit: (text) => {
        kernel.submit(text)
      },
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

  try {
    app.start()
  } catch (error) {
    await teardown({ flush: true })
    throw new Error(`dsh-tui: failed to start the terminal UI — ${error?.message ?? error}`)
  }

  if (typeof startup.prompt === 'string' && startup.prompt.trim() !== '') {
    kernel.submit(startup.prompt)
  }

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
