/**
 * 文件编辑右栏：Edit/Write 类工具运行时，在终端右侧划出的一块 diff 区域。
 *
 * 机制（对着 pi-tui 的真实约束选的，不是拟态浏览器）：
 *
 * 1. **用 nonCapturing overlay 而不是把右栏画进 root 行。** pi-tui 把超出屏高的
 *    root 行推进终端原生 scrollback；右栏若画进行里，滚走的每一行都会带着一份
 *    当时的右栏快照永久留在历史里。overlay 只合成在**活视口**上，scrollback
 *    保持干净——这与 Claude Code 的行为一致：右栏是活面板，不属于会话记录。
 * 2. **nonCapturing 意味着不抢焦点、不吃按键。** 输入、Ctrl+K/O/T、Esc 都不
 *    受影响；代价是右栏自己不能滚动——所以按「最后一次改动的行」自动定位
 *    窗口（工具正在改的地方就是你要看的地方）。
 * 3. **左列窄化渲染。** overlay 只盖住它那几列，底下如果还有左列的文字会被
 *    遮住。所以 splitRoot 在右栏可见时把全部区域按左列宽度渲染，右栏底下的
 *    列是空白。
 * 4. 状态保持：回合结束后右栏**保留最后一次编辑**（用户选择的 Claude Code
 *    行为）；下一次 Edit/Write 到来时整体刷新。
 */

import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui'
import { lineDiff } from './tool-cards.js'

/** 把一行按可见宽度补齐到 width（不截断，只补空格）。 */
function padTo(line, width) {
  const w = visibleWidth(line)
  return w >= width ? line : line + ' '.repeat(width - w)
}

/** 状态 → { 文本, token }。底色层之外，状态只靠颜色与措辞，不加图标堆砌。 */
const STATUS = {
  running: { text: '运行中', token: 'warning' },
  done: { text: '已保存', token: 'success' },
  error: { text: '失败', token: 'error' },
}

/**
 * 把一组文件 diff 摊平成带「全局行号」的行。
 *
 * diffs 的形状与 tool-cards.renderDiffs 相同：`[{ path, oldText, newText }]`；
 * 逐行化复用 tool-cards.lineDiff（含「改动过大不猜」的 summary 语义）。
 *
 * @returns {{ lines: string[], lastChanged: number, totalChanged: number }}
 *   lastChanged 是最后一个 +/- 行的下标（窗口定位用）。
 */
export function flattenDiffs(diffs, theme) {
  const lines = []
  let lastChanged = -1
  let totalChanged = 0
  for (const file of diffs) {
    const path = typeof file?.path === 'string' && file.path !== '' ? file.path : '(未命名)'
    lines.push(theme.fg('accent', ' ' + path))

    for (const row of lineDiff(file?.oldText ?? null, file?.newText ?? '')) {
      if (row.kind === 'add' || row.kind === 'remove') {
        totalChanged += 1
        lastChanged = lines.length
        const marker = row.kind === 'add' ? '+' : '-'
        const token = row.kind === 'add' ? 'diffAdded' : 'diffRemoved'
        lines.push(theme.fg(token, '  ' + marker + ' ' + row.text))
      } else if (row.kind === 'context') {
        lines.push(theme.fg('diffContext', '    ' + row.text))
      } else if (row.kind === 'summary') {
        lines.push(theme.fg('dim', '   ' + row.text))
      }
    }
  }
  return { lines, lastChanged, totalChanged }
}

/**
 * 右栏组件。render(width) 返回**恰好** getHeight() 行——overlay 会把它合成
 * 到活视口的右上角；行数由终端高度决定，与内容无关（不足补空行）。
 */
export class EditPane {
  /**
   * @param {object} options
   * @param {object} options.view        - 投影层视图模型（读 view.editPane）
   * @param {object} options.theme
   * @param {() => number} options.getHeight - 视口高度（终端行数）
   */
  constructor({ view, theme, getHeight }) {
    this.view = view
    this.theme = theme
    this.getHeight = getHeight
    this.cache = undefined
  }

  invalidate() {
    this.cache = undefined
  }

  render(width) {
    const height = Math.max(3, this.getHeight())
    const state = this.view.editPane
    const rev = state?.rev ?? 0
    if (this.cache !== undefined && this.cache.rev === rev && this.cache.width === width && this.cache.height === height) {
      return this.cache.lines
    }

    const lines = this.renderBody(state, width, height)
    this.cache = { rev, width, height, lines }
    return lines
  }

  /** 内容行（不含整块底色）；长度恒等于 height。 */
  renderBody(state, width, height) {
    const theme = this.theme
    const inner = Math.max(8, width - 2)

    if (state === null || state === undefined) {
      const lines = Array.from({ length: height }, () => '')
      lines[0] = theme.fg('dim', ' 文件编辑')
      lines[2] = theme.fg('dim', ' 暂无编辑。Edit / Write 工具运行时，')
      lines[3] = theme.fg('dim', ' 这里显示正在修改的文件。')
      return lines.map((line) => theme.bg('paneBg', padTo(' ' + line, inner)))
    }

    const status = STATUS[state.status] ?? STATUS.running
    const title = typeof state.title === 'string' && state.title !== '' ? state.title : '文件编辑'
    const header = truncateToWidth(
      ` ${title} · ${theme.fg(status.token, status.text)}` +
        (state.status === 'running' ? ' …' : ''),
      inner,
      '',
    )

    const { lines: body, lastChanged } = flattenDiffs(state.diffs, theme)

    // 窗口：聚焦最后一次改动的行，往上留大半个窗口、往下留几行余量。
    const capacity = Math.max(1, height - 2)
    let start = 0
    let end = body.length
    if (body.length > capacity) {
      const focus = lastChanged >= 0 ? lastChanged : body.length - 1
      start = Math.max(0, focus - Math.max(1, capacity - 6))
      end = Math.min(body.length, start + capacity)
      start = Math.max(0, end - capacity)
    }

    const out = [header]
    if (start > 0) out.push(theme.fg('dim', ` ↑ 已省略 ${start} 行`))
    for (const line of body.slice(start, end)) {
      out.push(truncateToWidth(line, inner, ''))
    }
    if (end < body.length) out.push(theme.fg('dim', ` ↓ 另有 ${body.length - end} 行`))
    while (out.length < height) out.push('')
    if (out.length > height) out.length = height

    // 每行补齐后整行铺 paneBg：底色就是「这是另一块图层」的信号。
    return out.map((line) => theme.bg('paneBg', padTo(line, inner)))
  }
}
