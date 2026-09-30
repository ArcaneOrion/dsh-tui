/**
 * `@` 文件引用与补全合流测试。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  combineAutocomplete,
  createFileIndex,
  createMentionAutocomplete,
  mentionFragment,
  scanFiles,
} from '../src/mentions.js'

function makeTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshtui-tree-'))
  for (const [rel, kind] of Object.entries(spec)) {
    const full = path.join(root, rel)
    if (kind === 'dir') fs.mkdirSync(full, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, '')
    }
  }
  return root
}

// ── 片段识别 ─────────────────────────────────────────────────────────────

test('mentionFragment：行首与空白后的 @ 算引用', () => {
  assert.equal(mentionFragment('@src'), 'src')
  assert.equal(mentionFragment('看看 @src/a'), 'src/a')
  assert.equal(mentionFragment('@'), '')
})

test('mentionFragment：@ 后已有空白说明引用结束', () => {
  assert.equal(mentionFragment('@src/a.ts 后面还有字'), undefined)
})

test('mentionFragment：不在词首的 @ 不算引用（避免吞掉邮箱）', () => {
  assert.equal(mentionFragment('mail@example.com'), undefined)
  assert.equal(mentionFragment('没有 at 号'), undefined)
})

// ── 扫描 ─────────────────────────────────────────────────────────────────

test('scanFiles 返回相对路径并跳过重量级目录', () => {
  const root = makeTree({
    'src/a.ts': 'file',
    'src/b.ts': 'file',
    'node_modules/big/index.js': 'file',
    '.git/config': 'file',
    'dist/out.js': 'file',
  })
  const files = scanFiles(root)
  assert.ok(files.includes('src/a.ts'))
  assert.ok(files.includes('src/b.ts'))
  assert.ok(!files.some((f) => f.includes('node_modules')))
  assert.ok(!files.some((f) => f.includes('.git')))
  assert.ok(!files.some((f) => f.startsWith('dist/')))
})

test('createFileIndex 命中 TTL 缓存', () => {
  const root = makeTree({ 'a.ts': 'file' })
  const list = createFileIndex(root, { ttlMs: 10_000 })
  assert.deepEqual(list(), ['a.ts'])
  fs.writeFileSync(path.join(root, 'b.ts'), '')
  assert.deepEqual(list(), ['a.ts'], 'TTL 内不应重扫磁盘')
})

// ── 补全 ─────────────────────────────────────────────────────────────────

test('补全：@ 后按子串过滤，prefix 带回 @', async () => {
  const p = createMentionAutocomplete({ listFiles: () => ['src/a.ts', 'src/b.ts', 'README.md'] })
  const result = await p.getSuggestions(['@src'], 0, 4)
  assert.equal(result.items.length, 2)
  assert.equal(result.prefix, '@src')
  assert.equal(result.items[0].value, 'src/a.ts')
})

test('补全：非 @ 上下文不触发', async () => {
  const p = createMentionAutocomplete({ listFiles: () => ['a.ts'] })
  assert.equal(await p.getSuggestions(['普通文本'], 0, 4), null)
})

test('补全：没有匹配返回 null（不弹空框）', async () => {
  const p = createMentionAutocomplete({ listFiles: () => ['a.ts'] })
  assert.equal(await p.getSuggestions(['@zzz'], 0, 4), null)
})

test('补全：listFiles 抛错时返回 null', async () => {
  const p = createMentionAutocomplete({
    listFiles: () => {
      throw new Error('boom')
    },
  })
  assert.equal(await p.getSuggestions(['@a'], 0, 2), null)
})

test('补全：applyCompletion 补成完整 @路径', () => {
  const p = createMentionAutocomplete({ listFiles: () => [] })
  const out = p.applyCompletion(['@src'], 0, 4, { value: 'src/a.ts', label: 'src/a.ts' }, '@src')
  assert.deepEqual(out.lines, ['@src/a.ts'])
  assert.equal(out.cursorCol, 9)
})

// ── 合流 ─────────────────────────────────────────────────────────────────

function fakeProvider(trigger, items) {
  return {
    triggerCharacters: [trigger],
    async getSuggestions(lines, cursorLine, cursorCol) {
      const line = lines[cursorLine] ?? ''
      if (!line.startsWith(trigger)) return null
      return { items, prefix: line.slice(0, cursorCol) }
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const next = [...lines]
      next[cursorLine] = (prefix.startsWith(trigger) ? item.value : (next[cursorLine] ?? '')) + (next[cursorLine] ?? '').slice(cursorCol)
      return { lines: next, cursorLine, cursorCol: item.value.length }
    },
  }
}

test('合流：按前缀分派给正确的 provider', async () => {
  const combined = combineAutocomplete([
    fakeProvider('/', [{ value: 'model', label: '/model' }]),
    fakeProvider('@', [{ value: 'src/a.ts', label: 'src/a.ts' }]),
  ])

  assert.deepEqual(combined.triggerCharacters.sort(), ['/', '@'])
  assert.equal((await combined.getSuggestions(['/mo'], 0, 3)).items[0].value, 'model')
  assert.equal((await combined.getSuggestions(['@src'], 0, 4)).items[0].value, 'src/a.ts')
  assert.equal(await combined.getSuggestions(['普通文本'], 0, 4), null)
})

test('合流：applyCompletion 用 prefix 首字符分派', () => {
  const combined = combineAutocomplete([
    fakeProvider('/', [{ value: 'model', label: '/model' }]),
    fakeProvider('@', [{ value: 'src/a.ts', label: 'src/a.ts' }]),
  ])
  assert.equal(combined.applyCompletion(['/mo'], 0, 3, { value: 'model' }, '/mo').cursorCol, 5)
  assert.equal(combined.applyCompletion(['@src'], 0, 4, { value: 'src/a.ts' }, '@src').cursorCol, 8)
})

test('合流：空 providers 列表不抛错', async () => {
  const combined = combineAutocomplete([])
  assert.equal(await combined.getSuggestions(['x'], 0, 1), null)
  assert.doesNotThrow(() => combined.applyCompletion(['x'], 0, 1, { value: 'y' }, ''))
})
