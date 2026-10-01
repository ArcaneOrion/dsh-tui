/**
 * 工具卡：把 dsh 工具**自己声明的展示意图**渲染成终端行。
 *
 * 关键设计：**不按工具名硬编码**。dsh 的工具通过 `presentCall(args)` /
 * `presentResult(args, result)` 声明一种与提供方无关的卡片类型：
 *
 *   调用态   generic | terminal | diff
 *   结果态   generic | terminal | diff | search | read | web
 *
 * 所以新工具装上就自带合适的卡片，这个文件不需要认识任何一个工具的名字。
 * 认不出的卡片类型一律退回原文渲染——**宁可朴素，不可编造**。
 */

import { Box, Container, Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

/** 卡片类型的图标。认不出的用 · 。 */
const KIND_ICON = {
  read: '○',
  edit: '✎',
  delete: '✗',
  move: '→',
  search: '⌕',
  execute: '▸',
  fetch: '↧',
  other: '·',
}

/**
 * 一个足够好的行级 diff。
 *
 * FileDiff 给的是「一个 hunk 的前后文本」，不是现成的 unified diff，所以要自己
 * 对齐。用经典 LCS 动态规划；输入是带 3 行上下文的 hunk，规模很小，够用。
 *
 * @param {string|null} oldText
 * @param {string} newText
 * @returns {Array<{kind:'context'|'add'|'remove', text:string}>}
 */
export function lineDiff(oldText, newText) {
  const before = oldText === null || oldText === undefined ? [] : String(oldText).split('\n')
  const after = String(newText ?? '').split('\n')

  const n = before.length
  const m = after.length
  // 全新建文件：没有前像，直接全标成新增。
  if (n === 0) return after.map((text) => ({ kind: 'add', text }))

  // 改动过大时**不猜**。
  //
  // 早期版本在这里把整份前后文标成「全删 + 全增」，再被行数上限截掉——用户
  // 会看到「前 40 行被删」，而实际只改了一行。那是伪造，正面违反本模块
  // 「宁可朴素，不可编造」的原则。改成一行如实说明。
  if (n * m > 250_000) {
    return [{ kind: 'summary', text: `${n} 行 → ${m} 行（改动过大，未逐行展开）` }]
  }

  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: 'context', text: before[i] })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'remove', text: before[i] })
      i += 1
    } else {
      out.push({ kind: 'add', text: after[j] })
      j += 1
    }
  }
  while (i < n) out.push({ kind: 'remove', text: before[i++] })
  while (j < m) out.push({ kind: 'add', text: after[j++] })
  return out
}

/** 把一段文本收成最多 maxLines 行的数组，超出时补一行说明。 */
export function clampLines(text, maxLines) {
  const lines = String(text ?? '').split('\n')
  if (lines.length <= maxLines) return { lines, hidden: 0 }
  return { lines: lines.slice(0, maxLines), hidden: lines.length - maxLines }
}

/**
 * 渲染一组文件 diff。
 * @returns {string[]} 已配色、未截宽的行
 */
export function renderDiffs(diffs, theme, { maxLinesPerFile = 40, maxTotalLines = 120 } = {}) {
  const out = []
  for (const file of diffs) {
    if (out.length >= maxTotalLines) break
    out.push(theme.fg('muted', '  ' + String(file.path ?? '')))
    const rows = lineDiff(file.oldText ?? null, file.newText ?? '')
    const budget = Math.min(maxLinesPerFile, Math.max(0, maxTotalLines - out.length))
    const shown = rows.slice(0, budget)
    for (const row of shown) {
      if (row.kind === 'summary') {
        out.push(theme.fg('dim', '  ' + row.text))
        continue
      }
      const marker = row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '
      const tone = row.kind === 'add' ? 'diffAdded' : row.kind === 'remove' ? 'diffRemoved' : 'diffContext'
      out.push(theme.fg(tone, '  ' + marker + ' ' + row.text))
    }
    if (rows.length > shown.length && shown[shown.length - 1]?.kind !== 'summary') {
      out.push(theme.fg('dim', `  … 另有 ${rows.length - shown.length} 行`))
    }
  }
  if (out.length >= maxTotalLines) out.push(theme.fg('dim', '  … 更多改动已省略'))
  return out
}

/**
 * 把一组文件 diff 压成每文件一行摘要：`path +N −M`。
 *
 * 左栏的对话区只显示「过程」，文件编辑的全文在右侧编辑栏（src/edit-pane.js）
 * 展示；这里不复述 diff，只给一眼可读的规模。
 */
