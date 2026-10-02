/** 文件改动审阅器：独立选择与滚动，输入默认仍由会话编辑器接收。 */
import { Key, matchesKey, visibleWidth, truncateToWidth, sliceByColumn } from '@earendil-works/pi-tui'
import { lineDiff } from './tool-cards.js'

const STATUS = { running: '拟修改', done: '已执行', error: '失败' }
const clean = text => String(text ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replaceAll('\t', '  ').replaceAll('\n', '↵')

function snippetRows(diffs) {
  const rows = []
  for (const file of diffs) {
    if (rows.length) rows.push({ kind: 'hunk', text: '── 另一处修改 ──' })
    let oldLine = 1, newLine = 1
    for (const row of lineDiff(file.oldText ?? null, file.newText ?? '')) {
      rows.push({ ...row, oldLine: ['context', 'remove'].includes(row.kind) ? oldLine++ : undefined,
        newLine: ['context', 'add'].includes(row.kind) ? newLine++ : undefined })
    }
  }
  return rows
}

/** 兼容已有导出；片段行号与真实文件行号分开呈现。 */
export function flattenDiffs(diffs, theme) {
  const lines = [], changes = []
  for (const file of diffs) {
    lines.push(theme.fg('accent', ' ' + clean(file.path)))
    for (const row of lineDiff(file.oldText ?? null, file.newText ?? '')) {
      const changed = row.kind === 'add' || row.kind === 'remove'
      if (changed) changes.push(lines.length)
      lines.push(theme.fg(row.kind === 'add' ? 'diffAdded' : row.kind === 'remove' ? 'diffRemoved' : 'diffContext',
        `  ${row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '} ${clean(row.text)}`))
    }
  }
  return { lines, lastChanged: changes.at(-1) ?? -1, totalChanged: changes.length }
}

export class EditPane {
  constructor({ view, theme, getHeight, onRefresh, onReturn, onClose }) {
    Object.assign(this, { view, theme, getHeight, onRefresh, onReturn, onClose })
    this.reset()
  }
  reset() {
    this.workspace = undefined
    this.workspaceKey = ''
    this.source = 'workspace'
    this.selected = undefined
    this.follow = true
    this.focused = false
    this.offset = 0
    this.horizontal = 0
    this.pageSize = 1
    this.total = 0
    this.observedRevision = -1
    this.unseen = false
    this.version = 0
    this.cache = undefined
    this.error = undefined
    this.snippetCache = undefined
  }
  invalidate() { this.cache = undefined }
  touch() { this.version++; this.invalidate() }
  setFocused(value) { this.focused = value; this.touch() }
  setWorkspace(snapshot) {
    const key = JSON.stringify(snapshot)
    if (key === this.workspaceKey) return false
    this.workspace = snapshot
    this.workspaceKey = key
    this.error = undefined
    if (this.follow) this.observedRevision = -1
    if (!this.follow) this.unseen = true
    this.touch()
    return true
  }
  files() {
    if (this.source === 'workspace' && this.workspace?.available) return this.workspace.files
    const stored = this.view.fileChanges?.files
    if (stored?.size) {
      if (this.snippetCache?.files !== stored || this.snippetCache.rev !== this.view.fileChanges.rev) {
        this.snippetCache = { files: stored, rev: this.view.fileChanges.rev,
          value: [...stored.values()].map(file => ({ ...file, lines: snippetRows(file.diffs) })) }
      }
      return this.snippetCache.value
    }
    const legacy = this.view.editPane
    return (legacy?.diffs ?? []).map(diff => ({ path: diff.path, lines: snippetRows([diff]), status: legacy.status }))
  }
  scope() { return this.source === 'workspace' && this.workspace?.available ? '未提交 · 含已有改动' : '会话编辑 · 最近片段' }
  sync() {
    const files = this.files()
    const revision = this.view.fileChanges?.rev ?? this.view.editPane?.rev ?? 0
    const latest = this.view.fileChanges?.latestPath ?? this.view.editPane?.diffs?.[0]?.path
    const relative = this.workspace?.root && latest?.startsWith(this.workspace.root + '/')
      ? latest.slice(this.workspace.root.length + 1) : latest
    if (revision !== this.observedRevision) {
      if (this.follow) {
        if (files.some(file => file.path === relative)) this.selected = relative
        this.offset = 0
      } else if (this.observedRevision !== -1) this.unseen = true
      this.observedRevision = revision
    }
    if (!files.some(file => file.path === this.selected)) {
      this.selected = files[0]?.path
      this.offset = 0
    }
    return files
  }
  selectFile(delta) {
    const files = this.sync()
    if (!files.length) return
    const index = files.findIndex(file => file.path === this.selected)
    this.selected = files[(index + delta + files.length) % files.length].path
    this.total = files[(index + delta + files.length) % files.length].lines.length
    this.follow = false; this.offset = 0; this.horizontal = 0; this.touch()
  }
  handleInput(data) {
    if (data === 'x') { this.onClose?.(); return true }
    if (matchesKey(data, Key.escape) || data === 'q' || matchesKey(data, Key.f6)) { this.onReturn?.(); return true }
    if (data === '[' || matchesKey(data, Key.alt('up'))) { this.selectFile(-1); return true }
    if (data === ']' || matchesKey(data, Key.alt('down'))) { this.selectFile(1); return true }
    if (data === 'f') { this.follow = true; this.unseen = false; this.observedRevision = -1; this.offset = 0; this.touch(); return true }
    if (data === 'b') { this.source = this.source === 'workspace' ? 'edits' : 'workspace'; this.selected = undefined; this.offset = 0; this.touch(); return true }
    if (data === 'r') { this.onRefresh?.(); return true }
    let moved = true
    if (matchesKey(data, Key.up) || data === 'k') this.offset--
    else if (matchesKey(data, Key.down) || data === 'j') this.offset++
    else if (matchesKey(data, Key.pageUp)) this.offset -= this.pageSize
    else if (matchesKey(data, Key.pageDown) || data === ' ') this.offset += this.pageSize
    else if (matchesKey(data, Key.home) || data === 'g') this.offset = 0
    else if (matchesKey(data, Key.end) || data === 'G') this.offset = this.total
    else if (matchesKey(data, Key.left) || data === 'h') this.horizontal = Math.max(0, this.horizontal - 8)
    else if (matchesKey(data, Key.right) || data === 'l') this.horizontal += 8
    else moved = false
    if (moved) {
      this.follow = false
      this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.total - this.pageSize)))
      this.touch()
    }
    return moved
  }
  render(width) {
    const height = Math.max(1, this.getHeight())
    if (width < 3) return Array.from({ length: height }, () => ' '.repeat(Math.max(0, width)))
    const files = this.sync()
    const revision = this.view.fileChanges?.rev ?? this.view.editPane?.rev ?? 0
    const cacheKey = () => [width, height, revision, this.version, this.selected, this.offset, this.horizontal, this.follow, this.focused].join(':')
    const key = cacheKey()
    if (this.cache?.key === key) return this.cache.lines
    const { theme } = this
    const inner = Math.max(1, width - 4)
    const fit = text => truncateToWidth(text, inner, '…', true)
    const ink = (token, text) => theme.fg(token, clean(text))
    const out = []
    const add = text => out.push(fit(text))
    const title = `${files.length} 个文件改动`
    if (height >= 18) add('')
    add(theme.bold(ink('paneText', title)) + ' '.repeat(Math.max(1, inner - visibleWidth(title) - 6)) + ink('paneMuted', 'x 关闭'))
    if (height >= 18) add('')
    if (!files.length) {
      if (height >= 18) add('')
      add(ink('muted', this.workspace?.available ? '工作区没有未提交改动。' : '暂无编辑。文件修改后显示在这里。'))
      if (this.error) add(ink('error', this.error))
      else if (this.workspace?.note) add(ink('dim', this.workspace.note))
    } else {
      const index = files.findIndex(file => file.path === this.selected)
      const listSize = Math.min(files.length, Math.max(1, Math.min(5, Math.floor(height / 5))))
      const first = Math.max(0, Math.min(index - Math.floor(listSize / 2), files.length - listSize))
      for (const file of files.slice(first, first + listSize)) {
        const added = file.added ?? file.lines.filter(x => x.kind === 'add').length
        const removed = file.removed ?? file.lines.filter(x => x.kind === 'remove').length
        const tally = file.note ? '' : ` +${added} −${removed}`
        const pathWidth = Math.max(4, inner - visibleWidth(tally) - 2)
        const label = truncateToWidth(clean(file.path), pathWidth, '…')
        add(ink(file.path === this.selected ? 'paneText' : 'paneMuted', `${file.path === this.selected ? '›' : ' '} ${label}`)
          + ink('diffAdded', file.note ? '' : ` +${added}`) + ink('diffRemoved', file.note ? '' : ` −${removed}`))
      }
      const file = files[index]
      add('')
      add(ink('paneBorder', '─'.repeat(inner)))
      const status = this.source === 'workspace' && this.workspace?.available ? (file.code === '??' ? '未跟踪' : '未提交') : `${STATUS[file.status] ?? '编辑'} · 片段行号`
      add(theme.bold(ink('paneText', clean(file.path))) + ink(file.status === 'error' ? 'error' : 'paneMuted', ` (${status})`))
      add(ink('paneBorder', '─'.repeat(inner)))
      const rows = file.lines
      this.pageSize = Math.max(1, height - out.length - 3)
      this.total = rows.length
      this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.total - this.pageSize)))
      if (this.follow && this.source === 'edits') {
        const last = rows.findLastIndex(row => row.kind === 'add' || row.kind === 'remove')
        this.offset = Math.max(0, last - this.pageSize + 1)
      }
      if (!this.workspace?.available && this.follow) this.offset = Math.max(0, rows.findLastIndex(x => x.kind === 'add' || x.kind === 'remove') - this.pageSize + 1)
      const digits = Math.max(3, String(rows.reduce((max, row) => Math.max(max, row.newLine ?? row.oldLine ?? 0), 1)).length)
      for (const row of rows.slice(this.offset, this.offset + this.pageSize)) {
        const token = row.kind === 'add' ? 'diffAdded' : row.kind === 'remove' ? 'diffRemoved' : row.kind === 'hunk' ? 'accent' : 'diffContext'
        const number = row.newLine ?? row.oldLine
        const prefix = `${number === undefined ? ''.padStart(digits) : String(number).padStart(digits)} ${row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '} `
        add(ink('dim', prefix.slice(0, digits + 1)) + ink(token, prefix.slice(digits + 1) + sliceByColumn(clean(row.text), this.horizontal, Math.max(1, inner - digits - 3))))
      }
      if (!rows.length) add(ink('muted', file.note ?? '没有文本差异'))
    }
    while (out.length < Math.max(0, height - 2)) out.push('')
    const position = this.total ? `${this.offset + 1}–${Math.min(this.total, this.offset + this.pageSize)}/${this.total}` : ''
    add(ink(this.error ? 'error' : 'paneMuted', this.error ?? this.workspace?.note ?? `${this.scope()}${this.unseen ? ' · 有新改动' : ''}`))
    add(ink('paneMuted', this.focused ? `${position}  ↑↓ 滚动 · [ ] 文件 · f 跟随 · Esc 返回` : `${position} · ${this.follow ? '跟随' : '固定'} · F6 浏览`))
    const lines = out.slice(0, height).map(line => theme.bg('paneBg', truncateToWidth('  ' + line, width, '', true)))
    while (lines.length < height) lines.push(theme.bg('paneBg', ' '.repeat(Math.max(0, width))))
    this.cache = { key: cacheKey(), lines }
    return lines
  }
}
