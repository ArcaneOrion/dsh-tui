/**
 * 人机回环测试。
 *
 * 这两个 waterfall 是「TUI 能不能干活」的开关：不接，需要授权的工具会
 * fail-closed，模型提问会直接失败。所以它们的每个分支都值得钉死——
 * 尤其是「什么时候应该把请求交回链上」。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installInteractive } from '../src/interactive.js'

/** 捕获 waterfall 处理器的 mock 上下文。 */
function makeCtx() {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      on(event, handler) {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
    },
  }
}

/** 记录在案、可编程的假界面。 */
function makeApp({ choice, text } = {}) {
  const notices = []
  const calls = { choose: 0, askText: 0 }
  return {
    notices,
    calls,
    app: {
      async choose() {
        calls.choose += 1
        return choice
      },
      async askText() {
        calls.askText += 1
        return text
      },
      notice(message) {
        notices.push(message)
      },
    },
  }
}

const nextReturning = (value) => async () => value

// ── 工具授权 ─────────────────────────────────────────────────────────────

test('授权：用户选允许 → allowed-once', async () => {
  const { ctx, handlers } = makeCtx()
  const { app, notices } = makeApp({ choice: 'allowed-once' })
  installInteractive({ ctx, app })
  const outcome = await handlers.get('approval/request')({ toolName: 'bash' }, nextReturning('unavailable'))
  assert.equal(outcome, 'allowed-once')
  assert.match(notices.join('\n'), /已允许/)
})

test('授权：用户选拒绝 → rejected', async () => {
  const { ctx, handlers } = makeCtx()
  const { app } = makeApp({ choice: 'rejected' })
  installInteractive({ ctx, app })
  const outcome = await handlers.get('approval/request')({ toolName: 'bash' }, nextReturning('unavailable'))
  assert.equal(outcome, 'rejected')
})

test('授权：用户按 Esc 取消 → cancelled（不是交回链上）', async () => {
  const { ctx, handlers } = makeCtx()
  const { app } = makeApp({ choice: undefined })
  installInteractive({ ctx, app })
  const outcome = await handlers.get('approval/request')({ toolName: 'bash' }, nextReturning('unavailable'))
  assert.equal(outcome, 'cancelled')
})

test('授权：请求已被取消（signal 已 abort）时不弹窗，直接 cancelled', async () => {
  const { ctx, handlers } = makeCtx()
  const { app, calls } = makeApp({ choice: 'allowed-once' })
  installInteractive({ ctx, app })

  const controller = new AbortController()
  controller.abort()
  const outcome = await handlers.get('approval/request')(
    { toolName: 'bash', signal: controller.signal },
    nextReturning('unavailable'),
  )
  assert.equal(outcome, 'cancelled')
  assert.equal(calls.choose, 0, '已经取消的请求不该再弹窗骚扰用户')
})

test('授权：弹窗抛错时交回链上，而不是假装取消', async () => {
  const { ctx, handlers } = makeCtx()
  const app = {
    choose: async () => {
      throw new Error('overlay exploded')
    },
    askText: async () => undefined,
    notice: () => {},
  }
  installInteractive({ ctx, app })
  const outcome = await handlers.get('approval/request')({ toolName: 'bash' }, nextReturning('unavailable'))
  assert.equal(outcome, 'unavailable', '应让内核按自己的策略处理，而不是替它决定“取消”')
})

test('授权：界面不可用（正在退出）时交回链上', async () => {
  const { ctx, handlers } = makeCtx()
  const { app, calls } = makeApp({ choice: 'allowed-once' })
  installInteractive({ ctx, app, isAvailable: () => false })
  const outcome = await handlers.get('approval/request')({ toolName: 'bash' }, nextReturning('unavailable'))
  assert.equal(outcome, 'unavailable')
  assert.equal(calls.choose, 0)
})

test('授权：displayReason 优先取中文，其次英文，最后回退 reason', async () => {
  const { ctx, handlers } = makeCtx()
  let seen
  const app = {
    choose: async (spec) => {
      seen = spec.detail
      return 'rejected'
    },
    askText: async () => undefined,
    notice: () => {},
  }
  installInteractive({ ctx, app })

  await handlers.get('approval/request')(
    { toolName: 'bash', displayReason: { zh: '中文原因', en: 'english' }, reason: 'raw' },
    nextReturning('unavailable'),
  )
  assert.equal(seen, '中文原因')

  await handlers.get('approval/request')(
    { toolName: 'bash', displayReason: { en: 'english' }, reason: 'raw' },
    nextReturning('unavailable'),
  )
  assert.equal(seen, 'english')

  await handlers.get('approval/request')({ toolName: 'bash', reason: 'raw' }, nextReturning('unavailable'))
  assert.equal(seen, 'raw')
})

// ── 模型提问 ─────────────────────────────────────────────────────────────

test('提问：有选项时返回选中的 label（契约要求 label，不是 value）', async () => {
  const { ctx, handlers } = makeCtx()
  let seenOptions
  const app = {
    choose: async (spec) => {
      seenOptions = spec.options
      return '选项 A'
    },
    askText: async () => undefined,
    notice: () => {},
  }
  installInteractive({ ctx, app })

  const answer = await handlers.get('user-questions/request')(
    { questions: [{ id: 'q1', question: '选哪个？', options: [{ label: '选项 A' }, { label: '选项 B' }] }] },
    nextReturning({ answers: [] }),
  )
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['选项 A'] }] })
  assert.equal(seenOptions.length, 2)
})

