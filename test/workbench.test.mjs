import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createApp } from '../src/app.js'
import { createRegistry } from '../src/registry.js'
import { createView, applySessionEvent } from '../src/projection.js'
import { createTheme } from '../src/theme.js'
import { createPrompter } from '../src/prompts.js'
import { DocumentView } from '../src/document.js'
import { createFooterInfo, DefaultFooter } from '../src/footer.js'
import { createKernel, createRuntimeAccess } from '../src/kernel.js'
import { createNativeMentionAutocomplete } from '../src/mentions.js'
import { createWorkbench } from '../src/workbench.js'
import { memoryTerminal } from '../scripts/fixtures.mjs'

const theme = createTheme()
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, '')

test('真实 app 更新调用链复用历史行，输入中的草稿不被状态更新清空', () => {
  const registry = createRegistry(), view = createView()
  let count = 0
  registry.setMessageRenderer('user', ({ row }) => ({ render() { count++; return [row.text] } }))
  for (let i = 0; i < 100; i++) view.rows.push({ key: String(i), role: 'user', text: 'history', rev: 0 })
  const app = createApp({ view, theme, registry, terminal: memoryTerminal(), getState: () => ({}), getSnapshot: () => ({}) })
  try {
    app.editor.setText('还没有发送的草稿')
    app.tui.render(100)
    view.revision++
    app.requestRender()
    app.tui.render(100)
    assert.equal(count, 100)
    registry.setStatus('live', 'working')
    app.tui.render(100)
    assert.equal(count, 100)
    assert.equal(app.editor.getText(), '还没有发送的草稿')
  } finally { app.dispose() }
})

test('底栏在缩窄和切换分支后更新，所有输出仍在字符宽度内', () => {
  let state = { model: 'model', dir: 'repo', branch: 'main', sandbox: 'read-only', tokens: { used: 1000, limit: 10000 } }
  const footer = new DefaultFooter({ theme, registry: createRegistry(), getSnapshot: () => state })
  footer.render(120)
  state = { ...state, branch: 'fix' }
  const lines = footer.render(48)
  assert.ok(lines.every((line) => visibleWidth(line) <= 48))
  assert.match(lines.map(plain).join('\n'), /fix/)
  assert.match(lines.map(plain).join('\n'), /read-only/)
  assert.match(lines.map(plain).join('\n'), /10.0%/)
})

test('切换模型时立即移除旧窗口，异步返回顺序不会覆盖新模型容量', async () => {
  const pending = new Map()
  let selection = { provider: 'p', model: 'large' }
  const info = createFooterInfo({ ctx: { get: (name) => name === 'llm' ? {
    resolveModelInfo: (provider, model) => new Promise((resolve) => pending.set(model, resolve)),
  } : name === 'tokenMeter' ? { measure: () => ({ totalTokens: 16000 }) } : undefined },
  getAgent: () => ({ session: { seq: 1 } }), getSelection: () => selection })
  const large = info.warmUp()
  await Promise.resolve()
  selection = { provider: 'p', model: 'small' }
  const small = info.warmUp()
  await Promise.resolve()
  assert.equal(info.snapshot().tokens.limit, undefined)
  pending.get('small')({ contextWindow: 32000 }); await small
  pending.get('large')({ contextWindow: 1000000 }); await large
  assert.equal(info.snapshot().tokens.limit, 32000)
})

test('替换事件不追加人类回复，上下文来源与图片输入有明确表示', () => {
  const view = createView()
  const event = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'original' }] } } }
  applySessionEvent(view, { ...event, surfaceOp: 'append' })
  applySessionEvent(view, { ...event, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } })
  assert.equal(view.rows.length, 1)
  applySessionEvent(view, { type: 'user/message', data: { content: [{ type: 'text', text: 'instructions' }], source: { kind: 'agent-instructions', form: 'instructions' } } })
  assert.equal(view.rows.at(-1).role, 'context')
  applySessionEvent(view, { type: 'user/message', data: { content: [{ type: 'image' }] } })
  assert.match(view.rows.at(-1).text, /图片/)
})

