/**
 * 会话事件读取测试。
 *
 * 这个模块存在的理由是实测踩到的：**活会话上 `session.events` 是空的**，
 * 必须按序号用 `session.eventAt(seq)` 读。当时底栏取不到真实路由，打日志才
 * 发现 `seq=19` 而 `events.length=0`。
 *
 * 同一处还藏着第二个问题：`kernel.js` 的 resume 用 `agent.session.events`
 * 重放历史——活会话上它也是空的，等于 resume 看不到任何对话。一并修了。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createEventTail, readSessionEvents } from '../src/session-events.js'

/** 活会话：events 为空，只能按序号读。 */
function liveSession(events) {
  return {
    seq: events.length,
    events: [],
    eventAt: (seq) => events[seq],
  }
}

/** 恢复出来的会话：events 本身有内容，没有 eventAt。 */
function restoredSession(events) {
  return { seq: events.length, events }
}

const sample = [
  { seq: 0, type: 'session' },
  { seq: 1, type: 'turn/start' },
  { seq: 2, type: 'request/header' },
]

// ── readSessionEvents ────────────────────────────────────────────────────

test('活会话：按序号逐条读出（events 为空也不受影响）', () => {
  const session = liveSession(sample)
  assert.equal(session.events.length, 0, '前提：活会话的 events 是空的')
  assert.deepEqual(
    readSessionEvents(session).map((e) => e.type),
    ['session', 'turn/start', 'request/header'],
  )
})

test('恢复出来的会话：直接读 events', () => {
  assert.deepEqual(
    readSessionEvents(restoredSession(sample)).map((e) => e.type),
    ['session', 'turn/start', 'request/header'],
  )
})

test('两种形态都给不出事件时返回空数组，不抛错', () => {
  assert.deepEqual(readSessionEvents(undefined), [])
  assert.deepEqual(readSessionEvents(null), [])
  assert.deepEqual(readSessionEvents({}), [])
  assert.deepEqual(readSessionEvents({ seq: 3 }), [])
})

test('个别序号读不出来时跳过，不放弃整次读取', () => {
  const session = {
    seq: 3,
    events: [],
    eventAt: (seq) => {
      if (seq === 1) throw new Error('bad seq')
      return { seq, type: `t${seq}` }
    },
  }
  assert.deepEqual(
    readSessionEvents(session).map((e) => e.type),
    ['t0', 't2'],
  )
})

// ── createEventTail ──────────────────────────────────────────────────────

test('增量读：第一次给出全部，之后只给新增', () => {
  const events = [...sample]
  const session = liveSession(events)
  const tail = createEventTail(session)

  assert.equal(tail().length, 3)
  assert.equal(tail().length, 0, '没有新事件时应当是空的')

  events.push({ seq: 3, type: 'turn/end' })
  session.seq = 4
  assert.deepEqual(
    tail().map((e) => e.type),
    ['turn/end'],
    '只读新追加的那一条',
  )
})

test('增量读在恢复形态下同样工作', () => {
  const events = [...sample]
  const session = restoredSession(events)
  const tail = createEventTail(session)
  assert.equal(tail().length, 3)
  events.push({ seq: 3, type: 'turn/end' })
  session.seq = 4
  assert.deepEqual(
    tail().map((e) => e.type),
    ['turn/end'],
  )
})

test('增量读：seq 回退（换会话）时不会读出错乱的内容', () => {
  const session = liveSession([...sample])
  const tail = createEventTail(session)
  tail()
  session.seq = 1
  assert.deepEqual(tail(), [], 'seq 变小说明换了会话，不该再吐旧游标之后的东西')
})

test('增量读：session 为 undefined 时安全', () => {
  const tail = createEventTail(undefined)
  assert.deepEqual(tail(), [])
})
