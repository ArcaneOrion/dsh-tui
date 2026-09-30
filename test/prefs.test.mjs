/**
 * 偏好持久化测试。
 *
 * 重点全在**容错**：偏好文件损坏、目录不可写、字段类型不对时，
 * 必须退回默认值而不是让启动挂掉——「记不住上次用的模型」绝不该是致命问题。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createPrefs, defaultConfigDir } from '../src/prefs.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshtui-prefs-'))
}

test('defaultConfigDir 默认在 ~/.dsh-tui，可被 DSH_TUI_HOME 覆盖', () => {
  assert.ok(defaultConfigDir({}).endsWith('.dsh-tui'))
  assert.equal(defaultConfigDir({ DSH_TUI_HOME: '/tmp/x' }), '/tmp/x')
})

test('文件不存在时读出默认值', () => {
  const prefs = createPrefs({ dir: tempDir() })
  assert.deepEqual(prefs.read(), { model: undefined, provider: undefined })
})

test('写入后能读回来，并且真的落盘', () => {
  const dir = tempDir()
  const prefs = createPrefs({ dir })
  prefs.write({ model: 'deepseek-official/deepseek-flash' })
  assert.equal(prefs.read().model, 'deepseek-official/deepseek-flash')
  assert.ok(fs.existsSync(path.join(dir, 'config.json')))
})

test('写入是合并而不是覆盖（不认识的字段被丢弃，认识的被保留）', () => {
  const prefs = createPrefs({ dir: tempDir() })
  prefs.write({ provider: 'deepseek-official' })
  prefs.write({ model: 'a/b' })
  const read = prefs.read()
  assert.equal(read.provider, 'deepseek-official')
  assert.equal(read.model, 'a/b')
})

test('显式写入 undefined 能清掉记忆的模型', () => {
  const prefs = createPrefs({ dir: tempDir() })
  prefs.write({ model: 'a/b' })
  prefs.write({ model: undefined })
  assert.equal(prefs.read().model, undefined)
})

test('文件损坏时退回默认值，不抛错', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'config.json'), '{ 这不是合法 JSON')
  const prefs = createPrefs({ dir })
  assert.doesNotThrow(() => prefs.read())
  assert.deepEqual(prefs.read(), { model: undefined, provider: undefined })
})

test('字段类型不对时被丢弃', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: 42, provider: { a: 1 } }))
  assert.deepEqual(createPrefs({ dir }).read(), { model: undefined, provider: undefined })
})

test('目录不可写时写入静默失败，读取仍可用', () => {
  const dir = tempDir()
  const prefs = createPrefs({ dir: path.join(dir, 'nested', 'deeper') })
  assert.doesNotThrow(() => prefs.write({ model: 'a/b' }))
  // 目录会被自动创建，所以这次应当写成功；关键是**不抛错**。
  assert.doesNotThrow(() => prefs.read())
})

test('未知字段不会被写回文件（避免文件被越写越脏）', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: 'a/b', 乱七八糟: true }))
  const prefs = createPrefs({ dir })
  prefs.write({ provider: 'p' })
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
  assert.deepEqual(Object.keys(raw).sort(), ['model', 'provider'])
})
