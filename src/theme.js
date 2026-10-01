/**
 * 主题层。
 *
 * 设计要点：
 * 1. 颜色以 **token 表** 为中心（不是散落在组件里的字面量）。上层组件只问
 *    「accent 是什么颜色」，不问「RGB 是多少」。
 * 2. pi-tui 的各组件各自要一种 theme 形状（MarkdownTheme / EditorTheme /
 *    SelectListTheme），本模块把这三种形状**从同一张 token 表派生**出来，
 *    所以换主题只要换一张表。
 * 3. 主题是**数据**不是代码：token 表可以整体替换（未来的 theme JSON）。
 *
 * 为什么不用 pi-coding-agent 的 51-token 体系：那是 pi 应用层的约定，pi-tui
 * 本身不认识 token 名。我们先定义自己的一组，覆盖 pi-tui 实际会用到的地方。
 */

import { createHighlighter } from './highlight.js'

// ── ANSI 生成 ────────────────────────────────────────────────────────────

const RESET = '\x1b[0m'

/** 解析 #rgb / #rrggbb → [r,g,b]；失败返回 null */
function parseHex(hex) {
  if (typeof hex !== 'string') return null
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (m === null) return null
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** RGB → xterm 256 色索引（16-231 的 6×6×6 立方 + 232-255 灰阶） */
function rgbTo256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  const q = (v) => Math.round((v / 255) * 5)
  return 16 + 36 * q(r) + 6 * q(g) + q(b)
}

/**
 * 终端是否支持 24 位色。COLORTERM 是事实标准；不认就退到 256 色。
 * 可用 DSH_TUI_COLOR=truecolor|256 强制。
 */
function detectColorDepth(env = process.env) {
  const forced = env.DSH_TUI_COLOR
  if (forced === 'truecolor' || forced === '256') return forced
  const ct = String(env.COLORTERM ?? '').toLowerCase()
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor'
  // Windows Terminal / VS Code 等常常不设 COLORTERM，但支持真彩
  if (env.WT_SESSION !== undefined || env.TERM_PROGRAM === 'vscode') return 'truecolor'
  return '256'
}

/** 造一个「颜色值 → SGR 前缀」的解析器 */
function makeSgr(depth) {
  return function sgr(color, isBg) {
    const base = isBg ? 48 : 38
    const rgb = parseHex(color)
    if (rgb === null) return ''
    if (depth === 'truecolor') return `\x1b[${base};2;${rgb[0]};${rgb[1]};${rgb[2]}m`
    return `\x1b[${base};5;${rgbTo256(rgb)}m`
  }
}

// ── token 表 ─────────────────────────────────────────────────────────────
//
// 色板是数据：每张表是一套主题。createTheme 返回的对象把 tokens 做成
// 可热替换的活引用（setTokens），所以 /theme 切换时所有持有 theme 的组件
// 自动跟随，只需清各自缓存——不用重建组件、不用改签名。

/**
 * 蓝色主题（默认）。Tokyo Night 风味：深蓝底 + 蓝 accent + 低饱和态色。
 * 文字用空串 = 跟随终端默认前景，浅色终端也不瞎。
 */
export const BLUE_TOKENS = Object.freeze({
  // 基础文字
  text: '',
  muted: '#8b9bb4',
  dim: '#5c6b85',

  // 强调 / 边框
  accent: '#7aa2f7',
  border: '#2a3a52',
  borderAccent: '#7aa2f7',
  borderMuted: '#1e2a3a',

  // 状态
  success: '#9ece6a',
  error: '#f7768e',
  warning: '#e0af68',

  // 角色：用户消息纯底色块、思考斜体（与 pi 同一分层语言，配色不同）
  userMessageBg: '#1e2a3a',
  userMessageText: '#c0caf5',
  userBorder: '#7aa2f7',
  assistantBorder: '#2a3a52',
  thinkingText: '#8b9bb4',

  // 工具：三态底色块
  toolTitle: '#7dcfff',
  toolOutput: '#a9b1d6',
  toolPendingBg: '#1a2333',
  toolSuccessBg: '#16261f',
  toolErrorBg: '#2b1a22',

  // diff
  diffAdded: '#9ece6a',
  diffRemoved: '#f7768e',
  diffContext: '#5c6b85',

  // 选择 / 背景
  selectedBg: '#283457',
  panelBg: '#131721',
  panelBorder: '#2a3a52',
  paneBg: '#131721',
  paneBorder: '#2a3a52',

  // 底栏
  footerBorder: '#2a3a52',
  dirLabel: '#7dcfff',
  branchLabel: '#8b9bb4',
  thinkLabel: '#e0af68',

  // 输入框
  editorBorder: '#6b9bd8',
  editorBorderActive: '#7aa2f7',
  welcomeBorder: '#7aa2f7',

  // markdown 语义 token（每主题自定义，映射不写死色相）
  link: '#7aa2f7',
  bullet: '#7aa2f7',
  codeFg: '',
  codeBorder: '#2a3a52',

  // 语法高亮数字
  codeNumber: '#ff9e64',

  // 底栏色块（Claude Code 状态行样式：饱和底色 + 浅色文字，段间无分隔）
  segText: '#eaf2fb',
  segBlue: '#2f6fbf',
  segTeal: '#1f7f8f',
  segGreen: '#2f9e4f',
  segAmber: '#9a6a1f',
  segRed: '#a83a45',
  segSlate: '#44566e',
  segGray: '#5a6672',
})

