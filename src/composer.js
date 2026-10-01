import { Editor, visibleWidth } from '@earendil-works/pi-tui'
import { fit } from './layout.js'

/** 把一行补齐到 width 个显示列（不截断，只补空格）。 */
function padTo(line, width) {
  const visible = visibleWidth(line)
  return visible >= width ? line : line + ' '.repeat(width - visible)
}

/**
 * 保留 pi-tui Editor 的编辑能力（IME、粘贴、补全、历史），替换它的外观。
 *
 * 外观对齐 Claude Code 的输入区：**一整块底色**（含上下边框行），读作
 * 「一块可以输入的色块」，与状态行的色块呼应；没有提示符、没有多余装饰。
 */
export class WorkbenchEditor extends Editor {
  constructor(tui, theme, getState = () => ({})) {
    super(tui, theme.editor, { paddingX: 1 })
    this.workbenchTheme = theme
    this.getWorkbenchState = getState
  }

  render(width) {
    const lines = super.render(Math.max(1, width - 2))
    const theme = this.workbenchTheme
    return lines.map((line, index) => {
      // Editor rows have padding; border rows begin with a rule. Preserve its
      // scroll markers and cursor/IME escape sequences exactly.
      const isBorder = index === 0 || plainText(line).startsWith('─')
      const content = isBorder
        ? theme.fg('border', fit('──' + plainText(line), width))
        : fit('  ' + line, width)
      // 整块铺底色：先补齐宽度再包背景色，这样色块一直铺到最右边。
      return theme.bg('editorBg', padTo(content, width))
    })
  }
}

function plainText(text) { return text.replace(/\x1b\[[0-9;]*m/g, '') }
