/**
 * 斜杠命令测试。
 *
 * 两条必须钉死的边界：
 * 1. **本地命令绝不发给内核**（`/help`、`/exit` 内核不认识）。
 * 2. 补全**只在行首 `/` 且未输入空格时**触发——`/model deepseek` 里的第二个词
 *    是命令自己的参数语法，被命令补全接管会很难用。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createCommandAutocomplete,
  createCommandSystem,
  helpText,
  LOCAL_COMMANDS,
  parseCommandLine,
} from '../src/commands.js'

// ── 解析 ─────────────────────────────────────────────────────────────────

test('parseCommandLine：带参数与不带参数', () => {
  assert.deepEqual(parseCommandLine('/model deepseek-flash'), { name: 'model', rest: 'deepseek-flash' })
  assert.deepEqual(parseCommandLine('/help'), { name: 'help', rest: '' })
  assert.deepEqual(parseCommandLine('  /Goal  收尾  '), { name: 'goal', rest: '收尾' })
})

test('parseCommandLine：非命令返回 undefined', () => {
  assert.equal(parseCommandLine('你好'), undefined)
  assert.equal(parseCommandLine('/'), undefined)
  assert.equal(parseCommandLine(''), undefined)
  assert.equal(parseCommandLine(undefined), undefined)
})

test('helpText 列出命令且本地命令不带缩进标记', () => {
  const text = helpText([
    { name: 'help', description: '列出所有可用命令', local: true },
    { name: 'compact', description: '压缩上下文', local: false },
  ])
  assert.match(text, /\/help\s+列出所有可用命令/)
  assert.match(text, /\/compact\s+压缩上下文/)
})

test('helpText 对空列表给出可读文案', () => {
  assert.equal(helpText([]), '没有可用命令。')
})

// ── 命令系统 ─────────────────────────────────────────────────────────────

function makeSystem({ agent = {}, kernelCommands } = {}) {
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'commands') return kernelCommands
      return undefined
    },
  }
  return { calls, system: createCommandSystem({ ctx, getAgent: () => agent }) }
}

test('isLocal 认得本地命令，不认内核命令', () => {
  const { system } = makeSystem()
  for (const c of LOCAL_COMMANDS) assert.equal(system.isLocal(c.name), true)
  assert.equal(system.isLocal('compact'), false)
})

test('listAll 合并本地与内核命令，并标记来源', () => {
  const { system } = makeSystem({
    kernelCommands: {
      list: () => [{ name: 'compact', description: '压缩上下文', input: { hint: 'x' } }],
    },
  })
  const all = system.listAll()
  assert.ok(all.some((c) => c.name === 'help' && c.local === true))
  assert.ok(all.some((c) => c.name === 'compact' && c.local === false))
})

test('内核 commands 服务缺失时 listAll 只给本地命令，不抛错', () => {
  const { system } = makeSystem({ kernelCommands: undefined })
  const all = system.listAll()
  assert.equal(all.length, LOCAL_COMMANDS.length)
})

test('内核 list 抛错时降级为空，不把界面搞崩', () => {
  const { system } = makeSystem({
    kernelCommands: {
      list: () => {
        throw new Error('boom')
      },
    },
  })
  assert.doesNotThrow(() => system.listAll())
  assert.equal(system.listAll().length, LOCAL_COMMANDS.length)
})

test('executeKernel：成功结果原样取出文本', async () => {
  const { system } = makeSystem({
    kernelCommands: {
      execute: async () => ({ commandId: 'c1', result: { kind: 'success', text: '已压缩' } }),
    },
  })
  assert.deepEqual(await system.executeKernel('/compact'), { kind: 'success', text: '已压缩' })
})

test('executeKernel：错误结果被标记为 error', async () => {
  const { system } = makeSystem({
    kernelCommands: {
      execute: async () => ({ commandId: 'c1', result: { kind: 'error', text: '没有可压缩的内容' } }),
    },
  })
  const out = await system.executeKernel('/compact')
  assert.equal(out.kind, 'error')
  assert.equal(out.text, '没有可压缩的内容')
})

test('executeKernel：返回 undefined 表示命令不存在', async () => {
  const { system } = makeSystem({ kernelCommands: { execute: async () => undefined } })
  assert.equal(await system.executeKernel('/nope'), undefined)
})

test('executeKernel：没有 agent 或没有服务时返回 undefined，不抛错', async () => {
  // 注意用 null 而不是 undefined：`agent = {}` 是默认参数，传 undefined 会触发默认值。
  const { system: noAgent } = makeSystem({ agent: null, kernelCommands: { execute: async () => ({}) } })
  assert.equal(await noAgent.executeKernel('/compact'), undefined)

  const { system: noService } = makeSystem({ agent: {}, kernelCommands: undefined })
  assert.equal(await noService.executeKernel('/compact'), undefined)
})

test('executeKernel 把命令原文与空附件传给内核', async () => {
  let seen
  const { system } = makeSystem({
    kernelCommands: {
      execute: async (agent, line, attachments) => {
        seen = { line, attachments }
        return { commandId: 'c', result: { kind: 'success' } }
      },
    },
  })
  await system.executeKernel('/model deepseek-flash')
  assert.equal(seen.line, '/model deepseek-flash')
  assert.deepEqual(seen.attachments, [])
})

// ── 补全 ─────────────────────────────────────────────────────────────────

const provider = (commands) => createCommandAutocomplete({ list: () => commands })

test('补全：行首 / 触发，按前缀过滤', async () => {
  const p = provider([
    { name: 'compact', description: '压缩' },
    { name: 'model', description: '换模型' },
    { name: 'help', description: '帮助' },
  ])
  const result = await p.getSuggestions(['/co'], 0, 3)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].value, 'compact')
  assert.equal(result.prefix, '/co')
})

test('补全：空前缀列出全部', async () => {
  const p = provider([{ name: 'a' }, { name: 'b' }])
  const result = await p.getSuggestions(['/'], 0, 1)
  assert.equal(result.items.length, 2)
})

test('补全：已经在输入参数时不接管（命令自己的语法）', async () => {
  const p = provider([{ name: 'model' }])
  assert.equal(await p.getSuggestions(['/model deep'], 0, 10), null)
})

test('补全：不在行首的 / 不触发', async () => {
  const p = provider([{ name: 'model' }])
  assert.equal(await p.getSuggestions(['看这个 /mo'], 0, 8), null)
  assert.equal(await p.getSuggestions(['不是命令'], 0, 4), null)
})

test('补全：没有匹配项时返回 null（而不是空列表弹一个空框）', async () => {
  const p = provider([{ name: 'model' }])
  assert.equal(await p.getSuggestions(['/zzz'], 0, 4), null)
})

test('补全：list 抛错时返回 null，不把编辑器搞崩', async () => {
  const p = createCommandAutocomplete({
    list: () => {
      throw new Error('boom')
    },
  })
  assert.equal(await p.getSuggestions(['/m'], 0, 2), null)
})

test('补全：applyCompletion 把光标前的片段换成完整命令', () => {
  const p = provider([{ name: 'model' }])
  const out = p.applyCompletion(['/mo'], 0, 3, { value: 'model', label: '/model' }, '/mo')
  assert.deepEqual(out.lines, ['/model'])
  assert.equal(out.cursorCol, 6)
})

test('补全：applyCompletion 保留光标后的内容', () => {
  const p = provider([{ name: 'model' }])
  const out = p.applyCompletion(['/mo 后缀'], 0, 3, { value: 'model', label: '/model' }, '/mo')
  assert.deepEqual(out.lines, ['/model 后缀'])
  assert.equal(out.cursorCol, 6)
})

test('补全：触发字符声明了 /', () => {
  assert.deepEqual(provider([]).triggerCharacters, ['/'])
})
