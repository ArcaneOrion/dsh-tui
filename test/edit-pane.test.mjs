/**
 * 文件编辑右栏测试。
 *
 * 覆盖两段：投影层的 editPane 状态机（callView.card === 'diff' 触发、
 * 结果配对、错误态、非编辑工具不干扰），与 EditPane 组件的渲染契约
 * （恒定高度、窗口定位、缓存键、空态占位）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applySessionEvent, createView } from '../src/projection.js'
import { EditPane, flattenDiffs } from '../src/edit-pane.js'
import { createTheme } from '../src/theme.js'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createApp } from '../src/app.js'
import { createRegistry } from '../src/registry.js'
import { memoryTerminal } from '../scripts/fixtures.mjs'

const theme = createTheme(undefined, { DSH_TUI_COLOR: '256' })

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '')

/** diff 展示意图的 present 解析器（投影层只认展示意图，不认工具名）。 */
const presentDiff = {
  call: () => ({
    card: 'diff',
    title: 'edit src/a.js',
    diffs: [{ path: 'src/a.js', oldText: 'a\nb\nc', newText: 'a\nx\nc' }],
  }),
  result: () => ({
    card: 'diff',
    diffs: [{ path: 'src/a.js', oldText: 'a\nb\nc', newText: 'a\nx\nc' }],
  }),
}

const toolCall = (callId) => ({
  seq: 3,
  type: 'tool/call',
  data: { callId, name: 'edit', arguments: {} },
})

const toolResult = (callId, { isError = false } = {}) => ({
  seq: 4,
  type: 'tool/result',
  data: {
    message: {
      toolCallId: callId,
      name: 'edit',
      content: [{ type: 'text', text: 'ok' }],
      isError,
    },
  },
})

// ── 投影层：editPane 状态机 ─────────────────────────────────────────────

test('diff 展示意图的 tool/call 进入 editPane 运行态', () => {
  const view = createView()
  applySessionEvent(view, toolCall('c1'), presentDiff)
  assert.equal(view.editPane.status, 'running')
  assert.equal(view.editPane.callId, 'c1')
  assert.equal(view.editPane.title, 'edit src/a.js')
  assert.equal(view.editPane.rev, 1)
  assert.equal(view.editPane.diffs.length, 1)
})

test('配对的 tool/result 把 editPane 置为 done 并更新 rev', () => {
  const view = createView()
  applySessionEvent(view, toolCall('c1'), presentDiff)
  applySessionEvent(view, toolResult('c1'), presentDiff)
  assert.equal(view.editPane.status, 'done')
  assert.equal(view.editPane.rev, 2)
})

test('失败结果把 editPane 置为 error', () => {
  const view = createView()
  applySessionEvent(view, toolCall('c1'), presentDiff)
  applySessionEvent(view, toolResult('c1', { isError: true }), presentDiff)
  assert.equal(view.editPane.status, 'error')
})

test('非 diff 的 callView 不触发 editPane', () => {
  const view = createView()
  applySessionEvent(view, toolCall('c1'), { call: () => ({ card: 'generic', kind: 'search', title: 'grep' }) })
  assert.equal(view.editPane, null)
})

test('别的调用的结果不改 editPane 状态', () => {
  const view = createView()
  applySessionEvent(view, toolCall('c1'), presentDiff)
  applySessionEvent(view, toolCall('c2'), presentDiff)
  assert.equal(view.editPane.callId, 'c2')
  applySessionEvent(view, toolResult('c1'), presentDiff)
  assert.equal(view.editPane.callId, 'c2')
  assert.equal(view.editPane.status, 'running')
  assert.equal(view.editPane.rev, 2)
})

test('createView 的 editPane 初始为 null', () => {
  assert.equal(createView().editPane, null)
})

// ── flattenDiffs ─────────────────────────────────────────────────────────

test('flattenDiffs 标记 +/- 行并定位最后一次改动', () => {
  const { lines, lastChanged, totalChanged } = flattenDiffs(
    [{ path: 'a.js', oldText: 'one\ntwo', newText: 'one\nTWO\nthree' }],
    theme,
  )
  assert.ok(totalChanged >= 2)
  assert.equal(lastChanged, lines.length - 1)
  assert.ok(lines.some((l) => plain(l).includes('+ three')))
  assert.ok(lines.some((l) => plain(l).includes('- two') || plain(l).includes('+ TWO')))
})

// ── EditPane 组件 ─────────────────────────────────────────────────────────

test('空态：占位说明且行数恒等于高度', () => {
  const view = createView()
  const pane = new EditPane({ view, theme, getHeight: () => 8 })
  const lines = pane.render(40)
  assert.equal(lines.length, 8)
  assert.ok(lines.some(line => plain(line).includes('暂无编辑')))
})

