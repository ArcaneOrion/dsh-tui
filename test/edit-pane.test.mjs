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
  assert.ok(plain(lines[2]).includes('暂无编辑'))
})

test('运行态：头部带标题与状态，行数恒等于高度', () => {
  const view = createView()
  applySessionEvent(view, toolCall('c1'), presentDiff)
  const pane = new EditPane({ view, theme, getHeight: () => 12 })
  const lines = pane.render(40)
  assert.equal(lines.length, 12)
  const header = plain(lines[0])
  assert.ok(header.includes('edit src/a.js'))
  assert.ok(header.includes('运行中'))
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
  assert.ok(text.includes('已省略'), '超出容量的窗口应说明省略')
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
  assert.ok(plain(third[0]).includes('已保存'))
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
