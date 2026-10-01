import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createApp } from '../src/app.js'
import { createBanner } from '../src/banner.js'
import { createTheme } from '../src/theme.js'
import { createRegistry } from '../src/registry.js'
import { createView } from '../src/projection.js'
import { createWorkbench } from '../src/workbench.js'
import { createRuntimeAccess } from '../src/kernel.js'
import { createSessionSwitcher } from '../src/session-switch.js'
import { createFooterInfo } from '../src/footer.js'
import { userRenderer, assistantRenderer } from '../src/messages.js'
import { memoryTerminal } from '../scripts/fixtures.mjs'

const theme = createTheme()
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, '')

test('Ctrl+T 按下切换、长按和松开保持，再按一次才折叠', async () => {
  const registry = createRegistry(), view = createView()
  let workbench
  const app = createApp({ theme, registry, view, terminal: memoryTerminal(), getState: () => ({}), getSnapshot: () => ({}),
    onCommand: () => workbench.execute('thinking', '') })
  workbench = createWorkbench({ app, kernel: { runtime: {} }, registry, view })
  try {
    app.tui.handleInput('\x1b[116;5u')
    assert.equal(registry.display.thinking, true)
    app.tui.handleInput('\x1b[116;5:2u')
    app.tui.handleInput('\x1b[116;5:3u')
    assert.equal(registry.display.thinking, true)
    app.tui.handleInput('\x1b[116;5u')
    assert.equal(registry.display.thinking, false)
    app.tui.handleInput('\x14')
    assert.equal(registry.display.thinking, true)
  } finally { app.dispose() }
})

test('欢迎页包含鲸鱼和恢复入口，输入区无边框外装饰且保留 IME 标记', () => {
  const banner = createBanner({ theme, getSubtitle: () => 'deepseek-flash', getWorkspace: () => '/project' })
  for (const width of [24, 32, 48, 80, 120]) {
    const lines = banner.render(width)
    assert.ok(lines.every((line) => visibleWidth(line) <= width))
    if (width >= 48) assert.match(lines.join('\n'), /\/resume/)
  }
  assert.match(banner.render(80).join('\n'), /▄▄███▄▄/)
  const app = createApp({ theme, registry: createRegistry(), view: createView(), terminal: memoryTerminal(), getState: () => ({}), getSnapshot: () => ({}) })
  try {
    app.editor.setText('中文草稿')
    const lines = app.editor.render(48)
    assert.ok(lines.every((line) => visibleWidth(line) <= 48))
    // pi 式输入框：单线边框、无提示符。
    assert.match(lines.join('\n'), /─/)
    assert.doesNotMatch(lines.join('\n'), /❯/)
    assert.match(lines.join('\n'), /\x1b_pi:c\x07/)
    assert.doesNotMatch(lines.join('\n'), /写下你要做的事|继续输入/)
  } finally { app.dispose() }
})

