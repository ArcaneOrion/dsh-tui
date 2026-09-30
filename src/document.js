/** Keyboard-readable detail sheet. Content may be recomputed while a tool runs. */
import { Key, matchesKey, Text } from '@earendil-works/pi-tui'
import { fit, pair, rule } from './layout.js'

export class DocumentView {
  constructor({ title, text, theme, getHeight = () => 24, onClose, onRefresh }) {
    Object.assign(this, { title, text, theme, getHeight, onClose, onRefresh })
    this.offset = 0
    this.pageSize = 12
    this.total = 0
    this.cache = undefined
  }
  invalidate() { this.cache = undefined }
  render(width) {
    const inner = Math.max(1, width - 4)
    const raw = typeof this.text === 'function' ? this.text() : this.text
    if (!this.cache || this.cache.raw !== raw || this.cache.width !== inner) {
      this.cache = { raw, width: inner, lines: new Text(String(raw ?? ''), 0, 0).render(inner) }
    }
    const content = this.cache.lines
    this.total = content.length
    this.pageSize = Math.max(1, Math.floor(this.getHeight() * 0.8) - 5)
    this.offset = Math.max(0, Math.min(this.offset, content.length - this.pageSize))
    const position = content.length ? `${this.offset + 1}–${Math.min(content.length, this.offset + this.pageSize)} / ${content.length}` : '0 / 0'
    const lines = [rule(this.title, width, this.theme), '']
    for (const line of content.slice(this.offset, this.offset + this.pageSize)) lines.push(fit('  ' + line, width))
    lines.push('')
    lines.push(pair(this.theme.fg('dim', ' ↑↓ 滚动 · PgUp/PgDn · Esc 返回'), this.theme.fg('muted', position + ' '), width))
    return lines.map((line) => this.theme.bg('panelBg', fit(line, width)))
  }
  handleInput(data) {
    if (matchesKey(data, Key.escape) || data === 'q') return this.onClose?.()
    if (matchesKey(data, Key.up) || data === 'k') this.offset--
    if (matchesKey(data, Key.down) || data === 'j') this.offset++
    if (matchesKey(data, Key.pageUp)) this.offset -= this.pageSize
    if (matchesKey(data, Key.pageDown) || data === ' ') this.offset += this.pageSize
    if (matchesKey(data, Key.home) || data === 'g') this.offset = 0
    if (matchesKey(data, Key.end) || data === 'G') this.offset = Math.max(0, this.total - this.pageSize)
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.total - this.pageSize)))
    if (data === 'r') this.onRefresh?.()
  }
}