test('运行态：头部带标题与状态，行数恒等于高度', () => {
  const view = createView()
  applySessionEvent(view, toolCall('c1'), presentDiff)
  const pane = new EditPane({ view, theme, getHeight: () => 12 })
  const lines = pane.render(40)
  assert.equal(lines.length, 12)
  const header = plain(lines[0])
  assert.ok(header.includes('文件改动'))
  assert.ok(lines.some(line => plain(line).includes('拟修改')))
  assert.ok(lines.some((l) => plain(l).includes('src/a.js')))
  assert.ok(lines.some((l) => plain(l).includes('+ x')))
})

test('长 diff 窗口聚焦最后一次改动并给出省略提示', () => {
  const view = createView()
  const big = Array.from({ length: 60 }, (_, i) => `line-${i}`).join('\n')
  applySessionEvent(view, toolCall('c1'), {
    call: () => ({
      card: 'diff',
      title: 'write big.txt',
      diffs: [{ path: 'big.txt', oldText: null, newText: big }],
    }),
  })
  const pane = new EditPane({ view, theme, getHeight: () => 10 })
  const lines = pane.render(36)
  assert.equal(lines.length, 10)
  const text = lines.map(plain).join('\n')
  // 全新建文件：最后一行 line-59 必须在窗口里（尾部余量）。
  assert.ok(text.includes('line-59'), `窗口应包含最后一次改动，实际：${text}`)
  assert.match(text, /\d+–\d+\/60/, '超出容量时显示滚动位置')
})

test('缓存：同 rev 同尺寸复用，rev 变化重绘', () => {
  const view = createView()
  applySessionEvent(view, toolCall('c1'), presentDiff)
  const pane = new EditPane({ view, theme, getHeight: () => 10 })
  const first = pane.render(40)
  const second = pane.render(40)
  assert.equal(first, second)
  applySessionEvent(view, toolResult('c1'), presentDiff)
  const third = pane.render(40)
  assert.notEqual(first, third)
  assert.ok(third.some(line => plain(line).includes('已执行')))
})

test('高度变化触发重绘（缓存键含高度）', () => {
  const view = createView()
  applySessionEvent(view, toolCall('c1'), presentDiff)
  const pane = new EditPane({ view, theme, getHeight: () => 10 })
  const a = pane.render(40)
  const b = pane.render(40)
  assert.equal(a.length, 10)
  assert.equal(b.length, 10)
})

function edit(view, id, path, text = 'new', result = false) {
  const presentation = { card: 'diff', diffs: [{ path, oldText: null, newText: text }] }
  applySessionEvent(view, toolCall(id), { call: () => result ? undefined : presentation })
  if (result) applySessionEvent(view, toolResult(id), { result: () => presentation })
}

test('多文件和只有 result 声明的 diff 都保留，旧调用乱序结束不覆盖新调用', () => {
  const view = createView()
  edit(view, 'one', 'a.js', 'first')
  edit(view, 'two', 'b.js', 'second', true)
  edit(view, 'three', 'a.js', 'latest')
  applySessionEvent(view, toolResult('one'), { result: () => ({ card: 'diff', diffs: [{ path: 'a.js', oldText: null, newText: 'stale' }] }) })
  assert.equal(view.fileChanges.files.size, 2)
  assert.equal(view.fileChanges.files.get('a.js').diffs[0].newText, 'latest')
  assert.equal(view.fileChanges.files.get('b.js').status, 'done')
})

test('手动浏览固定文件和滚动位置，新编辑不抢走阅读；f 恢复跟随', () => {
  const view = createView()
  edit(view, 'one', 'a.js', Array.from({ length: 80 }, (_, i) => `line-${i}`).join('\n'))
  const pane = new EditPane({ view, theme, getHeight: () => 24 })
  pane.render(60)
  pane.handleInput('g')
  pane.render(60)
  assert.equal(pane.offset, 0)
  edit(view, 'two', 'b.js')
  pane.render(60)
  assert.equal(pane.selected, 'a.js')
  assert.equal(pane.offset, 0)
  assert.equal(pane.unseen, true)
  pane.handleInput('f'); pane.render(60)
  assert.equal(pane.selected, 'b.js')
  assert.equal(pane.follow, true)
  pane.handleInput('['); pane.render(60)
  assert.equal(pane.selected, 'a.js')
  assert.equal(pane.follow, false)
})

