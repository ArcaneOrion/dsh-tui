/**
 * 按键诊断日志。
 *
 * 只在 `DSH_TUI_LOG_KEYS=<路径>` 时启用；平时是零开销的空实现。
 *
 * 为什么要两个通道：症状是「能打字但回车没反应」，而可能的原因分两类——
 * 一是字节不对（Enter 发的是 LF 而不是 CR），二是**输入压根没进到应用**
 * （raw mode 没开、stdin 没被读）。这两种在界面上长得一模一样。
 *
 * 所以：
 *   `stdin` 行 = 独立挂在 process.stdin 上的监听器看到的字节
 *   `tui`   行 = pi-tui 分派到输入监听器的字节
 *   `init`  行 = 启动时的 isTTY / isRaw 快照
 *
 * 两个通道的对照能直接分辨：stdin 有而 tui 没有 → 输入到了进程但没到 TUI
 * （焦点/分派问题）；两边都空 → 输入压根没到进程（raw mode 没开）。
 */

import fs from 'node:fs'

/** 日志路径；未设置时为 undefined。 */
export const KEY_LOG_PATH = process.env.DSH_TUI_LOG_KEYS

/** 当前是哪个通道在记。 */
let seq = 0

/**
 * 记一笔。
 * @param {string} source - `stdin` / `tui` / `init`
 * @param {unknown} data
 */
export function logKey(source, data) {
  if (typeof KEY_LOG_PATH !== 'string' || KEY_LOG_PATH === '') return
  try {
    seq += 1
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    const hex =
      typeof data === 'string'
        ? [...data].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
        : ''
    fs.appendFileSync(
      KEY_LOG_PATH,
      `${String(seq).padStart(4, '0')}  ${source.padEnd(5)}  ${JSON.stringify(text)}  ${hex}\n`,
    )
  } catch {
    // 记不上日志绝不能影响按键本身。
  }
}

/**
 * 在 process.stdin 上独立挂一层监听。
 *
 * 与 pi-tui 自己的监听并存（EventEmitter 允许多个 data 监听器），
 * 不消费、不改写，纯粹旁观。
 *
 * @returns {() => void} 卸载
 */
export function tapStdin(stdin = process.stdin) {
  if (typeof KEY_LOG_PATH !== 'string' || KEY_LOG_PATH === '') return () => {}
  const handler = (chunk) => logKey('stdin', String(chunk))
  try {
    stdin.on('data', handler)
  } catch {
    return () => {}
  }
  return () => {
    try {
      stdin.off('data', handler)
    } catch {
      // 已经关掉了。
    }
  }
}

/** 记一份终端状态快照（是否 TTY、是否已进 raw mode）。 */
export function logTerminalState(label, stdin = process.stdin) {
  logKey('init', `${label} isTTY=${String(stdin.isTTY)} isRaw=${String(stdin.isRaw)}`)
}
