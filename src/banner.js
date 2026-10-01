/**
 * 欢迎页。
 *
 * **它是流内容，不是活表头**——这是被 pi-tui 的渲染机制逼出来的设计：
 *
 * - 内容**增长**时，pi-tui 走 append 路径（发真实换行 → 终端滚动），顶部的行
 *   进 scrollback，永久保留；
 * - 某个组件被**原地改写或移除**时，它走 `\x1b[2K` 擦行重写——那一屏内容
 *   不会进历史。
 *
 * 早期版本把欢迎页放进 header 槽、一有对话就折叠成两行：实测（tmux 历史缓冲）
 * 鲸鱼从 1 行变 0 行——被原地擦掉，往上滚再也找不回来。现在它作为**第一行
 * 对话内容**存在，随对话增长自然滚入 scrollback。
 *
 * 快照语义：动态字段（版本/模型/工作区/预设）在**创建那一行时**取一次，
 * 之后不再变——否则它滚进历史后一改，就会触发 pi-tui 的 fullRender。
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
 * 渲染欢迎页（纯函数，供 welcome 行的渲染器调用）。
 *
 * @param {object} options
 * @param {number} options.width
 * @param {object} options.theme
 * @param {string} [options.subtitle]  - 版本 / 模型快照
 * @param {string} [options.workspace] - 工作目录快照
 * @param {string} [options.preset]    - 预设快照
 * @returns {string[]} 已配色、宽度安全
 */
export function renderWelcomeBox({ width, theme, subtitle = '', workspace = '', preset = '' }) {
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
}

/**
 * header 槽适配器：把欢迎页渲染成一个可 `registry.setHeader` 的组件。
 *
 * 真正的 TUI **不用它**——界面走 `welcomeRow`（流内容，见上），这样鲸鱼能滚进
 * scrollback。这个适配器留给演示脚本（demo / design:preview）与想用 header API
 * 的第三方：作为表头它会被 pi-tui 原地重绘，滚不进历史。
 */
export function createBanner({ theme, getSubtitle, getWorkspace, getPreset }) {
  return {
    render(width) {
      return renderWelcomeBox({
        width,
        theme,
        subtitle: getSubtitle?.() ?? '',
        workspace: getWorkspace?.() ?? '',
        preset: getPreset?.() ?? '',
      })
    },
    invalidate() {
      // 无缓存，无需清理。
    },
  }
}

/**
 * 造一行「欢迎页」消息（放进 view.rows 的**第一行**）。
 *
 * 快照语义见文件头：动态字段取一次，之后不再变——它要能安全地滚进历史。
 *
 * @param {{version:string, model?:string, cwd?:string, preset?:string}} options
 */
export function welcomeRow({ version, model, cwd, preset } = {}) {
  const modelLabel = typeof model === 'string' && model !== '' ? model : 'default model'
  return {
    key: 'welcome',
    role: 'welcome',
    done: true,
    subtitle: `dsh-tui ${version ?? ''} · ${modelLabel}`.trim(),
    workspace: typeof cwd === 'string' ? cwd : '',
    preset: typeof preset === 'string' ? preset : '',
  }
}
