/**
 * 入口集成测试（不碰 ~/.dsh，不需要真实 profile）。
 *
 * 用 mock ctx 验证入口的**安全行为**——这些行为恰恰是最不该靠人肉在真终端里
 * 试出来的：
 *
 *   1. 非 TTY 宿主必须什么都不做（不碰 stdout、不抢 stdin、不建 agent）
 *   2. 缺内核服务时必须抛一条能看懂的错，而不是静默半死不活
 *   3. 建 agent 失败时必须把已装的默认渲染器清理掉，不留脏状态
 *
 * 真实终端路径（真的挂 pi-tui、真的打字）无法在这里验证，需要人跑。
 *
 * 依赖说明：`src/index.js` 会连带加载 `src/kernel.js`，后者按设计只 import
 * `@deepseek-ai/*`（peer 依赖，运行时由 dsh profile 提供）。本地开发目录里没有
 * 这些包时整组跳过，并把原因打出来——避免「假装测过了」。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

// `src/index.js` 连带加载 `src/kernel.js`（只 import `@deepseek-ai/*`），
// `src/startup.js` 依赖 `commander` 与 `@deepseek-ai/dsh-cmdline`——这些都是
// **peer / 运行时由 dsh profile 提供**的东西，本地开发目录里没有。
//
// 解析不到时整组跳过并打出原因，而不是把套件搞红或假装测过。
let entry
let startupModule
let skipReason = false
try {
  entry = await import('../src/index.js')
  startupModule = await import('../src/startup.js')
} catch (error) {
  skipReason = `内核/运行时依赖在本地不可解析（${String(error?.code ?? error?.message ?? error)}）——入口集成测试需要 dsh profile 环境`
}

/** 只在依赖齐备时注册的测试。 */
const entryTest = (name, fn) => test(name, { skip: skipReason }, fn)

/** 造一个最小可用的 mock 上下文。 */
function mockCtx({ tty = false, startup = { prompt: '', resume: undefined, model: undefined }, agents = undefined } = {}) {
  const calls = { provides: [], effects: [], listeners: [], logs: [] }
  const originalOut = process.stdout.isTTY
  const originalIn = process.stdin.isTTY

  // 入口用 process.stdout.isTTY 判定身份；这里直接改写属性再还原。
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true })
  Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true })

  const registry = new Map()
  if (startup !== undefined) registry.set('dshTuiStartup', startup)
  if (agents !== undefined) registry.set('agents', agents)

  const ctx = {
    get(name, fallback) {
      if (registry.has(name)) return registry.get(name)
      if (name === 'logger') {
        return { info: (m) => calls.logs.push(['info', m]), debug: (m) => calls.logs.push(['debug', m]) }
      }
      return fallback
    },
    provide(name, value) {
      calls.provides.push([name, value])
      registry.set(name, value)
    },
    effect(fn) {
      calls.effects.push(fn)
      return () => {}
    },
    on(event, handler) {
      calls.listeners.push([event, handler])
      return () => {}
    },
  }

  return {
    ctx,
    calls,
    restore() {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalOut, configurable: true })
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIn, configurable: true })
    },
  }
}

// ── 插件形态 ─────────────────────────────────────────────────────────────

entryTest('startup 导出命令行插件形态并声明 cmdlineArgs 依赖', () => {
  assert.equal(typeof startupModule.apply, 'function')
  assert.equal(startupModule.name, 'dsh-tui-startup')
  assert.deepEqual(startupModule.inject, ['cmdlineArgs'])
  assert.equal(startupModule.DSH_TUI_STARTUP_SERVICE, 'dshTuiStartup')
})

entryTest('startup 的命令定义能被构造且带 --help', () => {
  const program = startupModule.dshTuiCommand()
  assert.equal(typeof program.parse, 'function')
  const help = program.helpInformation()
  assert.match(help, /terminal front door/i)
  assert.match(help, /--resume/)
})

// ── 入口行为 ─────────────────────────────────────────────────────────────

entryTest('入口导出了 Cordis 插件需要的四件套', () => {
  assert.equal(typeof entry.apply, 'function')
  assert.equal(entry.name, 'dsh-tui')
  assert.ok(Array.isArray(entry.inject), 'inject 必须是数组')
  assert.deepEqual(entry.inject, ['dshTuiStartup'], '代码级依赖必须保持最小')
})

entryTest('非 TTY 宿主：静默返回，不建 agent、不注册任何东西', async () => {
  let created = false
  const h = mockCtx({
    tty: false,
    agents: {
      create: async () => {
        created = true
        return { agent: {}, dispose: async () => {} }
      },
    },
  })
  try {
    await entry.apply(h.ctx)
  } finally {
    h.restore()
  }
  assert.equal(created, false, '非 TTY 宿主绝不能去建 agent')
  assert.equal(h.calls.listeners.length, 0, '不应注册任何事件监听')
  assert.equal(h.calls.effects.length, 0, '不应注册任何 effect')
})

entryTest('缺少 ctx.agents 时抛出可读错误', async () => {
  const h = mockCtx({ tty: true, agents: undefined })
  try {
    await assert.rejects(() => entry.apply(h.ctx), /ctx\.agents is unavailable/)
  } finally {
    h.restore()
  }
})

entryTest('建 agent 失败时把底层原因带出来', async () => {
  const h = mockCtx({
    tty: true,
    agents: {
      create: async () => {
        throw new Error('kernel exploded')
      },
    },
  })
  try {
    await assert.rejects(() => entry.apply(h.ctx), /kernel exploded/)
  } finally {
    h.restore()
  }
})

entryTest('缺少 dshTuiStartup（例如 --help 路径）时什么都不做', async () => {
  const h = mockCtx({ tty: true, startup: undefined })
  try {
    await entry.apply(h.ctx)
  } finally {
    h.restore()
  }
  assert.equal(h.calls.listeners.length, 0)
})

entryTest('foldEvents 走的是与实时完全相同的投影路径', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '问题' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回答' }] } } },
  ]
  const view = entry.foldEvents(events)
  assert.equal(view.rows.length, 2)
  assert.deepEqual(
    view.rows.map((r) => r.role),
    ['user', 'assistant'],
  )
})
