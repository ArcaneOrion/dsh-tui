/**
 * 注册表测试 —— 保住「每个界面区域都可整体替换」这条契约。
 *
 * 这些测试的意义不只是防回归：它们把「实现点」的存在变成了可执行的事实。
 * 如果哪天有人把某个区域改成写死的常量，这里会红。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRegistry, MessageRole, WidgetPlacement } from '../src/registry.js'

test('setHeader 返回的 disposer 会还原上一个实现', () => {
  const registry = createRegistry()
  const first = { render: () => ['A'] }
  const second = { render: () => ['B'] }

  const undoFirst = registry.setHeader(first)
  assert.equal(registry.header, first)
  const undoSecond = registry.setHeader(second)
  assert.equal(registry.header, second)
  undoSecond()
  assert.equal(registry.header, first, '撤销应还原到上一个，而不是清空')
  undoFirst()
  assert.equal(registry.header, undefined)
})

test('setFooter / setEditor / setWorkingIndicator 都可替换可撤销', () => {
  const registry = createRegistry()
  const footer = { render: () => [] }
  const undoFooter = registry.setFooter(footer)
  assert.equal(registry.footer, footer)
  undoFooter()
  assert.equal(registry.footer, undefined)

  const factory = () => ({ render: () => [] })
  const undoEditor = registry.setEditor(factory)
  assert.equal(registry.editorFactory, factory)
  undoEditor()
  assert.equal(registry.editorFactory, undefined)

  const undoIndicator = registry.setWorkingIndicator({ frames: ['*'] })
  assert.deepEqual(registry.workingIndicator, { frames: ['*'] })
  undoIndicator()
  assert.equal(registry.workingIndicator, undefined)
})

test('消息渲染器按角色取用，并有 * 兜底', () => {
  const registry = createRegistry()
  const assistant = () => ({ render: () => ['assistant'] })
  const fallback = () => ({ render: () => ['fallback'] })

  registry.setMessageRenderer(MessageRole.ASSISTANT, assistant)
  registry.setMessageRenderer('*', fallback)

  assert.equal(registry.messageRendererFor(MessageRole.ASSISTANT), assistant)
  assert.equal(registry.messageRendererFor(MessageRole.TOOL), fallback, '未注册的角色应回退到 *')
  assert.equal(registry.messageRendererFor('完全没听过'), fallback)
})

test('替换同一角色的渲染器后，撤销还原到前一个', () => {
  const registry = createRegistry()
  const a = () => ({ render: () => ['a'] })
  const b = () => ({ render: () => ['b'] })
  const undoA = registry.setMessageRenderer('user', a)
  const undoB = registry.setMessageRenderer('user', b)
  assert.equal(registry.messageRendererFor('user'), b)
  undoB()
  assert.equal(registry.messageRendererFor('user'), a)
  undoA()
  assert.equal(registry.messageRendererFor('user'), undefined, '没有剩余实现时应回到未注册')
})

test('非法参数抛错而不是静默吞掉（第一方内部接口不该宽容）', () => {
  const registry = createRegistry()
  assert.throws(() => registry.setStatus('', 'x'))
  assert.throws(() => registry.setWidget('', ['x']))
  assert.throws(() => registry.setMessageRenderer('user', 'not a function'))
})

test('状态片段按 order 排序，移除后消失', () => {
  const registry = createRegistry()
  registry.setStatus('b', 'BBB', { order: 2 })
  registry.setStatus('a', 'AAA', { order: 1 })
  registry.setStatus('c', 'CCC', { order: 3 })
  assert.deepEqual(registry.statusTexts(), ['AAA', 'BBB', 'CCC'])
  registry.setStatus('b', undefined)
  assert.deepEqual(registry.statusTexts(), ['AAA', 'CCC'])
})

test('挂件按落点分开，编辑器上下互不干扰', () => {
  const registry = createRegistry()
  registry.setWidget('up', ['UP'])
  registry.setWidget('down', ['DOWN'], { placement: WidgetPlacement.BELOW_EDITOR })
  assert.deepEqual(
    registry.widgetList(WidgetPlacement.ABOVE_EDITOR).map((w) => w.component),
    [['UP']],
  )
  assert.deepEqual(
    registry.widgetList(WidgetPlacement.BELOW_EDITOR).map((w) => w.component),
    [['DOWN']],
  )
})

test('任何变更都会通知订阅者，退订后不再通知', () => {
  const registry = createRegistry()
  let count = 0
  const unsubscribe = registry.subscribe(() => {
    count += 1
  })

  registry.setStatus('x', '1')
  registry.setHeader({ render: () => [] })
  assert.equal(count, 2)

  unsubscribe()
  registry.setStatus('y', '2')
  assert.equal(count, 2, '退订后不应再收到通知')
})

test('revision 单调递增，可作为组件缓存键', () => {
  const registry = createRegistry()
  const before = registry.revision
  registry.setStatus('k', 'v')
  assert.ok(registry.revision > before)
})
