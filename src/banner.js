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
export function createBanner({ theme, getSubtitle }) {
  return {
    render(width) {
      const { lines } = bannerLines(width)
      const out = lines.map((line) => theme.fg('accent', truncateToWidth(line, width)))
      const subtitle = getSubtitle?.()
      if (typeof subtitle === 'string' && subtitle !== '') {
        out.push(theme.fg('dim', truncateToWidth(' ' + subtitle, width)))
      }
      return out
    },
    invalidate() {
      // 无缓存，无需清理。
    },
  }
}