/**
 * pi 主题。色板逐值取自用户在 pi 里调的 ~/.pi/agent/themes/pi-theme.json
 * （墨蓝底 + 暖黄 accent + cyan/cream）。
 */
export const PI_TOKENS = Object.freeze({
  // 基础文字
  text: '#fff8d6',
  muted: '#c9deea',
  dim: '#7a96aa',

  // 强调 / 边框
  accent: '#ffd43b',
  border: '#3a5d78',
  borderAccent: '#35d8ff',
  borderMuted: '#2e4c66',

  // 状态
  success: '#35d8ff',
  error: '#ff4d2e',
  warning: '#ffb454',

  // 角色
  userMessageBg: '#2e4c66',
  userMessageText: '#fff8d6',
  userBorder: '#3a5d78',
  assistantBorder: '#3a5d78',
  thinkingText: '#c9deea',

  // 工具
  toolTitle: '#ffd43b',
  toolOutput: '#c9deea',
  toolPendingBg: '#274159',
  toolSuccessBg: '#1e3e4a',
  toolErrorBg: '#3c2828',

  // diff
  diffAdded: '#35d8ff',
  diffRemoved: '#ff4d2e',
  diffContext: '#7a96aa',

  // 选择 / 背景
  selectedBg: '#3a5d78',
  panelBg: '#1a3045',
  panelBorder: '#3a5d78',
  paneBg: '#1a3045',
  paneBorder: '#3a5d78',

  // 底栏
  footerBorder: '#3a5d78',
  dirLabel: '#35d8ff',
  branchLabel: '#c9deea',
  thinkLabel: '#ffb454',

  // 输入框
  editorBorder: '#6b9bd8',
  editorBorderActive: '#35d8ff',
  welcomeBorder: '#ffb454',

  // markdown 语义 token
  link: '#35d8ff',
  bullet: '#35d8ff',
  codeFg: '#fff8d6',
  codeBorder: '#ffb454',

  // 语法高亮数字
  codeNumber: '#ffec80',

  // 底栏色块（同上：饱和底色 + 浅色文字）
  segText: '#fff8d6',
  segBlue: '#2f6f9f',
  segTeal: '#2a7a7a',
  segGreen: '#2f8f6f',
  segAmber: '#9a7a2f',
  segRed: '#a04a4a',
  segSlate: '#44566e',
  segGray: '#5a6a7a',
})

/**
 * 可选主题注册表。新增主题 = 加一张 token 表 + 在此登记。
 * `id` 是 /theme 命令与 prefs 持久化用的稳定标识符。
 */
export const THEMES = Object.freeze({
  blue: { tokens: BLUE_TOKENS, name: '蓝', description: '深蓝底 + 蓝 accent（默认）' },
  pi: { tokens: PI_TOKENS, name: 'pi', description: '墨蓝底 + 暖黄（你的 pi-theme）' },
})

/** 默认主题 id。 */
export const DEFAULT_THEME_ID = 'blue'

/** 向后兼容：DARK_TOKENS 指向默认主题。 */
export const DARK_TOKENS = BLUE_TOKENS

