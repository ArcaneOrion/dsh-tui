/**
 * 启动身份判定测试。
 *
 * 这条逻辑看着简单，但它决定「本前端会不会去污染一个非终端宿主」。
 * 你之前把 dsh-tui 装在 web profile 里没出事，靠的就是同类判定。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { HostMode, resolveHostMode } from '../src/host.js'

test('两端都是 TTY → interactive', () => {
  const r = resolveHostMode({ stdoutIsTTY: true, stdinIsTTY: true, env: {} })
  assert.equal(r.mode, HostMode.INTERACTIVE)
})

test('stdout 是管道 → not-a-tty', () => {
  const r = resolveHostMode({ stdoutIsTTY: false, stdinIsTTY: true, env: {} })
  assert.equal(r.mode, HostMode.NOT_A_TTY)
  assert.match(r.reason, /stdout/)
})

test('stdin 不是 TTY → not-a-tty', () => {
  const r = resolveHostMode({ stdoutIsTTY: true, stdinIsTTY: false, env: {} })
  assert.equal(r.mode, HostMode.NOT_A_TTY)
  assert.match(r.reason, /stdin/)
})

test('两者都不是 TTY（Web/GUI 宿主）→ not-a-tty', () => {
  const r = resolveHostMode({ stdoutIsTTY: undefined, stdinIsTTY: undefined, env: {} })
  assert.equal(r.mode, HostMode.NOT_A_TTY)
})

test('DSH_TUI_FORCE_TTY=1 可强制挂载（pty 测试用）', () => {
  const r = resolveHostMode({ stdoutIsTTY: false, stdinIsTTY: false, env: { DSH_TUI_FORCE_TTY: '1' } })
  assert.equal(r.mode, HostMode.INTERACTIVE)
})

test('判定永不抛错（一个前门插件不该拖垮整棵组合树）', () => {
  assert.doesNotThrow(() => resolveHostMode({ stdoutIsTTY: false, stdinIsTTY: false, env: {} }))
})
