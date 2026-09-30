/**
 * 投影层测试。
 *
 * 最重要的一条是「回放与实时等价」：这是整个架构的核心不变量。如果它破了，
 * resume / rewind 就会和实时看到的不一样，而且只在特定时序下才暴露。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applySessionEvent, applyStreamFrame, createView, reasoningOfContent, replay, textOfContent } from '../src/projection.js'

// ── 构造测试事件的小工具 ─────────────────────────────────────────────────

const userMessage = (text, seq = 1) => ({
  seq,
  type: 'user/message',
  data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

const assistantMessage = (blocks, seq = 2) => ({
  seq,
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { id: `a${seq}`, role: 'assistant', content: blocks, source: {} } },
})

const textBlock = (text) => ({ type: 'text', text })
const reasoningBlock = (text) => ({ type: 'reasoning', text })

// ── 基础投影 ─────────────────────────────────────────────────────────────

test('textOfContent 只抽取文本块', () => {
  assert.equal(textOfContent([textBlock('a'), { type: 'reasoning', text: 'r' }, textBlock('b')]), 'ab')
  assert.equal(textOfContent(undefined), '')
  assert.equal(textOfContent([null, 42, 'x']), '')
})

test('reasoningOfContent 只抽取推理块', () => {
  assert.equal(reasoningOfContent([reasoningBlock('想'), textBlock('说')]), '想')
})

test('user/message 产生一条用户行', () => {
  const view = createView()
  assert.equal(applySessionEvent(view, userMessage('你好')), true)
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].role, 'user')
  assert.equal(view.rows[0].text, '你好')
  assert.equal(view.rows[0].done, true)
})

test('assistant/message 产生助手行并带推理', () => {
  const view = createView()
  applySessionEvent(view, assistantMessage([reasoningBlock('推理'), textBlock('回答')]))
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].role, 'assistant')
  assert.equal(view.rows[0].text, '回答')
  assert.equal(view.rows[0].reasoning, '推理')
})

test('user/message 兼容 data 被包在 .message 里的形状', () => {
  const view = createView()
  const wrapped = { seq: 1, type: 'user/message', data: { message: { content: [textBlock('包着的')] } } }
  assert.equal(applySessionEvent(view, wrapped), true)
  assert.equal(view.rows[0].text, '包着的')
})

// ── 过程态 vs 提交态 ─────────────────────────────────────────────────────

test('流式帧累积到 streaming，不产生行', () => {
  const view = createView()
  applyStreamFrame(view, { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 })
  applyStreamFrame(view, { type: 'chunk', attemptId: 'a', revision: 1, index: 0, chunk: { type: 'text-delta', index: 0, text: '你' } })
  applyStreamFrame(view, { type: 'chunk', attemptId: 'a', revision: 1, index: 1, chunk: { type: 'text-delta', index: 0, text: '好' } })
  assert.equal(view.rows.length, 0, '流式内容不应立刻变成行')
  assert.equal(view.streaming.text, '你好')
})

test('提交事件优先于流式缓冲：提交后 streaming 清空、只留一条提交行', () => {
  const view = createView()
  applyStreamFrame(view, { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 })
  applyStreamFrame(view, { type: 'chunk', attemptId: 'a', revision: 1, index: 0, chunk: { type: 'text-delta', index: 0, text: '草稿' } })
  applySessionEvent(view, assistantMessage([textBlock('最终')]))
  assert.equal(view.streaming, null)
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].text, '最终')
})

test('没有 start 就来的 chunk 也不会丢字（订阅晚于尝试开始）', () => {
  const view = createView()
  applyStreamFrame(view, { type: 'chunk', attemptId: 'a', revision: 1, index: 0, chunk: { type: 'text-delta', index: 0, text: '迟到' } })
  assert.equal(view.streaming.text, '迟到')
})

test('end 帧在没有提交事件时丢弃残留缓冲', () => {
  const view = createView()
  applyStreamFrame(view, { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 })
  applyStreamFrame(view, { type: 'chunk', attemptId: 'a', revision: 1, index: 0, chunk: { type: 'text-delta', index: 0, text: '半截' } })
  applyStreamFrame(view, { type: 'end', attemptId: 'a', revision: 2, index: 1 })
  assert.equal(view.streaming, null)
  assert.equal(view.rows.length, 0)
})

test('assistant/attempt 清掉流式缓冲但不产生行', () => {
  const view = createView()
  applyStreamFrame(view, { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 })
  applyStreamFrame(view, { type: 'chunk', attemptId: 'a', revision: 1, index: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } })
  applySessionEvent(view, { seq: 3, type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [] } })
  assert.equal(view.streaming, null)
  assert.equal(view.rows.length, 0)
})

// ── 回合状态 ─────────────────────────────────────────────────────────────

test('turn/start 与 turn/end 切换 turnActive 并记录原因', () => {
  const view = createView()
  assert.equal(view.turnActive, false)
  applySessionEvent(view, { seq: 1, type: 'turn/start', data: { turn: 1 } })
  assert.equal(view.turnActive, true)
  applySessionEvent(view, { seq: 9, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(view.turnActive, false)
  assert.deepEqual(view.lastTurnReason, { kind: 'completed' })
})

test('turn/end 会把未提交的流式内容落成一条中断行', () => {
  const view = createView()
  applySessionEvent(view, { seq: 1, type: 'turn/start', data: { turn: 1 } })
  applyStreamFrame(view, { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 })
  applyStreamFrame(view, { type: 'chunk', attemptId: 'a', revision: 1, index: 0, chunk: { type: 'text-delta', index: 0, text: '被打断的输出' } })
  applySessionEvent(view, { seq: 9, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].text, '被打断的输出')
  assert.equal(view.rows[0].interrupted, true)
})

// ── 工具配对 ─────────────────────────────────────────────────────────────

test('tool/call 与 tool/result 配对到同一行', () => {
  const view = createView()
  applySessionEvent(view, { seq: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } })
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].done, false)
  applySessionEvent(view, {
    seq: 2,
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [textBlock('file.txt')] } },
  })
  assert.equal(view.rows.length, 1, '结果应更新既有行，不新增')
  assert.equal(view.rows[0].done, true)
  assert.equal(view.rows[0].text, 'file.txt')
})

test('孤儿 tool/result 补一行而不是丢失', () => {
  const view = createView()
  applySessionEvent(view, {
    seq: 5,
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'never-seen', content: [textBlock('孤儿结果')] } },
  })
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].text, '孤儿结果')
})

// ── 容错 ─────────────────────────────────────────────────────────────────

test('未知事件类型被忽略且不抛错', () => {
  const view = createView()
  assert.equal(applySessionEvent(view, { seq: 1, type: 'third-party/whatever', data: {} }), false)
  assert.equal(applySessionEvent(view, null), false)
  assert.equal(applySessionEvent(view, { type: 'tool/call' }), true, '缺 data 的已知类型也不应崩')
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].toolName, undefined)
})

test('请求构造类事件不产生行', () => {
  const view = createView()
  for (const type of ['request/header', 'request/context', 'step/start', 'step/end', 'system/message']) {
    applySessionEvent(view, { seq: 1, type, data: {} })
  }
  assert.equal(view.rows.length, 0)
})

// ── 核心不变量 ───────────────────────────────────────────────────────────

test('【核心不变量】回放与实时得到完全相同的行', () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    userMessage('第一个问题', 2),
    { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' } },
    { seq: 4, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [textBlock('内容')] } } },
    assistantMessage([reasoningBlock('想一想'), textBlock('第一个回答')], 5),
    { seq: 6, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 7, type: 'turn/start', data: { turn: 2 } },
    userMessage('第二个问题', 8),
    assistantMessage([textBlock('第二个回答')], 9),
    { seq: 10, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]

  // 路径 A：实时（逐条喂进去）
  const live = createView()
  for (const e of events) applySessionEvent(live, e)

  // 路径 B：回放（一次性重建）
  const replayed = replay(createView(), events)

  const shape = (v) => v.rows.map((r) => ({ role: r.role, text: r.text, done: r.done, toolName: r.toolName }))
  assert.deepEqual(shape(replayed), shape(live))
  // 5 行：两个 user、两个 assistant、一个合并后的 tool（call 与 result 同一行）
  assert.equal(replayed.rows.length, 5)
  assert.deepEqual(
    shape(live).map((r) => r.role),
    ['user', 'tool', 'assistant', 'user', 'assistant'],
  )
  assert.equal(live.turnActive, false)
  assert.equal(replayed.turnActive, false)
})

// ── 修复项的回归测试 ─────────────────────────────────────────────────────

test('replay 把 turnActive 归零：历史不代表现在有回合在跑', () => {
  // 日志可能停在 turn/start（上次进程崩在回合中间）。如果 replay 不归零，
  // resume 之后 spinner 会一直转，Ctrl+C 也永远退不出程序。
  const view = replay(createView(), [{ seq: 1, type: 'turn/start', data: { turn: 1 } }])
  assert.equal(view.turnActive, false)
})

test('行有 rev 版本号，被原地更新时自增（渲染层行缓存的依据）', () => {
  const view = createView()
  applySessionEvent(view, { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  assert.equal(view.rows[0].rev, 0, '新插入的行 rev 从 0 开始')

  applySessionEvent(view, {
    seq: 2,
    type: 'tool/result',
    data: { message: { toolCallId: 'c1', content: [textBlock('out')] } },
  })
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].rev, 1, '原地更新必须推进 rev，否则渲染层会一直用缓存')
})
