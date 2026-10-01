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

// ── 默认 token 表（深色） ────────────────────────────────────────────────
//
// 色板逐值取自用户在 pi 里调的 ~/.pi/agent/themes/pi-theme.json（墨蓝底 +
// 暖黄 accent + cyan/cream），第三轮改版起 DSH-TUI 与 pi 同一套设计语言：
// 分层靠底色块，不靠文字角色标签。

export const DARK_TOKENS = Object.freeze({
  // 基础文字（pi: text=cream, muted, dim=mutedDim）
  text: '#fff8d6',
  muted: '#c9deea',
  dim: '#7a96aa',

  // 强调 / 边框（pi: accent=yellow, border=panel2, borderAccent=cyan, borderMuted=panel）
  accent: '#ffd43b',
  border: '#3a5d78',
  borderAccent: '#35d8ff',
  borderMuted: '#2e4c66',

  // 状态（pi: success=cyan, error=danger, warning=orange）
  success: '#35d8ff',
  error: '#ff4d2e',
  warning: '#ffb454',

  // 角色：只保留「层」的配色。用户消息是一整块 panel 底色（pi 的
  // UserMessageComponent 没有任何标签行）；思考是 muted 斜体。
  userMessageBg: '#2e4c66',
  userMessageText: '#fff8d6',
  userBorder: '#3a5d78',
  assistantBorder: '#3a5d78',
  thinkingText: '#c9deea',

  // 工具（pi ToolExecutionComponent：整块底色随状态变，无状态文字）
  toolTitle: '#ffd43b',
  toolOutput: '#c9deea',
  toolPendingBg: '#274159',
  toolSuccessBg: '#1e3e4a',
  toolErrorBg: '#3c2828',

  // diff（pi: toolDiffAdded=cyan, toolDiffRemoved=danger, toolDiffContext=mutedDim）
  diffAdded: '#35d8ff',
  diffRemoved: '#ff4d2e',
  diffContext: '#7a96aa',

  // 选择 / 背景（pi: selectedBg=panel2; 弹窗与右栏用更沉的 stageBg）
  selectedBg: '#3a5d78',
  /** 弹窗面板底色：stage 深蓝，读作「浮起来的面板」而不是一大块灰板。 */
  panelBg: '#1a3045',
  panelBorder: '#3a5d78',
  /** 文件编辑右栏：常驻图层而非模态，与 stage 同级的深蓝。 */
  paneBg: '#1a3045',
  paneBorder: '#3a5d78',

  // 底栏：每段一个色相，与 pi 的 footer 数据段一致。
  footerBorder: '#3a5d78',
  dirLabel: '#35d8ff',
  branchLabel: '#c9deea',
  thinkLabel: '#ffb454',

  // 输入框（pi 的 editor 边框 = border token；活跃态用 borderAccent）
  editorBorder: '#3a5d78',
  editorBorderActive: '#35d8ff',
  welcomeBorder: '#ffb454',

  // 语法高亮里的数字（pi: syntaxNumber=yellow2，与 keyword 的黄错开一档）
  codeNumber: '#ffec80',
})

// ── 主题对象 ─────────────────────────────────────────────────────────────

/**
 * 由 token 表构造一个主题。
 *
 * 返回的对象带：
 * - `fg(token, text)` / `bg(token, text)`  —— 通用取色
 * - `bold/italic/underline/strikethrough` —— 文本修饰
 * - `markdown` / `editor` / `selectList`  —— pi-tui 组件直接可用的三套形状
 */
export function createTheme(tokens = DARK_TOKENS, env = process.env) {
  const depth = detectColorDepth(env)
  const sgr = makeSgr(depth)

  /** 取一个 token 的颜色，包住文本并复位 */
  function fg(token, text) {
    const color = tokens[token]
    if (color === undefined) return String(text)
    const prefix = sgr(color, false)
    return prefix === '' ? String(text) : prefix + text + RESET
  }

  function bg(token, text) {
    const color = tokens[token]
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
    heading: (t) => bold(fg('accent', t)),
    link: (t) => fg('success', underline(t)),
    linkUrl: (t) => fg('dim', t),
    code: (t) => fg('warning', t),
    codeBlock: (t) => fg('text', t),
    codeBlockBorder: (t) => fg('warning', t),
    quote: (t) => fg('muted', italic(t)),
    quoteBorder: (t) => fg('border', t),
    hr: (t) => fg('border', t),
    listBullet: (t) => fg('success', t),
    bold: (t) => bold(t),
    italic: (t) => italic(t),
    strikethrough: (t) => strikethrough(t),
    underline: (t) => underline(t),
    // 语法高亮：只认有把握的语言（注释/字符串/数字/关键字），其余返回
    // undefined，pi-tui 会退回 codeBlock 的纯色渲染。
    highlightCode: createHighlighter({
      // pi-theme 的 syntax 映射：comment=mutedDim, keyword=yellow,
      // string=orange, number=yellow2；非 token 基础文本保持 cream。
      code: (t) => fg('text', t),
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
    tokens,
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
