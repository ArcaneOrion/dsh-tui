/**
 * 渲染测试。
 *
 * 这是 pi-tui 路线最实在的红利：组件是 `render(width) → string[]` 的纯函数，
 * 所以**不需要 TTY 就能测**。真实终端里的表现仍要人来验，但宽度约束、缓存、
 * 错误边界、以及"实现点能不能被换掉"全都能在这里钉死。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { visibleWidth } from '@earendil-works/pi-tui'

import { ChatView } from '../src/app.js'
import { installDefaultRenderers } from '../src/messages.js'
import { createView } from '../src/projection.js'
import { createRegistry } from '../src/registry.js'
import { createTheme } from '../src/theme.js'

const theme = createTheme(undefined, { COLORTERM: 'truecolor' })
const WIDTH = 64

function makeRegistry() {
  const registry = createRegistry()
  const dispose = installDefaultRenderers(registry)
  return { registry, dispose }
}

function assertWithinWidth(lines, width, label) {
  lines.forEach((line, i) => {
    const w = visibleWidth(line)
    assert.ok(w <= width, `${label} 第 ${i} 行宽度 ${w} 超过 ${width}：${JSON.stringify(line)}`)
  })
}

// ── 默认渲染器 ───────────────────────────────────────────────────────────

test('五个默认渲染器都能产出宽度受限的行', () => {
  const { registry } = makeRegistry()
  const rows = [
    { key: '1', role: 'user', text: '这是一条用户消息，包含中文和一些 english words 混排', done: true },
    { key: '2', role: 'assistant', text: '# 标题\n\n正文 **粗体** `代码`\n\n- 列表项一\n- 列表项二', done: true },
    { key: '3', role: 'assistant', text: '被中断的回答', reasoning: '很长的推理\n第二行', interrupted: true, done: true },
    { key: '4', role: 'tool', toolName: 'bash', args: '{"command":"ls -la /a/very/long/path/that/keeps/going"}', text: 'file1\nfile2', done: true },
    { key: '5', role: 'tool', toolName: 'read', args: 'not json at all', text: '', done: false },
    { key: '6', role: 'notice', text: '模型已切换', done: true },
  ]

  for (const row of rows) {
    const factory = registry.messageRendererFor(row.role)
    const component = factory({ row, theme, registry })
    assert.equal(typeof component.render, 'function', `${row.role} 渲染器未返回组件`)
    const lines = component.render(WIDTH)
    assert.ok(Array.isArray(lines), `${row.role} render 未返回数组`)
    assertWithinWidth(lines, WIDTH, row.role)
  }
})

test('超长工具结果被截断并提示剩余行数', () => {
  const { registry } = makeRegistry()
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const factory = registry.messageRendererFor('tool')
  const component = factory({ row: { role: 'tool', toolName: 'bash', args: '{}', text: long, done: true }, theme, registry })
  const text = component.render(WIDTH).join('\n')
  assert.match(text, /另有 28 行/)
})

// ── 实现点可替换（本设计的核心主张）─────────────────────────────────────

test('换掉某个角色的渲染器后，ChatView 立刻用新的', () => {
  const { registry } = makeRegistry()
  const view = createView()
  view.rows.push({ key: 'r1', role: 'user', text: 'hello', done: true })

  const chat = new ChatView({ view, theme, registry })
  const before = chat.render(WIDTH).join('\n')
  assert.ok(before.includes('hello'))

  // 这就是「给所有消息加线框」的正确做法：替换渲染器，不 patch 任何原型。
  registry.setMessageRenderer('user', ({ row }) => ({ render: () => [`<<${row.text}>>`] }))
  chat.invalidate()

  const after = chat.render(WIDTH).join('\n')
  assert.ok(after.includes('<<hello>>'), '替换后的渲染器未生效')
  assert.ok(!after.includes('hello\n') || after.includes('<<hello>>'))
})

test('未注册角色回退到 * 兜底，不会渲染成空白', () => {
  const { registry } = makeRegistry()
  const view = createView()
  view.rows.push({ key: 'r1', role: '从来没人注册过的角色', text: '兜底文本', done: true })
  const chat = new ChatView({ view, theme, registry })
  const out = chat.render(WIDTH).join('\n')
  assert.ok(out.includes('兜底文本'))
})

// ── 错误边界 ─────────────────────────────────────────────────────────────

test('渲染器抛错只影响那一行，不拖垮整个界面', () => {
  const { registry } = makeRegistry()
  registry.setMessageRenderer('user', () => {
    throw new Error('boom')
  })
  const view = createView()
  view.rows.push({ key: 'r1', role: 'user', text: 'x', done: true })
  view.rows.push({ key: 'r2', role: 'notice', text: '后面这行必须还在', done: true })

  const chat = new ChatView({ view, theme, registry })
  const out = chat.render(WIDTH).join('\n')
  assert.match(out, /渲染 user 行失败/)
  assert.ok(out.includes('后面这行必须还在'), '一行崩掉不应影响后续行')
})

test('渲染器返回非组件时被安全跳过', () => {
  const { registry } = makeRegistry()
  registry.setMessageRenderer('user', () => null)
  const view = createView()
  view.rows.push({ key: 'r1', role: 'user', text: 'x', done: true })
  const chat = new ChatView({ view, theme, registry })
  assert.doesNotThrow(() => chat.render(WIDTH))
})

// ── 缓存与流式 ───────────────────────────────────────────────────────────

test('视图未变时复用同一帧（pi-tui 的差分渲染依赖这个）', () => {
  const { registry } = makeRegistry()
  const view = createView()
  view.rows.push({ key: 'r1', role: 'user', text: 'hello', done: true })
  const chat = new ChatView({ view, theme, registry })

  const first = chat.render(WIDTH)
  const second = chat.render(WIDTH)
  assert.equal(first, second, '相同输入应返回同一个数组引用')

  view.rows.push({ key: 'r2', role: 'notice', text: 'changed', done: true })
  view.revision += 1
  const third = chat.render(WIDTH)
  assert.notEqual(third, first, '视图变化后必须重算')
})

test('正在流式的文本会出现在输出里，并带光标', () => {
  const { registry } = makeRegistry()
  const view = createView()
  view.streaming = { key: 's1', text: '正在生成的内容', reasoning: '' }
  view.revision += 1
  const chat = new ChatView({ view, theme, registry })
  const out = chat.render(WIDTH).join('\n')
  assert.ok(out.includes('正在生成的内容'))
  assert.ok(out.includes('▌'), '流式行应带光标')
})

test('空视图给出引导文案而不是一片空白', () => {
  const { registry } = makeRegistry()
  const chat = new ChatView({ view: createView(), theme, registry })
  const out = chat.render(WIDTH).join('\n')
  assert.ok(out.includes('开始输入'))
})

test('所有输出路径都满足宽度约束', () => {
  const { registry } = makeRegistry()
  const view = createView()
  view.rows.push({ key: 'r1', role: 'user', text: '中文'.repeat(50), done: true })
  view.rows.push({ key: 'r2', role: 'assistant', text: 'word '.repeat(80), done: true })
  view.streaming = { key: 's1', text: 'x'.repeat(200), reasoning: '' }
  const chat = new ChatView({ view, theme, registry })
  assertWithinWidth(chat.render(40), 40, '窄终端')
  chat.invalidate()
  assertWithinWidth(chat.render(120), 120, '宽终端')
})

// ── 性能回归：流式期间不能全量重建历史 ───────────────────────────────────

test('行级缓存：流式推进 revision 时，已提交的历史行不会被重新渲染', () => {
  const { registry } = makeRegistry()
  let calls = 0
  for (const role of ['user', 'notice']) {
    registry.setMessageRenderer(role, ({ row }) => {
      calls += 1
      return { render: () => [row.text] }
    })
  }

  const view = createView()
  view.rows.push({ key: 'a', role: 'user', text: 'A', rev: 0, done: true })
  view.rows.push({ key: 'b', role: 'notice', text: 'B', rev: 0, done: true })
  const chat = new ChatView({ view, theme, registry })

  chat.render(WIDTH)
  assert.equal(calls, 2, '首次渲染两行')

  // 模拟一个流式 token：revision 推进了，但已提交的行没变。
  // 修复前这里会把两行历史全部重建一遍（行多了就是每个 token 一次全量重渲染）。
  view.revision += 1
  chat.render(WIDTH)
  assert.equal(calls, 2, '帧缓存失效后，历史行应命中行级缓存而不是重建')

  // 只有被改动的那一行该重画。
  view.rows[0].text = 'A2'
  view.rows[0].rev += 1
  view.revision += 1
  const out = chat.render(WIDTH).join('\n')
  assert.equal(calls, 3, '只有变化的那一行应被重渲染')
  assert.ok(out.includes('A2'))
})

test('invalidate() 会清掉行级缓存（换主题后必须全部重画）', () => {
  const { registry } = makeRegistry()
  let calls = 0
  registry.setMessageRenderer('user', ({ row }) => {
    calls += 1
    return { render: () => [row.text] }
  })
  const view = createView()
  view.rows.push({ key: 'a', role: 'user', text: 'A', rev: 0, done: true })
  const chat = new ChatView({ view, theme, registry })

  chat.render(WIDTH)
  assert.equal(calls, 1)
  chat.invalidate()
  view.revision += 1
  chat.render(WIDTH)
  assert.equal(calls, 2, '显式 invalidate 之后必须重画，否则换主题不生效')
})