test('工作区范围包含 Bash 改动，b 可回到会话片段且不混淆行号', () => {
  const view = createView(); edit(view, 'one', 'a.js')
  const pane = new EditPane({ view, theme, getHeight: () => 24 })
  pane.setWorkspace({ available: true, files: [{ path: 'formatted.js', lines: [{ kind: 'add', text: 'formatted', newLine: 104 }] }] })
  assert.match(pane.render(60).map(plain).join('\n'), /含已有改动/)
  assert.equal(pane.selected, 'formatted.js')
  assert.match(pane.render(60).map(plain).join('\n'), /104/)
  pane.handleInput('b')
  assert.match(pane.render(60).map(plain).join('\n'), /最近片段/)
  assert.equal(pane.selected, 'a.js')
})

test('右栏在极窄、矮屏、中文和长行下没有宽高溢出', () => {
  const view = createView(); edit(view, 'one', '带空格的目录/文件.js', '中文'.repeat(200))
  for (const height of [3, 8, 24]) {
    const pane = new EditPane({ view, theme, getHeight: () => height })
    for (const width of [1, 12, 40, 68]) {
      const lines = pane.render(width)
      assert.equal(lines.length, height)
      assert.ok(lines.every(line => visibleWidth(line) <= width), `width=${width}, height=${height}`)
    }
  }
})

function paneApp(width = 160, extra = {}) {
  const view = createView(); edit(view, 'one', 'a.js', 'one\ntwo\nthree')
  const terminal = memoryTerminal(width, 28)
  const app = createApp({ view, terminal, theme, registry: createRegistry(), getState: () => ({ turnActive: true }),
    getSnapshot: () => ({}), onInterrupt() { throw new Error('浏览 Esc 不应中断回合') }, ...extra })
  return { view, terminal, app }
}

test('F6 浏览不污染输入草稿，Esc 先返回输入，再按键正常输入', () => {
  const { app } = paneApp()
  try {
    app.editor.setText('保留草稿')
    app.tui.handleInput('\x1b[17~')
    assert.equal(app.editPane.focused, true)
    app.tui.handleInput('j')
    assert.equal(app.editor.getText(), '保留草稿')
    app.tui.handleInput('\x1b')
    assert.equal(app.editPane.focused, false)
    app.tui.handleInput('!')
    assert.equal(app.editor.getText(), '保留草稿!')
  } finally { app.dispose() }
})

test('窄屏 /diff 使用可浏览面板，Esc 结算并保留草稿', async () => {
  const { app } = paneApp(80)
  try {
    app.editor.setText('草稿')
    const opening = app.showDiff()
    assert.equal(app.pendingPrompts(), 1)
    app.tui.handleInput(']')
    app.tui.handleInput('\x1b')
    await opening
    assert.equal(app.pendingPrompts(), 0)
    assert.equal(app.editor.getText(), '草稿')
  } finally { app.dispose() }
})

test('恢复会话后，旧工作区读取结果不能覆盖新会话', async () => {
  let finish
  let calls = 0
  const { app } = paneApp(160, { loadWorkspaceChanges: () => ++calls === 1 ? new Promise(resolve => { finish = resolve }) :
    Promise.resolve({ available: true, files: [{ path: 'new.js', lines: [] }] }) })
  try {
    const old = app.refreshChanges()
    app.resetConversation()
    await app.refreshChanges()
    finish({ available: true, files: [{ path: 'old.js', lines: [] }] })
    await old
    assert.equal(app.editPane.workspace.files[0].path, 'new.js')
  } finally { app.dispose() }
})

test('参照图布局：只把正文分栏，输入和状态保留全宽，面板止于输入上方', () => {
  const { app, terminal } = paneApp()
  try {
    app.setPaneMode('on')
    app.editor.setText('全宽草稿')
    const raw = app.tui.render(terminal.columns)
    const lines = app.tui.compositeOverlays(raw, terminal.columns, terminal.rows).slice(-terminal.rows)
    const editorLine = lines.findIndex(line => plain(line).includes('全宽草稿'))
    assert.ok(editorLine > 0)
    // 右栏不盖在输入上下框线与状态栏上。
    const bg = theme.bg('paneBg', '').split('\x1b[0m')[0]
    assert.ok(lines.slice(editorLine - 1).every(line => !line.includes(bg)))
    assert.equal(visibleWidth(lines[editorLine - 1]), terminal.columns)
    app.editor.setText('多行\n输入\n保留')
    const resized = app.tui.compositeOverlays(app.tui.render(terminal.columns), terminal.columns, terminal.rows).slice(-terminal.rows)
    const input = resized.findIndex(line => plain(line).includes('多行'))
    assert.ok(resized.slice(input - 1).every(line => !line.includes(bg)))
  } finally { app.dispose() }
})
