/**
 * 杂散输出的防护。
 *
 * 问题：**pi-tui 不拦截 `console` / `stdout`**（实测确认）。任何插件在 TUI 拥有
 * 屏幕时 `console.log`，那一行就会直接写进终端，把画面搅乱。实测在
 * `model-channel-manager` 上就撞到了：它在 boot 时打了
 * `[model-channel-manager] booted, groups: ...`。
 *
 * 做法：**只接管 `console.*`，绝不碰 `process.stdout.write`**——后者是 pi-tui
 * 渲染用的通道，接管了就等于把渲染搞坏。日志正文交给 TUI 作为普通消息
 * 显示，同时保留文件记录。用户直接看到内容，不再看到重定向机制的通知。
 *
 * 忠于原样：日志文件里保留原始参数、级别与时间，方便排查插件问题。
 */

import fs from 'node:fs'
import path from 'node:path'
import { formatWithOptions, stripVTControlCharacters } from 'node:util'

/** 接管的 console 方法。 */
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace']

/**
 * 安装 console 防护。
 *
 * @param {object} options
 * @param {string} options.logPath - 杂散输出落到哪里
 * @param {(record:{level:string,text:string})=>void} [options.onRecord] - 交给 TUI 显示日志正文
 * @returns {() => void} 还原（必须挂进 ctx.effect）
 */
export function installConsoleGuard({ logPath, onRecord }) {
  const original = {}
  for (const method of METHODS) original[method] = console[method]

  let delivering = false

  const record = (method, args) => {
    let text
    try {
      // 保留 console 的占位符、对象和 Error 堆栈语义；不把终端控制序列交给布局器。
      text = stripVTControlCharacters(formatWithOptions({ colors: false }, ...args)).replace(/\r\n?/g, '\n')
    } catch {
      text = args.map(safeInspect).join(' ')
    }
    try {
      const line = `${new Date().toISOString()} [${method}] ${text}\n`
      fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 })
      fs.appendFileSync(logPath, line, { mode: 0o600 })
    } catch {
      // 记不下来也不能让被接管的 console 抛错——那会让调用方炸在莫名其妙的地方。
    }

    if (!delivering) {
      delivering = true
      try {
        onRecord?.({ level: method, text })
      } catch {
        // 显示失败仍保留文件记录，也不能影响产生日志的插件。
      } finally { delivering = false }
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
