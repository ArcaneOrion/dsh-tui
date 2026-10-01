import { Editor } from '@earendil-works/pi-tui'
import { fit } from './layout.js'

/**
 * 保留 pi-tui Editor 的编辑能力（IME、粘贴、补全、历史），替换它的外观。
 *
 * 外观：**只有上下两道线条**，没有底色块、没有提示符。线条用 `editorBorder`
 * token（比通用 `border` 更实——通用 border 在深色终端上几乎看不见），
 * 边框行补到整宽以免断裂。
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
      if (index === 0 || plainText(line).startsWith('─')) {
        return theme.fg('editorBorder', fit('──' + plainText(line), width))
      }
      return fit('  ' + line, width)
    })
  }
}

function plainText(text) { return text.replace(/\x1b\[[0-9;]*m/g, '') }
