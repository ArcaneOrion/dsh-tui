import { Editor, visibleWidth } from '@earendil-works/pi-tui'
import { fit, pair } from './layout.js'

/** Retain pi-tui's editor, IME marker, paste handling and autocomplete; replace its chrome. */
export class WorkbenchEditor extends Editor {
  constructor(tui, theme, getState = () => ({})) {
    super(tui, theme.editor, { paddingX: 1 })
    this.workbenchTheme = theme
    this.getWorkbenchState = getState
  }

  render(width) {
    const lines = super.render(width)
    const theme = this.workbenchTheme
    const state = this.getWorkbenchState()
    const label = state.turnActive ? '继续输入 · 下一轮' : '写下你要做的事'
    const left = theme.fg('accent', ' › ') + theme.fg('muted', label) + ' '
    const hints = width >= 78 ? '/ 命令  @ 文件  Ctrl+K 工作台' : 'Ctrl+K 工作台'
    const right = theme.fg('dim', hints + ' ')
    if (!plainText(lines[0]).includes('↑')) lines[0] = pair(left, right, width)
    // Only replace the plain lower border; preserve editor scroll indicators.
    for (let i = 1; i < lines.length; i++) {
      const plain = lines[i].replace(/\x1b\[[0-9;]*m/g, '')
      if (/^─+$/.test(plain) && visibleWidth(plain) === width) {
        lines[i] = theme.fg('border', '─'.repeat(Math.max(0, width)))
        break
      }
    }
    return lines.map((line) => fit(line, width))
  }
}

function plainText(text) { return text.replace(/\x1b\[[0-9;]*m/g, '') }
