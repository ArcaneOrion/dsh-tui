/**
 * 回车兼容。
 *
 * 背景（实测确认，不是推测）：pi-tui 的 `Editor` 只认 **CR (`\r`)** 作为提交，
 * 裸 **LF (`\n`)** 被它当成「换行」——因为 `Ctrl+J` 在终端里发出的就是 LF，
 * 与 Enter 是同一个字节，pi-tui 用 CR/LF 来区分「提交」与「插入换行」。
 *
 * ```
 * 输入"1"后按 CR(\r) → onSubmit 触发
 * 输入"1"后按 LF(\n) → 不触发（被当成换行）
 * ```
 *
 * 有些终端把 Enter 发成 LF。那种终端下**永远提交不了**，而且表现得完全不像
 * 出错：按键正常、字符正常显示、回车只是悄悄换了一行——界面上几乎看不出来。
 *
 * 这里做**自动判定**，两种终端都能用：
 *
 *   - 见过 CR  → 这个终端的 Enter 走 CR，LF 保留 `Ctrl+J` 换行的原义，不动它
 *   - 没见过 CR → 把裸 LF 翻译成 CR，让回车能用
 *
 * 可用 `DSH_TUI_LF_SUBMITS=0` 关掉（严格保留 pi-tui 原行为），
 * `=1` 强制开启。
 */

/** 回车字节。 */
const CR = '\r'
/** 换行字节。 */
const LF = '\n'

/**
 * 造一个输入翻译器。
 *
 * @param {{force?: boolean}} [options] - force=true 强制 LF→CR；false 完全不干预
 * @returns {(data: string) => string} 翻译后的字节
 */
export function createEnterCompat({ force } = {}) {
  /** 这个终端是否已经用 CR 表示过提交。 */
  let sawCR = false

  return function translate(data) {
    if (typeof data !== 'string' || data.length !== 1) return data

    if (force === true) return data === LF ? CR : data
    if (force === false) return data

    if (data === CR) {
      sawCR = true
      return data
    }
    if (data === LF && sawCR === false) return CR
    return data
  }
}

/**
 * 从环境变量解析 force 设置。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean|undefined}
 */
export function enterCompatFromEnv(env = process.env) {
  const raw = env.DSH_TUI_LF_SUBMITS
  if (raw === undefined || raw === '') return undefined
  return raw !== '0'
}
