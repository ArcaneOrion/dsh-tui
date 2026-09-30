/**
 * 杂散输出的防护。
 *
 * 问题：**pi-tui 不拦截 `console` / `stdout`**（实测确认）。任何插件在 TUI 拥有
 * 屏幕时 `console.log`，那一行就会直接写进终端，把画面搅乱。实测在
 * `model-channel-manager` 上就撞到了：它在 boot 时打了
 * `[model-channel-manager] booted, groups: ...`。
 *
 * 做法：**只接管 `console.*`，绝不碰 `process.stdout.write`**——后者是 pi-tui
 * 渲染用的通道，接管了就等于把渲染搞坏。杂散内容写进文件（信息不丢），
 * 并在界面上提示一次「有东西往 stdout 打了日志，重定向到了哪里」。
 *
 * 忠于原样：日志文件里保留原始参数、级别与时间，方便排查插件问题。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 接管的 console 方法。 */
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace']

/**
 * 安装 console 防护。
 *
 * @param {object} options
 * @param {string} options.logPath - 杂散输出落到哪里
 * @param {(message:string)=>void} [options.onFirst] - 第一次拦截时提示一次
 * @returns {() => void} 还原（必须挂进 ctx.effect）
 */
export function installConsoleGuard({ logPath, onFirst }) {
  const original = {}
  for (const method of METHODS) original[method] = console[method]

  let notified = false
  let count = 0

  const record = (method, args) => {
    count += 1
    try {
      const line = `${new Date().toISOString()} [${method}] ${args
        .map((a) => (typeof a === 'string' ? a : safeInspect(a)))
        .join(' ')}\n`
      fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 })
      fs.appendFileSync(logPath, line, { mode: 0o600 })
    } catch {
      // 记不下来也不能让被接管的 console 抛错——那会让调用方炸在莫名其妙的地方。
    }

    if (!notified) {
      notified = true
      try {
        onFirst?.(
          `有插件往控制台打日志，已重定向到 ${logPath}（否则会搅乱画面）`,
        )
      } catch {
        // 提示失败无所谓。
      }
    }
  }

  for (const method of METHODS) {
    console[method] = (...args) => record(method, args)
  }

  return () => {
    for (const method of METHODS) console[method] = original[method]
  }
}

/** 把任意值转成一行可读文本；循环引用也不能抛。 */
function safeInspect(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}
