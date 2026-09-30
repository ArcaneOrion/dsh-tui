/** Prepare a replacement kernel before releasing the current session. */
import { createView } from './projection.js'

export function createSessionSwitcher({ createKernel, ctx, view, getKernel, onCommit, onUpdate, onEvent, isExiting = () => false }) {
  let busy = false
  function ensureIdle(kernel) {
    if (kernel.agent?.status === 'running') throw new Error('当前回合仍在运行，请先按 Esc 中断后再恢复会话')
    if (kernel.runtime.queue().length) throw new Error('当前还有待处理输入，请先在 /queue 处理后再恢复会话')
    const agents = ctx.get('agents')?.list?.() ?? []
    if (agents.some((agent) => agent.status === 'running' && kernel.ownsAgent?.(agent))) throw new Error('当前子 Agent 仍在运行，请等待其结束后再恢复会话')
  }
  return {
    get busy() { return busy },
    async resume(id) {
      if (busy) throw new Error('正在切换会话')
      if (typeof id !== 'string' || !id.trim()) throw new Error('请输入完整的会话 ID')
      const previous = getKernel()
      if (id === previous.sessionId) return false
      ensureIdle(previous)
      busy = true
      let next
      let committed = false
      try {
        await previous.runtime.validateResume?.(id)
        const nextView = createView()
        next = await createKernel({ ctx, view: nextView, startup: { resume: id },
          onUpdate: () => { if (getKernel() === next) onUpdate?.() },
          onEvent: (event) => { if (getKernel() === next) onEvent?.(event) },
        })
        if (isExiting()) throw new Error('界面正在退出，已取消会话切换')
        ensureIdle(previous)
        await previous.flush({ strict: true })
        if (isExiting()) throw new Error('界面正在退出，已取消会话切换')
        nextView.turnActive = next.agent?.status === 'running'
        Object.assign(view, nextView)
        next.attachView(view)
        onCommit(next)
        committed = true
        await previous.dispose()
        return true
      } finally {
        if (next && !committed) await next.dispose()
        busy = false
      }
    },
  }
}