/** 列出可选主题（/theme 命令与启动恢复用）。 */
export function listThemes() {
  return Object.entries(THEMES).map(([id, t]) => ({ id, name: t.name, description: t.description }))
}

/** 按 id 取 token 表；未知 id 退回默认主题。 */
export function tokensForTheme(id) {
  return (THEMES[id] ?? THEMES[DEFAULT_THEME_ID]).tokens
}

// ── 主题对象 ─────────────────────────────────────────────────────────────

/**
 * 由 token 表构造一个主题。
 *
 * 返回的对象带：
 * - `fg(token, text)` / `bg(token, text)`  —— 通用取色
 * - `bold/italic/underline/strikethrough` —— 文本修饰
 * - `markdown` / `editor` / `selectList`  —— pi-tui 组件直接可用的三套形状
 *
 * **热切**：tokens 是活引用——`setTokens(newTokens)` 替换后，所有调 `fg/bg`
 * 的地方（包括 markdown/editor/selectList 的函数）下一次调用自动用新表。
 * 持有 theme 引用的组件无需改签名，只需清各自缓存（缓存键不含 tokens 版本）。
 * 这是 /theme 运行时切换的基础。
 */
export function createTheme(tokens = DARK_TOKENS, env = process.env) {
  const depth = detectColorDepth(env)
  const sgr = makeSgr(depth)
  // 可热替换的当前 token 表。fg/bg 每次调用都读它，不闭包常量。
  let current = tokens

  /** 取一个 token 的颜色，包住文本并复位 */
  function fg(token, text) {
    const color = current[token]
    if (color === undefined) return String(text)
    const prefix = sgr(color, false)
    return prefix === '' ? String(text) : prefix + text + RESET
  }

  function bg(token, text) {
    const color = current[token]
    if (color === undefined) return String(text)
    const prefix = sgr(color, true)
    return prefix === '' ? String(text) : prefix + String(text).replaceAll(RESET, RESET + prefix) + RESET
  }

  const bold = (s) => `\x1b[1m${s}\x1b[22m`
  const italic = (s) => `\x1b[3m${s}\x1b[23m`
  const underline = (s) => `\x1b[4m${s}\x1b[24m`
  const strikethrough = (s) => `\x1b[9m${s}\x1b[29m`

  const selectList = {
    selectedPrefix: (t) => fg('accent', t),
    selectedText: (t) => fg('accent', t),
    description: (t) => fg('muted', t),
    scrollInfo: (t) => fg('dim', t),
    noMatch: (t) => fg('warning', t),
  }

  const markdown = {
    // 用语义 token（link/bullet/codeFg/codeBorder），每套主题各自给值，
    // 映射不写死色相——蓝主题的链接是蓝，pi 主题的链接是 cyan。
    heading: (t) => bold(fg('accent', t)),
    link: (t) => fg('link', underline(t)),
    linkUrl: (t) => fg('dim', t),
    code: (t) => fg('warning', t),
    codeBlock: (t) => fg('codeFg', t),
    codeBlockBorder: (t) => fg('codeBorder', t),
    quote: (t) => fg('muted', italic(t)),
    quoteBorder: (t) => fg('border', t),
    hr: (t) => fg('border', t),
    listBullet: (t) => fg('bullet', t),
    bold: (t) => bold(t),
    italic: (t) => italic(t),
    strikethrough: (t) => strikethrough(t),
    underline: (t) => underline(t),
    // 语法高亮：只认有把握的语言（注释/字符串/数字/关键字），其余返回
    // undefined，pi-tui 会退回 codeBlock 的纯色渲染。
    highlightCode: createHighlighter({
      code: (t) => fg('codeFg', t),
      comment: (t) => fg('dim', t),
      string: (t) => fg('warning', t),
      number: (t) => fg('codeNumber', t),
      keyword: (t) => fg('accent', t),
    }),
  }

  const editor = {
    borderColor: (t) => fg('editorBorder', t),
    selectList,
  }

  return {
    depth,
    /** 当前生效的 token 表（热切后同步更新）。 */
    get tokens() { return current },
    /** 热切换 token 表；调用方负责清各组件缓存。 */
    setTokens(next) { if (next && typeof next === 'object') current = next },
    fg,
    bg,
    bold,
    italic,
    underline,
    strikethrough,
    markdown,
    editor,
    selectList,
  }
}

/** 便捷：默认深色主题单例 */
export const defaultTheme = createTheme()
