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
    // 静默降级：这个 profile 里装了本前端，但当前进程不是终端宿主
    // （Web / GUI / 被管道采样）。碰 stdout 会把宿主搞坏，所以什么都不做。
    ctx.get('logger')?.debug?.(`dsh-tui: not mounting (${mode.reason})`)
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

  let kernel
  try {
    kernel = await createKernel({
      ctx,
      view,
      startup,
      onUpdate: () => app?.requestRender(),
    })
  } catch (error) {
    disposeDefaultRenderers()
    throw new Error(`dsh-tui: failed to start the agent session — ${error?.message ?? error}`)
  }

  // ── 界面 ──────────────────────────────────────────────────────────────

  let exiting = false

  async function shutdown(code = 0) {
    if (exiting) return
    exiting = true
    try {
      // 顺序很重要：先把会话刷进存储，再拆界面，最后销毁 agent。
      // 反过来会丢掉最后一段对话。
      await kernel.flush()
    } catch {
      // 已在上层吞掉细节；这里只保证继续往下走。
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

    const exit = ctx.get('appExit')
    if (typeof exit === 'function') exit(code)
    else process.exit(code)
  }

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
    getInfo: () => ({
      model: [kernel.selection.provider, kernel.selection.model].filter(Boolean).join('/') || undefined,
      session: kernel.sessionId.slice(0, 8),
      mode: 'dsh-tui',
    }),
    getState: () => ({
      turnActive: view.turnActive === true,
      statusText: view.turnActive === true ? 'working' : undefined,
    }),
  })

  // ── 启动后：状态栏 + 初始提示词 ────────────────────────────────────────

  const modelLabel = [kernel.selection.provider, kernel.selection.model].filter(Boolean).join('/')
  registry.setStatus('session', theme.fg('dim', kernel.sessionId.slice(0, 8)))
  if (modelLabel !== '') registry.setStatus('model', theme.fg('accent', modelLabel))

  app.start()

  if (typeof startup.prompt === 'string' && startup.prompt.trim() !== '') {
    kernel.submit(startup.prompt)
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────
  //
  // 插件卸载 / profile 重组时必须还原终端（alt-screen、raw mode、光标）。
  // 否则用户会拿到一个坏掉的终端，得手动敲 reset。
  ctx.effect(() => () => {
    if (exiting) return
    try {
      app?.dispose()
    } catch {
      // 忽略
    }
    void kernel.dispose()
    disposeDefaultRenderers()
  })

  ctx.get('logger')?.info?.(`dsh-tui: mounted session ${kernel.sessionId} (${modelLabel || 'default model'})`)
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