test('提问：没有选项时走自由文本，放进 custom', async () => {
  const { ctx, handlers } = makeCtx()
  const { app, calls } = makeApp({ text: '我的回答' })
  installInteractive({ ctx, app })

  const answer = await handlers.get('user-questions/request')(
    { questions: [{ id: 'q1', question: '你的名字？' }] },
    nextReturning({ answers: [] }),
  )
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: [], custom: '我的回答' }] })
  assert.equal(calls.askText, 1)
})

test('提问：多个问题逐个问，全部收进 answers', async () => {
  const { ctx, handlers } = makeCtx()
  let n = 0
  const app = {
    choose: async () => {
      n += 1
      return `选${n}`
    },
    askText: async () => undefined,
    notice: () => {},
  }
  installInteractive({ ctx, app })

  const answer = await handlers.get('user-questions/request')(
    {
      questions: [
        { id: 'q1', question: '一', options: [{ label: 'X' }] },
        { id: 'q2', question: '二', options: [{ label: 'Y' }] },
      ],
    },
    nextReturning({ answers: [] }),
  )
  assert.deepEqual(answer.answers.map((a) => a.id), ['q1', 'q2'])
  assert.deepEqual(answer.answers.map((a) => a.selected[0]), ['选1', '选2'])
})

test('提问：中途取消则整体交回链上，不返回半截答案', async () => {
  const { ctx, handlers } = makeCtx()
  let n = 0
  const app = {
    choose: async () => {
      n += 1
      return n === 1 ? '第一个' : undefined // 第二个问题上取消
    },
    askText: async () => undefined,
    notice: () => {},
  }
  installInteractive({ ctx, app })

  const answer = await handlers.get('user-questions/request')(
    {
      questions: [
        { id: 'q1', question: '一', options: [{ label: 'X' }] },
        { id: 'q2', question: '二', options: [{ label: 'Y' }] },
      ],
    },
    // 链上的兜底答案用的是真契约形状（AskUserQuestionAnswer），不是裸字符串。
    nextReturning({ answers: [{ id: 'from-chain', selected: [] }] }),
  )
  assert.deepEqual(answer, { answers: [{ id: 'from-chain', selected: [] }] }, '半截答案比没答案更糟')
})

test('提问：空问题列表交回链上', async () => {
  const { ctx, handlers } = makeCtx()
  const { app, calls } = makeApp({})
  installInteractive({ ctx, app })
  const answer = await handlers.get('user-questions/request')({ questions: [] }, nextReturning('FALLBACK'))
  assert.equal(answer, 'FALLBACK')
  assert.equal(calls.choose, 0)
})

test('提问：请求已取消时不弹窗', async () => {
  const { ctx, handlers } = makeCtx()
  const { app, calls } = makeApp({ text: 'x' })
  installInteractive({ ctx, app })
  const controller = new AbortController()
  controller.abort()
  const answer = await handlers.get('user-questions/request')(
    { questions: [{ id: 'q1', question: '?' }], signal: controller.signal },
    nextReturning('FALLBACK'),
  )
  assert.equal(answer, 'FALLBACK')
  assert.equal(calls.askText, 0)
})

// ── P0 回归：取消时必须撤掉已弹出的框 ───────────────────────────────────

test('【P0 回归】审批请求被取消时，已弹出的框必须被撤掉', async () => {
  // 否则它会变成僵尸模态框：继续吃按键，而回合已经结束，Esc 被应用级监听
  // 当成「中断回合」消费掉，用户根本关不掉它。
  const { ctx, handlers } = makeCtx()
  const controller = new AbortController()
  let cancelCalls = 0
  const app = {
    choose: () => new Promise(() => {}), // 永不 settle：模拟用户还没选
    askText: async () => undefined,
    notice: () => {},
    cancelPrompts: () => {
      cancelCalls += 1
    },
  }
  installInteractive({ ctx, app })

  const pending = handlers.get('approval/request')(
    { toolName: 'bash', signal: controller.signal },
    nextReturning('unavailable'),
  )
  controller.abort()
  assert.equal(await pending, 'cancelled')
  assert.equal(cancelCalls, 1, '必须主动撤框')
})

test('【P0 回归】提问请求被取消时，已弹出的框也必须被撤掉', async () => {
  const { ctx, handlers } = makeCtx()
  const controller = new AbortController()
  let cancelCalls = 0
  const app = {
    choose: () => new Promise(() => {}),
    askText: async () => undefined,
    notice: () => {},
    cancelPrompts: () => {
      cancelCalls += 1
    },
  }
  installInteractive({ ctx, app })

  const pending = handlers.get('user-questions/request')(
    { questions: [{ id: 'q1', question: '?', options: [{ label: 'A' }] }], signal: controller.signal },
    nextReturning({ answers: [] }),
  )
  controller.abort()
  await pending
  assert.equal(cancelCalls, 1)
})

test('审批信号取消时，撤框失败也不能让内核继续等', async () => {
  const { ctx, handlers } = makeCtx()
  const controller = new AbortController()
  const app = {
    choose: () => new Promise(() => {}),
    askText: async () => undefined,
    notice: () => {},
    cancelPrompts: () => {
      throw new Error('撤框失败')
    },
  }
  installInteractive({ ctx, app })

  const pending = handlers.get('approval/request')(
    { toolName: 'bash', signal: controller.signal },
    nextReturning('unavailable'),
  )
  controller.abort()
  assert.equal(await pending, 'cancelled')
})

// ── 卸载 ─────────────────────────────────────────────────────────────────

test('卸载后两个 waterfall 都不再被认领', () => {
  const { ctx, handlers } = makeCtx()
  const { app } = makeApp({})
  const uninstall = installInteractive({ ctx, app })
  assert.equal(handlers.size, 2)
  uninstall()
  assert.equal(handlers.size, 0)
})
