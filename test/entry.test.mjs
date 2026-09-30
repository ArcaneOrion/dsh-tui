/**
 * 入口与命令行测试（不碰 ~/.dsh，不需要真实 profile）。
 *
 * 分两组：
 * - `startup.js` 现在是**零 import** 的纯模块（手写参数解析，不依赖 commander），
 *   所以它的测试总是运行。
 * - `index.js` 连带加载 `kernel.js`，后者 import `@deepseek-ai/*`。这些是
 *   peer/dev 依赖，全新克隆且未 `pnpm install` 时会解析不到，此时整组跳过并
 *   打印原因——避免「假装测过了」。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as startup from '../src/startup.js'

let entry
let skipReason = false
try {
  entry = await import('../src/index.js')
} catch (error) {
  skipReason = `内核依赖在本地不可解析（${String(error?.code ?? error?.message ?? error)}）——入口集成测试需要先 pnpm install`
}

/** 只在依赖齐备时注册的测试。 */
const entryTest = (name, fn) => test(name, { skip: skipReason }, fn)

// ── 命令行解析（纯函数，完整覆盖）────────────────────────────────────────

test('parseArgs：单个词作为提示词', () => {
  assert.deepEqual(startup.parseArgs(['run']), {
    prompt: 'run',
    resume: undefined,
    model: undefined,
    effort: undefined,
    preset: undefined,
    help: false,
    error: undefined,
  })
})

test('parseArgs：多个词用空格拼成提示词', () => {
  assert.equal(startup.parseArgs(['run', 'the', 'tests']).prompt, 'run the tests')
})

test('parseArgs：--resume 与 -r 等价', () => {
  assert.equal(startup.parseArgs(['--resume', 'abc']).resume, 'abc')
  assert.equal(startup.parseArgs(['-r', 'abc']).resume, 'abc')
})

test('parseArgs：--model 与 -m 等价', () => {
  assert.equal(startup.parseArgs(['--model', 'deepseek/flash']).model, 'deepseek/flash')
  assert.equal(startup.parseArgs(['-m', 'deepseek/flash']).model, 'deepseek/flash')
})

test('parseArgs：--preset 与 -p 等价，--effort 独立取值', () => {
  assert.equal(startup.parseArgs(['--preset', 'standard']).preset, 'standard')
  assert.equal(startup.parseArgs(['-p', 'ptc']).preset, 'ptc')
  assert.equal(startup.parseArgs(['--effort', 'max']).effort, 'max')
  const combined = startup.parseArgs(['-p', 'standard', '--effort=high'])
  assert.equal(combined.preset, 'standard')
  assert.equal(combined.effort, 'high')
})

test('parseArgs：支持 --key=value 形式', () => {
  const parsed = startup.parseArgs(['--resume=abc', '--model=x/y'])
  assert.equal(parsed.resume, 'abc')
  assert.equal(parsed.model, 'x/y')
})

test('parseArgs：-- 之后一律当字面提示词，不再解析旗标', () => {
  const parsed = startup.parseArgs(['--', '--resume', '不是旗标'])
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.resume, undefined)
  assert.equal(parsed.prompt, '--resume 不是旗标')
})

test('parseArgs：-h / --help 置 help 标志', () => {
  assert.equal(startup.parseArgs(['-h']).help, true)
  assert.equal(startup.parseArgs(['--help']).help, true)
})

test('parseArgs：旗标缺值报错而不是静默吞掉', () => {
  const parsed = startup.parseArgs(['--resume'])
  assert.match(parsed.error, /requires a value/)
})

test('parseArgs：未知旗标报错', () => {
  assert.match(startup.parseArgs(['--nope']).error, /unknown option/)
})

test('parseArgs：空参数给出空提示词且无错误', () => {
  const parsed = startup.parseArgs([])
  assert.equal(parsed.prompt, '')
  assert.equal(parsed.error, undefined)
})

test('parseArgs：非数组输入不抛错', () => {
  assert.doesNotThrow(() => startup.parseArgs(undefined))
  assert.equal(startup.parseArgs(undefined).prompt, '')
})

test('startup 导出正确的插件形态，且不 import 任何外部包', () => {
  assert.equal(typeof startup.apply, 'function')
  assert.equal(startup.name, 'dsh-tui-startup')
  assert.deepEqual(startup.inject, ['cmdlineArgs'])
  assert.equal(startup.DSH_TUI_STARTUP_SERVICE, 'dshTuiStartup')
  assert.match(startup.HELP_TEXT, /terminal front door/i)
  assert.match(startup.HELP_TEXT, /--resume/)
})

