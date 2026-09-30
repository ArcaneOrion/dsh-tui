/**
 * 启动身份判定。
 *
 * 为什么必须有这一层：本 bundle 可能被装进任何 profile。宿主的 stdout 是
 * pipe（Web / GUI / 被别的进程采样）时，如果还硬挂一个终端 TUI，会污染
 * 宿主的输出、抢走 stdin、并把整个组合拖垮。
 *
 * 所以插件必须先回答「我该不该活」。判定结果只有两种：
 *
 * - `interactive`  两端都是 TTY（或被显式强制），正常挂载前端。
 * - `not-a-tty`   任何一端不是 TTY，静默降级：不碰终端，不占 stdin。
 *
 * 注意这里**不抛异常**。dsh 的 profile 组合是一个整体，一个前门插件因为
 * 环境不合适而抛错，会让整棵树的其它行也起不来。降级才是正确行为；真要
 * 「显式启动但没终端就大声失败」，那是独立的 `dsh-tui` 启动器该做的事。
 */

/** 判定结果常量。 */
export const HostMode = Object.freeze({
  INTERACTIVE: 'interactive',
  NOT_A_TTY: 'not-a-tty',
})

/**
 * 判定当前进程能不能承载一个交互式终端前端。
 *
 * @param {object} [io]
 * @param {boolean} [io.stdoutIsTTY] - 默认 `process.stdout.isTTY`
 * @param {boolean} [io.stdinIsTTY]  - 默认 `process.stdin.isTTY`
 * @param {NodeJS.ProcessEnv} [io.env] - 默认 `process.env`
 * @returns {{ mode: string, reason: string }}
 */
export function resolveHostMode(io = {}) {
  const stdoutIsTTY = io.stdoutIsTTY ?? process.stdout.isTTY
  const stdinIsTTY = io.stdinIsTTY ?? process.stdin.isTTY
  const env = io.env ?? process.env

  // 逃生口：明确的调试/测试场景可以强制挂载（例如在 pty 里跑）。
  if (env.DSH_TUI_FORCE_TTY === '1') {
    return { mode: HostMode.INTERACTIVE, reason: 'forced by DSH_TUI_FORCE_TTY' }
  }

  if (stdoutIsTTY !== true && stdinIsTTY !== true) {
    return { mode: HostMode.NOT_A_TTY, reason: 'neither stdout nor stdin is a TTY' }
  }
  if (stdoutIsTTY !== true) {
    return { mode: HostMode.NOT_A_TTY, reason: 'stdout is not a TTY' }
  }
  if (stdinIsTTY !== true) {
    return { mode: HostMode.NOT_A_TTY, reason: 'stdin is not a TTY' }
  }

  return { mode: HostMode.INTERACTIVE, reason: 'stdout and stdin are TTYs' }
}
