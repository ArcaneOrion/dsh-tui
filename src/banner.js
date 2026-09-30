/**
 * 顶部 banner。
 *
 * 它在注册表里是**默认实现**：`registry.setHeader(component)` 整体换掉它。
 * 里面的 ASCII 素材沿用你 pi 上的那套（鲸鱼 + DEEPSEEK 字标），配色改走本
 * TUI 的 token，这样换主题时 banner 跟着变。
 *
 * 宽度是硬约束：pi-tui 要求 `render(width)` 的每行可见宽度 ≤ width，越界会
 * 直接把整个 TUI 打崩。所以每一行都过一遍 truncateToWidth。
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { fit, pair } from './layout.js'

/** 鲸鱼（5 行）。用占位符标出两段用色，渲染时再替换。 */
const WHALE = [
  '   ▄▄███▄▄      ▄▄',
  '  █████████▄▄▄▄██',
  '  ███   ████████▀',
  '  ████▄    ▄████',
  '   ▀██████████▀',
]

/** DEEPSEEK 字标（5 行）。 */
const WORDMARK = [
  '██████╗ ███████╗███████╗██████╗ ███████╗███████╗███████╗██╗  ██╗',
  '██╔══██╗██╔════╝██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██║ ██╔╝',
  '██║  ██║█████╗  █████╗  ██████╔╝███████╗█████╗  █████╗  █████╔╝ ',
  '██║  ██║██╔══╝  ██╔══╝  ██╔═══╝ ╚════██║██╔══╝  ██╔══╝  ██╔═██╗ ',
  '██████╔╝███████╗███████╗██║     ███████║███████╗███████╗██║  ██╗',
]

/** 鲸鱼与字标之间的间隔。 */
const GAP = '  '

/** 把数组里每行补到等宽（按可见宽度）。 */
function padTo(lines, width) {
  return lines.map((line) => line + ' '.repeat(Math.max(0, width - visibleWidth(line))))
}

/**
 * 生成 banner 的原始行（未配色）。
 * 窄终端下先丢掉字标只留鲸鱼，再不行就整体截断。
 */
export function bannerLines(width) {
  const whale = padTo(WHALE, Math.max(...WHALE.map(visibleWidth)))
  const combined = whale.map((line, i) => line + GAP + (WORDMARK[i] ?? ''))

  if (visibleWidth(combined[0]) <= width) return { lines: combined, mode: 'full' }
  if (visibleWidth(whale[0]) <= width) return { lines: whale, mode: 'whale' }
  return { lines: WHALE, mode: 'narrow' }
}

/**
 * 顶部 banner 组件。
 *
 * @param {object} options
 * @param {object} options.theme
 * @param {()=>string|undefined} [options.getSubtitle] - 副标题（版本/模型等）
 */
export function createBanner({ theme, getSubtitle, getWorkspace, getPreset, hasConversation = () => false }) {
  return {
    render(width) {
      const subtitle = getSubtitle?.() ?? ''
      const workspace = getWorkspace?.() ?? ''
      const preset = getPreset?.() ?? ''
      if (hasConversation() || width < 32) {
        return [fit(theme.bold(theme.fg('accent', ' DeepSeek')) + theme.fg('dim', preset ? `  ·  ${preset}` : ''), width),
          fit(theme.fg('muted', ' ' + subtitle), width), '']
      }
      const boxWidth = Math.min(width, 104)
      const inner = Math.max(0, boxWidth - 4)
      const border = (text) => theme.fg('welcomeBorder', text)
      const padded = (text, cells) => fit(text, cells) + ' '.repeat(Math.max(0, cells - visibleWidth(fit(text, cells))))
      const row = (text) => border('│') + ' ' + padded(text, inner) + ' ' + border('│')
      const title = '─ DeepSeek Harness '
      const out = [border('╭' + fit(title, boxWidth - 2) + '─'.repeat(Math.max(0, boxWidth - 2 - visibleWidth(title))) + '╮')]
      const menu = [
        theme.bold('会话与工作区'),
        theme.fg('accent', '/resume') + theme.fg('muted', '   继续之前的会话'),
        theme.fg('accent', '/model') + theme.fg('muted', '    选择模型'),
        theme.fg('accent', '@文件') + theme.fg('muted', '     引用项目文件'),
        theme.fg('accent', 'Ctrl+K') + theme.fg('muted', '    工具与上下文'),
      ]
      out.push(row(''))
      if (boxWidth >= 72) {
        const leftWidth = 27
        for (let i = 0; i < WHALE.length; i++) {
          out.push(row(padded(theme.fg('accent', WHALE[i]), leftWidth) + border('│') + '  ' + menu[i]))
        }
      } else {
        for (const whale of WHALE) out.push(row(theme.fg('accent', whale)))
        out.push(row(''))
        out.push(row(theme.fg('muted', '/resume 继续会话 · /model 模型')))
        out.push(row(theme.fg('muted', 'Ctrl+K 工作台 · @文件 引用')))
      }
      out.push(row(''))
      out.push(row(pair(theme.fg('muted', subtitle), theme.fg('dim', preset), inner)))
      if (workspace) out.push(row(theme.fg('dim', workspace)))
      out.push(border('╰' + '─'.repeat(Math.max(0, boxWidth - 2)) + '╯'), '')
      return out.map((line) => fit(line, width))
    },
    invalidate() {
      // 无缓存，无需清理。
    },
  }
}