test('用户与助手靠图层区分：用户是纯底色块，助手无底色且零角色标签', () => {
  const user = userRenderer({ row: { text: '问题' }, theme }).render(80).join('\n')
  const assistant = assistantRenderer({ row: { text: '答案' }, theme }).render(80).join('\n')
  // 用户：整块 userMessageBg 底色，内容保留，且没有任何文字角色标签。
  assert.match(user, /\x1b\[48;/)
  assert.doesNotMatch(plain(user), /❯|你/)
  assert.match(plain(user), /问题/)
  // 助手：无底色、无「● DeepSeek」标签行——分层替代标签。
  assert.doesNotMatch(assistant, /\x1b\[48;/)
  assert.doesNotMatch(plain(assistant), /●|DeepSeek/)
  assert.match(plain(assistant), /答案/)
})

function harness({ prepareError, flushError, active = false, queued = [] } = {}) {
  const operations = []
  const view = createView(); view.rows.push({ key: 'old-row', text: 'old conversation' })
  let current = { sessionId: 'old', agent: { status: active ? 'running' : 'idle' }, runtime: { queue: () => queued },
    async flush(options) { operations.push('flush'); assert.equal(options.strict, true); if (flushError) throw new Error('disk failed') },
    async dispose() { operations.push('dispose-old') },
  }
  const previous = current
  const next = { sessionId: 'new', agent: { status: 'idle' }, attachView(target) { this.view = target }, async dispose() { operations.push('dispose-new') } }
  const switcher = createSessionSwitcher({ ctx: { get: () => undefined }, view, getKernel: () => current,
    async createKernel(options) { operations.push('prepare'); if (prepareError) throw new Error('bad session'); options.view.rows.push({ key: 'new-row', text: 'restored' }); return next },
    onCommit(kernel) { current = kernel; operations.push('commit') },
  })
  return { switcher, view, operations, next, previous, get current() { return current } }
}

test('/resume 先准备并保存，再切换投影与释放旧会话', async () => {
  const h = harness()
  assert.equal(await h.switcher.resume('new'), true)
  assert.deepEqual(h.operations, ['prepare', 'flush', 'commit', 'dispose-old'])
  assert.equal(h.current, h.next)
  assert.equal(h.next.view, h.view)
  assert.deepEqual(h.view.rows.map((row) => row.text), ['restored'])
})

test('/resume 恢复失败保留旧会话和对话；刷盘失败释放候选会话', async () => {
  for (const options of [{ prepareError: true }, { flushError: true }]) {
    const h = harness(options)
    await assert.rejects(h.switcher.resume('new'))
    assert.equal(h.current, h.previous)
    assert.equal(h.view.rows[0].text, 'old conversation')
    assert.ok(!h.operations.includes('dispose-old'))
    if (options.flushError) assert.ok(h.operations.includes('dispose-new'))
    assert.equal(h.switcher.busy, false)
  }
})

test('/resume 不会静默丢弃正在运行或排队中的任务', async () => {
  for (const options of [{ active: true }, { queued: [{ text: 'pending' }] }]) {
    const h = harness(options)
    await assert.rejects(h.switcher.resume('new'))
    assert.deepEqual(h.operations, [])
  }
})

test('会话目录按工作区过滤，排除活跃会话和子 Agent，保留持久标题', async () => {
  const rows = [
    { header: { id: 'a', cwd: '/project', createdAt: 1 }, persisted: true, live: false },
    { header: { id: 'b', cwd: '/elsewhere', createdAt: 2 }, persisted: true, live: false },
    { header: { id: 'live', cwd: '/project' }, persisted: true, live: true },
    { header: { id: 'child', cwd: '/project', origin: 'subagent' }, persisted: true, live: false },
  ]
  const query = { listSessions: async () => rows, readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', sessionId: id, value: { title: { title: '任务 ' + id, updatedAt: 3 } } })) }
  const runtime = createRuntimeAccess({ get: () => query }, () => ({ session: { header: { cwd: '/project' } } }))
  assert.deepEqual((await runtime.sessions()).map((row) => row.id), ['a'])
  assert.equal((await runtime.sessions())[0].title, '任务 a')
  assert.equal((await runtime.sessions({ all: true })).length, 2)
})

test('恢复会话后即使 seq 相同也重新计算用量与工作目录', () => {
  let current = { id: 'a', seq: 10, header: { cwd: '/one' }, used: 123 }
  const info = createFooterInfo({ ctx: { get: (name) => name === 'tokenMeter' ? { measure: (session) => ({ totalTokens: session.used }) } : undefined },
    getAgent: () => ({ session: current }), getSelection: () => undefined })
  assert.equal(info.snapshot().tokens.used, 123)
  current = { id: 'b', seq: 10, header: { cwd: '/two' }, used: 456 }
  const snapshot = info.snapshot()
  assert.equal(snapshot.tokens.used, 456)
  assert.equal(snapshot.dir, 'two')
})
