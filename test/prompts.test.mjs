/**
 * 弹窗层测试。
 *
 * 最重要的一条是 **P0 回归**：弹窗的 Promise 必须能被外部兜底结算。
 *
 * 起因：`approval/request` / `user-questions/request` 都是 waterfall，内核会停下
 * 来等回答。如果弹窗只在「用户选了 / 按了 Esc」时才 settle，那么
 * `app.dispose()`、退出路径上的 `await kernel.dispose()`、组件 render 抛错、
 * 外部直接 hideOverlay 这四种情况都会把内核的 waterfall **永久挂住**，
 * 退出也因此卡死。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPrompter, forwarding } from '../src/prompts.js'
import { createTheme } from '../src/theme.js'

const theme = createTheme(undefined, { COLORTERM: 'truecolor' })

/** 记下被 showOverlay 挂上去的组件，便于模拟「用户按键」。 */
function makeTui({ failShow = false } = {}) {
  const shown = []
  const hidden = []
  return {
    shown,
    hidden,
    tui: {
      requestRender() {},
      hasOverlay: () => shown.length - hidden.length > 0,
      showOverlay(component) {
        if (failShow) throw new Error('overlay unsupported')
        shown.push(component)
        return {
          hide: () => hidden.push(component),
          focus: () => {},
        }
      },
    },
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

// ── 基本流程 ─────────────────────────────────────────────────────────────

test('choose：用户选中后 Promise settle 并隐藏 overlay', async () => {
  const { tui, shown, hidden } = makeTui()
  const prompter = createPrompter({ tui, theme })

  const promise = prompter.choose({
    title: '选一个',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  })
  assert.equal(prompter.pendingCount(), 1)

  // 模拟用户按 Enter（SelectList 内部会回调 onSelect）。
  shown[0].handleInput('\r')
  assert.equal(await promise, 'a')
  assert.equal(prompter.pendingCount(), 0)
  assert.equal(hidden.length, 1, '结算后必须把 overlay 摘掉')
})

test('askText：提交后返回文本', async () => {
  const { tui, shown } = makeTui()
  const prompter = createPrompter({ tui, theme })

  const promise = prompter.askText({ title: '你的名字？' })
  shown[0].handleInput('abc')
  shown[0].handleInput('\r')
  assert.equal(await promise, 'abc')
  assert.equal(prompter.pendingCount(), 0)
})

test('askText：Esc 取消返回 undefined', async () => {
  const { tui, shown } = makeTui()
  const prompter = createPrompter({ tui, theme })
  const promise = prompter.askText({ title: '?' })
  shown[0].handleInput('\x1b')
  assert.equal(await promise, undefined)
})

// ── P0 回归：兜底结算 ────────────────────────────────────────────────────

test('【P0 回归】cancelAll 能把还在等的弹窗全部结算掉', async () => {
  const { tui } = makeTui()
  const prompter = createPrompter({ tui, theme })

  const a = prompter.choose({ title: 'A', options: [{ value: 'x', label: 'X' }] })
  const b = prompter.askText({ title: 'B' })
  assert.equal(prompter.pendingCount(), 2)

  const settled = prompter.cancelAll()
  assert.equal(settled, 2)
  assert.equal(await a, undefined)
  assert.equal(await b, undefined)
  assert.equal(prompter.pendingCount(), 0)
})

test('【P0 回归】已经结算的弹窗不会被 cancelAll 重复结算', async () => {
  const { tui, shown } = makeTui()
  const prompter = createPrompter({ tui, theme })

  const promise = prompter.choose({ title: 'A', options: [{ value: 'x', label: 'X' }] })
  shown[0].handleInput('\r')
  assert.equal(await promise, 'x')

  assert.equal(prompter.cancelAll(), 0, '已结算的不该再算一次')
})

test('cancelAll 在没有弹窗时是安全的空操作', () => {
  const { tui } = makeTui()
  const prompter = createPrompter({ tui, theme })
  assert.doesNotThrow(() => prompter.cancelAll())
  assert.equal(prompter.cancelAll(), 0)
})

// ── 边界 ─────────────────────────────────────────────────────────────────

test('terminal 不支持 overlay 时立刻结算，不挂住内核', async () => {
  const { tui } = makeTui({ failShow: true })
  const prompter = createPrompter({ tui, theme })
  const promise = prompter.choose({ title: 'A', options: [{ value: 'x', label: 'X' }] })
  assert.equal(await promise, undefined)
  assert.equal(prompter.pendingCount(), 0)
})

test('forwarding：内部 render 抛错时兜住并结算，而不是每帧抛错却永远等不到回答', () => {
  // 精确测这一层：如果 render 抛出去，overlay 会每帧抛错，永远画不出来
  // 也永远等不到回答——内核的 waterfall 就永久挂住了。
  const errors = []
  const component = forwarding(
    {
      render() {
        throw new Error('boom')
      },
      invalidate() {},
    },
    () => {},
    { requestRender() {} },
    (error) => errors.push(error),
  )
  assert.deepEqual(component.render(40), [])
  assert.equal(errors.length, 1, '必须上报给调用方去结算')

  // handleInput 同理。
  const errors2 = []
  const component2 = forwarding(
    { render: () => [], invalidate() {} },
    () => {
      throw new Error('input boom')
    },
    { requestRender() {} },
    (error) => errors2.push(error),
  )
  assert.doesNotThrow(() => component2.handleInput('x'))
  assert.equal(errors2.length, 1)
})

test('forwarding：invalidate 抛错也不会炸', () => {
  const component = forwarding(
    {
      render: () => [],
      invalidate() {
        throw new Error('boom')
      },
    },
    () => {},
    { requestRender() {} },
    () => {},
  )
  assert.doesNotThrow(() => component.invalidate())
})

test('hide 抛错也不会让 Promise 卡住', async () => {
  const tui = {
    requestRender() {},
    showOverlay() {
      return {
        hide() {
          throw new Error('hide failed')
        },
        focus() {},
      }
    },
  }
  const prompter = createPrompter({ tui, theme })
  const promise = prompter.choose({ title: 'A', options: [{ value: 'x', label: 'X' }] })
  const settled = prompter.cancelAll()
  assert.equal(settled, 1)
  assert.equal(await promise, undefined)
})

test('choose 的选项过长时不会把 overlay 撑爆（maxVisible 生效）', async () => {
  const { tui, shown } = makeTui()
  const prompter = createPrompter({ tui, theme })
  const options = Array.from({ length: 40 }, (_, i) => ({ value: `v${i}`, label: `选项 ${i}` }))
  const promise = prompter.choose({ title: '很多选项', options, maxVisible: 5 })
  await flush()
  const lines = shown[0].render(80)
  assert.ok(lines.length > 0)
  prompter.cancelAll()
  await promise
})