export function summarizeDiffs(diffs, theme) {
  const out = []
  for (const file of diffs) {
    let add = 0
    let remove = 0
    let summarized = false
    for (const row of lineDiff(file?.oldText ?? null, file?.newText ?? '')) {
      if (row.kind === 'add') add += 1
      else if (row.kind === 'remove') remove += 1
      else if (row.kind === 'summary') summarized = true
    }
    const path = typeof file?.path === 'string' && file.path !== '' ? file.path : '(未命名)'
    const counts = summarized ? '' : ` ${theme.fg('diffAdded', `+${add}`)} ${theme.fg('diffRemoved', `−${remove}`)}`
    out.push(theme.fg('muted', '  ' + path) + counts)
  }
  return out
}

/** 把 content 块数组抽成纯文本（只取文本块）。 */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n')
}

/**
 * 渲染「调用态」卡片头。
 * @returns {string[]}
 */
export function renderCallView(view, theme) {
  if (view === null || view === undefined || typeof view !== 'object') return []
  const out = []

  if (view.card === 'terminal') {
    const cwd = typeof view.cwd === 'string' && view.cwd !== '' ? ` ${theme.fg('dim', view.cwd)}` : ''
    out.push(theme.fg('toolTitle', `▸ ${view.title ?? 'command'}`) + cwd)
    if (typeof view.description === 'string' && view.description !== '') {
      out.push(theme.fg('dim', '  ' + view.description))
    }
    return out
  }

  if (view.card === 'diff') {
    out.push(theme.fg('toolTitle', `✎ ${view.title ?? 'edit'}`))
    if (Array.isArray(view.diffs)) out.push(...summarizeDiffs(view.diffs, theme))
    return out
  }

  // generic（以及任何认不出的）
  const icon = KIND_ICON[view.kind] ?? KIND_ICON.other
  const title = typeof view.title === 'string' && view.title !== '' ? view.title : 'tool'
  out.push(theme.fg('toolTitle', `${icon} ${title}`))
  const raw = contentText(view.content)
  if (raw !== '') out.push(...clampLines(raw, 6).lines.map((line) => theme.fg('dim', '  ' + line)))
  return out
}

/**
 * 渲染「结果态」卡片。
 *
 * @param {object|undefined} view - ToolResultView
 * @param {string} fallbackText    - 没有视图或视图认不出时的原文
 * @param {object} theme
 * @param {{isError?:boolean, maxLines?:number}} [options]
 * @returns {string[]}
 */
export function renderResultView(view, fallbackText, theme, options = {}) {
  const maxLines = options.maxLines ?? 12
  const out = []

  if (view !== null && view !== undefined && typeof view === 'object') {
    if (view.card === 'diff' && Array.isArray(view.diffs)) {
      out.push(...summarizeDiffs(view.diffs, theme))
      return out
    }

    if (view.card === 'terminal') {
      if (typeof view.output === 'string' && view.output !== '') {
        const { lines, hidden } = clampLines(view.output, maxLines)
        out.push(...lines.map((line) => theme.fg('toolOutput', '  ' + line)))
        if (hidden > 0) out.push(theme.fg('dim', `  … 另有 ${hidden} 行`))
      }
      if (typeof view.exitCode === 'number') {
        const tone = view.exitCode === 0 ? 'success' : 'error'
        out.push(theme.fg(tone, `  exit ${view.exitCode}`))
      } else if (typeof view.signal === 'string') {
        out.push(theme.fg('error', `  被 ${view.signal} 终止`))
      }
      return out
    }

    if (view.card === 'search') {
      if (view.shape === 'matches' && Array.isArray(view.files)) {
        for (const file of view.files) {
          out.push(theme.fg('muted', '  ' + String(file?.path ?? '')))
          for (const match of file?.matches ?? []) {
            // 字段可能来自被改坏/被截断的 meta；缺了给个诚实的 `?`，
            // 而不是把 undefined 打到屏幕上。
            const lineNumber = Number.isFinite(match?.lineNumber) ? match.lineNumber : '?'
            const text = typeof match?.line === 'string' ? match.line : ''
            out.push(theme.fg('toolOutput', `    ${lineNumber}: ${text}`))
          }
        }
        if (view.truncated === true) out.push(theme.fg('warning', `  … 命中 ${view.total} 处，已截断`))
        return out
      }
      if (view.shape === 'paths' && Array.isArray(view.paths)) {
        for (const p of view.paths) out.push(theme.fg('toolOutput', '  ' + p))
        if (view.truncated === true) out.push(theme.fg('warning', `  … 共 ${view.total} 条，已截断`))
        return out
      }
    }

    if (view.card === 'read' && Array.isArray(view.lines)) {
      const total = typeof view.totalLines === 'number' ? view.totalLines : undefined
      if (typeof view.path === 'string') {
        const suffix = total === undefined ? '' : theme.fg('dim', `  ${view.lines.length}/${total} 行`)
        out.push(theme.fg('muted', '  ' + view.path) + suffix)
      }
      for (const line of view.lines.slice(0, maxLines)) {
        const number = Number.isFinite(line?.number) ? String(line.number).padStart(4) : '   ?'
        const text = typeof line?.text === 'string' ? line.text : ''
        out.push(theme.fg('dim', '  ' + number + ' ') + theme.fg('toolOutput', text))
      }
      if (view.lines.length > maxLines) out.push(theme.fg('dim', `  … 另有 ${view.lines.length - maxLines} 行`))
      return out
    }

    if (view.card === 'web') {
      if (view.kind === 'search' && Array.isArray(view.sources)) {
        for (const source of view.sources) {
          out.push(theme.fg('accent', '  ' + String(source.title ?? source.url ?? '')))
          if (typeof source.url === 'string' && source.url !== source.title) {
            out.push(theme.fg('dim', '    ' + source.url))
          }
        }
        if (view.truncated === true) out.push(theme.fg('warning', '  … 来源已截断'))
        if (typeof view.answer === 'string' && view.answer !== '') {
          out.push(...clampLines(view.answer, 6).lines.map((line) => theme.fg('toolOutput', '  ' + line)))
        }
        return out
      }
      if (view.kind === 'fetch') {
        const status = Number.isFinite(view.statusCode) ? view.statusCode : '?'
        const url = typeof view.url === 'string' ? view.url : ''
        out.push(theme.fg('toolOutput', `  ${status} ${url}`.trimEnd()))
        if (view.truncated === true) out.push(theme.fg('warning', '  … 正文已截断'))
        return out
      }
    }

    if (view.card === 'generic') {
      const text = contentText(view.content)
      if (text !== '') {
        const { lines, hidden } = clampLines(text, maxLines)
        out.push(...lines.map((line) => theme.fg('toolOutput', '  ' + line)))
        if (hidden > 0) out.push(theme.fg('dim', `  … 另有 ${hidden} 行`))
        return out
      }
    }
  }

  // 没有视图、或认不出卡片类型：退回原文。宁可朴素，不可编造。
  if (typeof fallbackText === 'string' && fallbackText.trim() !== '') {
    const { lines, hidden } = clampLines(fallbackText, maxLines)
    out.push(...lines.map((line) => theme.fg('toolOutput', '  ' + line)))
    if (hidden > 0) out.push(theme.fg('dim', `  … 另有 ${hidden} 行`))
  }
  return out
}