test('嵌套插件乱序卸载不会清掉后注册者或复活旧实现', () => {
  const registry = createRegistry()
  const a = { render: () => ['A'] }, b = { render: () => ['B'] }
  const undoA = registry.setFooter(a), undoB = registry.setFooter(b)
  undoA(); assert.equal(registry.footer, b)
  undoB(); assert.equal(registry.footer, undefined)
  undoA(); assert.equal(registry.footer, undefined)
  const first = registry.setStatus('x', 'A'), second = registry.setStatus('x', 'B')
  first(); second(); assert.deepEqual(registry.statusTexts(), [])
})

test('独立取消审批弹窗不会关闭另一个工作台面板', async () => {
  const shown = [], hidden = []
  const tui = { requestRender() {}, showOverlay(component) { shown.push(component); return { hide() { hidden.push(component) } } } }
  const prompts = createPrompter({ theme, tui })
  const controller = new AbortController()
  const approval = prompts.choose({ title: '审批', options: [{ value: 'a', label: '允许' }], signal: controller.signal })
  const other = prompts.document({ title: '上下文', text: 'context' })
  controller.abort()
  assert.equal(await approval, undefined)
  assert.equal(prompts.pendingCount(), 1)
  assert.equal(hidden.length, 1)
  shown[1].handleInput('\x1b')
  assert.equal(await other, true)
})

test('全文视图能滚动到末尾，中文窄窗口不溢出', () => {
  const document = new DocumentView({ title: '输出', text: Array.from({ length: 90 }, (_, i) => `第 ${i} 行 中文`).join('\n'), theme, getHeight: () => 24 })
  document.render(40)
  document.handleInput('G')
  const lines = document.render(40)
  assert.ok(lines.every((line) => visibleWidth(line) <= 40))
  assert.match(lines.map(plain).join('\n'), /第 89 行/)
})

test('活跃回合中 Esc 优先关闭面板，不中断 Agent，不丢失草稿', async () => {
  let interrupted = 0
  const app = createApp({ theme, registry: createRegistry(), view: createView(), terminal: memoryTerminal(),
    getState: () => ({ turnActive: true }), getSnapshot: () => ({}), onInterrupt: () => interrupted++ })
  try {
    app.editor.setText('draft')
    const promise = app.document({ title: '详情', text: 'content' })
    app.tui.handleInput('\x1b')
    await promise
    assert.equal(interrupted, 0)
    assert.equal(app.editor.getText(), 'draft')
    app.tui.handleInput('\x1b')
    assert.equal(interrupted, 1)
  } finally { app.dispose() }
})

test('内核三种输入各自调用原生方法，查看上下文不触发组装或执行', async () => {
  const calls = [], listeners = []
  const agent = { id: 'session-test', session: { id: 'session-test', deriveMessages: () => [{ id: 's', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'actual' }] }] },
    followup: (message) => calls.push(['followup', message]), steer: (message) => calls.push(['steer', message]), inject: (message) => calls.push(['inject', message]) }
  const ctx = { agents: { create: async () => ({ agent, dispose() {} }) }, get: () => undefined, on: (name, handler) => { listeners.push(name); return () => {} } }
  const kernel = await createKernel({ ctx, view: createView(), startup: {}, onUpdate() {} })
  try {
    kernel.submit('task'); kernel.submit('steering', { delivery: 'steer' }); kernel.submit('context', { delivery: 'inject' })
    assert.deepEqual(calls.map(([kind]) => kind), ['followup', 'steer', 'inject'])
    assert.equal(kernel.runtime.context()[0].text, 'actual')
    assert.equal(calls.length, 3)
  } finally { await kernel.dispose() }
})

test('原生文件补全保留带空格路径的引号', async () => {
  const runtime = createRuntimeAccess({ get: () => ({ list: async () => [{ path: 'docs/my file.md', kind: 'file' }] }) }, () => ({}))
  const completion = createNativeMentionAutocomplete({ runtime })
  const found = await completion.getSuggestions(['阅读 @docs/'], 0, 9)
  assert.equal(found.items[0].value, '@"docs/my file.md"')
})

test('工作台 /inject 将补充材料送到原生 inject', async () => {
  const calls = []
  const app = { notice() {}, requestRender() {}, choose: async () => undefined }
  const workbench = createWorkbench({ app, kernel: { runtime: {}, submit: (...args) => calls.push(args) }, view: createView(), registry: createRegistry() })
  await workbench.execute('inject', '补充约束')
  assert.deepEqual(calls, [['补充约束', { delivery: 'inject' }]])
})
