import { Editor } from '@earendil-works/pi-tui'
import { fit } from './layout.js'

/** Retain pi-tui's editor, IME marker, paste handling and autocomplete; replace its chrome. */
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
      if (index === 0 || plainText(line).startsWith('─')) return theme.fg('border', fit('──' + plainText(line), width))
      return fit((index === 1 ? theme.fg('accent', '❯ ') : '  ') + line, width)
    })
  }
}

function plainText(text) { return text.replace(/\x1b\[[0-9;]*m/g, '') }