/**
 * 一条工具调用的完整卡片。
 *
 * 对齐 pi 的 `ToolExecutionComponent`：**一整块有底色的框**，底色随状态变——
 * 进行中 `toolPendingBg`、成功 `toolSuccessBg`、失败 `toolErrorBg`。
 * 底色本身就是状态信号，不用再读一行文字。
 *
 * 这是注册表里 `tool` 角色的默认渲染器，可被 `setMessageRenderer('tool', …)` 换掉。
 */
export class ToolCard extends Container {
  constructor({ row, theme }) {
    super()
    this.build(row, theme)
  }

  build(row, theme) {
    // pi 的 ToolExecutionComponent：一整块底色随状态变的框——运行中
    // toolPendingBg、失败 toolErrorBg、成功 toolSuccessBg。底色本身就是状态
    // 信号，不再有「运行中…/完成」这样的文字行。
    const bgToken =
      row.done !== true
        ? 'toolPendingBg'
        : row.isError === true
          ? 'toolErrorBg'
          : 'toolSuccessBg'
    const box = new Box(1, 1, (text) => theme.bg(bgToken, text))

    const callLines = renderCallView(row.callView, theme)
    if (callLines.length === 0) {
      // 没有展示意图（工具没声明 presentCall，或 args 还不是合法 JSON）。
      // pi 的兜底：粗体工具名。
      box.addChild(new Text(theme.bold(theme.fg('toolTitle', row.toolName ?? 'tool')), 0, 0))
    } else {
      box.addChild(new Text(callLines[0], 0, 0))
      for (const line of callLines.slice(1, 5)) box.addChild(new Text(line, 0, 0))
    }

    const resultLines = renderResultView(row.resultView, row.text, theme, { isError: row.isError === true })
    for (const line of resultLines.slice(0, 7)) {
      box.addChild(new Text(line, 0, 0))
    }
    const truncated = resultLines.length > 7 || callLines.length > 5 || resultLines.some((line) => /另有|省略/.test(line))
    if (truncated) {
      const rawLines = String(row.text ?? '').split('\n').length
      const detail = rawLines > 12 ? ` · 另有 ${rawLines - 12} 行` : ''
      box.addChild(new Text(theme.fg('dim', `  … /inspect 查看完整调用与结果${detail}`), 0, 0))
    }

    if (typeof row.errorReason === 'string' && row.errorReason !== '') {
      box.addChild(new Text(theme.fg('error', '  ' + row.errorReason), 0, 0))
    }

    this.addChild(box)
  }
}

export { visibleWidth, truncateToWidth }
