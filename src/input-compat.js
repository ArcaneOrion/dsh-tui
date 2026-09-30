/**
 * 回车兼容。
 *
 * 背景（PTY 实测确认，不是推测）：pi-tui 的 `Editor` 只认 **CR (`\r`)** 作为提交，
 * 裸 **LF (`\n`)** 被它当成「换行」——因为 `Ctrl+J` 在终端里发出的就是 LF，
 * 与 Enter 是同一个字节，pi-tui 用 CR/LF 来区分「提交」与「插入换行」。
 *
 * 实测（在 PTY 里逐个字节喂进去，看 `onSubmit` 是否触发）：
 *
 * ```
 * \r    → 提交 ✓
 * \n    → 不提交 ✗（被当成换行）
 * \r\n  → 提交 ✓（CR 生效）
 * ```
 *
 * 把 Enter 发成 LF 的终端在 pi-tui 下**永远提交不了**，而且完全不像出错：
 * 字符正常显示，回车只是悄悄换行。
 *
 * ── 为什么不再做「自动判定」 ─────────────────────────────────────────────
 *
 * 第一版尝试过：见过 CR 就认为该终端用 CR 提交，此后不再翻译 LF。**这是错的。**
 * 实测里 CR 先出现一次就把开关置真，后面真正的 LF 再也不翻译——等于没修。
 * 根因是 **LF 这个字节本身无法区分「回车」与 Ctrl+J**，靠历史去猜只会猜错。
 *
 * 所以现在默认就是**把裸 LF 当提交**：一个用不了的回车，比失去 Ctrl+J 换行
 * 严重得多。需要保留 Ctrl+J 换行的人可以设 `DSH_TUI_LF_SUBMITS=0`。
 * （Shift+Enter 换行不受影响，它发的是多字节序列。）
 */

/** 回车字节。 */
const CR = '\r'
/** 换行字节。 */
const LF = '\n'

/**
 * 造一个输入翻译器。
 *
 * @param {{force?: boolean}} [options] - `force: false` 关闭翻译（严格保留 pi-tui 原行为）
 * @returns {(data: string) => string} 翻译后的字节
 */
export function createEnterCompat({ force = true } = {}) {
  return function translate(data) {
    // 只处理单字节输入：多字节序列（方向键、Shift+Enter、括号粘贴）一概不碰。
    if (typeof data !== 'string' || data.length !== 1) return data
    if (force === false) return data
    return data === LF ? CR : data
  }
}

/**
 * 从环境变量解析设置。默认**开启**（LF 当提交）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function enterCompatFromEnv(env = process.env) {
  const raw = env.DSH_TUI_LF_SUBMITS
  if (raw === undefined || raw === '') return true
  return raw !== '0'
}