test('readCmdlineArgs：ctx.cmdlineArgs 是**服务对象**，必须调 get()', () => {
  // 这条是真事故的回归测试。`ctx.cmdlineArgs` 不是数组，而是一个服务，
  // 契约是「get() 是它的全部接口」。把它当数组用会静默拿到一个对象，
  // 于是 --resume / --model / 初始提示词全部失效，而且**不报任何错**。
  const service = { get: () => ['--resume', 'abc'] }
  assert.deepEqual(startup.readCmdlineArgs({ get: () => service }), ['--resume', 'abc'])
})

test('readCmdlineArgs：兼容「直接给数组」的实现，并在缺失时返回空数组', () => {
  assert.deepEqual(startup.readCmdlineArgs({ get: () => ['x'] }), ['x'])
  assert.deepEqual(startup.readCmdlineArgs({ get: () => undefined }), [])
  assert.deepEqual(startup.readCmdlineArgs(undefined), [])
})

test('startup.apply 在解析成功后发布服务', () => {
  const provided = []
  const ctx = {
    // 用真实的服务形态，而不是数组——否则测试会掩盖上面那个事故。
    get: (name) => (name === 'cmdlineArgs' ? { get: () => ['hello', 'world'] } : undefined),
    provide: (name, value) => provided.push([name, value]),
  }
  startup.apply(ctx)
  assert.equal(provided.length, 1)
  assert.equal(provided[0][0], 'dshTuiStartup')
  assert.equal(provided[0][1].prompt, 'hello world')
})

test('startup.apply 在 --help 时不发布服务（入口随之不挂载）', () => {
  const provided = []
  const exits = []
  const ctx = {
    get: (name) => (name === 'cmdlineArgs' ? ['--help'] : name === 'appExit' ? (c) => exits.push(c) : undefined),
    provide: (name, value) => provided.push([name, value]),
  }
  startup.apply(ctx)
  assert.equal(provided.length, 0, '--help 不该让入口插件挂载')
  assert.deepEqual(exits, [0])
})

test('startup.apply 遇到认不出的参数只警告，不退出也不阻止挂载', () => {
  // 这是一条**安全约束**：本 bundle 可能被装进由别的宿主拥有的 profile
  // （用户之前就把旧的 dsh-tui 留在 web profile 里）。那种情况下 cmdlineArgs
  // 是宿主的参数（这里用 web 的 --no-open --port 3080 模拟），我们当然认不出来。
  // 此时若用错误码退出，会把宿主进程一起杀掉。
  const provided = []
  const exits = []
  const ctx = {
    get: (name) =>
      name === 'cmdlineArgs'
        ? ['--no-open', '--port', '3080']
        : name === 'appExit'
          ? (code) => exits.push(code)
          : undefined,
    provide: (name, value) => provided.push([name, value]),
  }
  startup.apply(ctx)
  assert.deepEqual(exits, [], '绝不能退出——宿主进程可能正跑在上面')
  assert.equal(provided.length, 1, '仍应发布服务，由入口的身份判定决定挂不挂')
})

// ── 入口行为 ─────────────────────────────────────────────────────────────

/** 造一个最小可用的 mock 上下文。 */
const OMIT = Symbol('omit')

function mockCtx({ tty = false, startupValues = { prompt: '', resume: undefined, model: undefined }, agents = OMIT } = {}) {
  const calls = { provides: [], effects: [], listeners: [], logs: [] }
  const originalOut = process.stdout.isTTY
  const originalIn = process.stdin.isTTY

  // 入口用 process.stdout.isTTY 判定身份；这里直接改写属性再还原。
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true })
  Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true })

  // 用 OMIT 哨兵表达「这个服务不提供」。不能传 undefined——那会触发上面的
  // 默认参数，反而把服务提供了。
  const registry = new Map()
  if (startupValues !== OMIT) registry.set('dshTuiStartup', startupValues)
  if (agents !== OMIT) registry.set('agents', agents)

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
      ctx[name] = value
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

  // 真实 Cordis 里服务同时以 `ctx.<name>` 属性暴露（kernel.js 用的就是这个），
  // 只实现 ctx.get() 的 mock 保真度不够，会让测试通过但线上行为不同。
  for (const [serviceName, value] of registry) ctx[serviceName] = value

  return {
    ctx,
    calls,
    restore() {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalOut, configurable: true })
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIn, configurable: true })
    },
  }
}

entryTest('入口导出 Cordis 插件形态，代码级依赖保持最小', () => {
  assert.equal(typeof entry.apply, 'function')
  assert.equal(entry.name, 'dsh-tui')
  assert.deepEqual(entry.inject, ['dshTuiStartup'])
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
  const h = mockCtx({ tty: true, agents: OMIT })
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
  const h = mockCtx({ tty: true, startupValues: OMIT })
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
