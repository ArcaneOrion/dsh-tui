#!/usr/bin/env node
/**
 * 独立启动器。
 *
 * 本 TUI 是 dsh 的一个「表面」，不是独立应用——profile 组合、加载器启动、
 * 生命周期全部归 dsh launcher。所以这里**不自己 boot**，只把控制权转交过去。
 *
 * 之所以不自己组合 loader：那会引入"启动器与 profile 版本错位"这一整类问题
 * （你之前遇到的插件 peer 版本不匹配就是这类）。让 dsh 去启动，永远用最新
 * 的那份逻辑。
 */

import { spawn } from 'node:child_process'

const PROFILE = process.env.DSH_TUI_PROFILE ?? 'tui'

const child = spawn('dsh', ['tui', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, DSH_TUI_PROFILE: PROFILE },
})

child.on('error', (error) => {
  if (error?.code === 'ENOENT') {
    process.stderr.write('dsh-tui: 找不到 `dsh` 命令。本 TUI 需要 dsh launcher 在 PATH 上。\n')
    process.exit(127)
  }
  process.stderr.write(`dsh-tui: 启动失败 — ${error?.message ?? error}\n`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  // 忠实透传退出方式：信号就按同一信号终止自己，否则透传退出码。
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
