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

test('theme 偏好能写入读回，非法值被丢弃', () => {
  const dir = tempDir()
  const prefs = createPrefs({ dir })
  assert.equal(prefs.read().theme, undefined)
  assert.equal(prefs.write({ theme: 'pi' }).ok, true)
  assert.equal(prefs.read().theme, 'pi')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ theme: 42 }))
  assert.equal(createPrefs({ dir }).read().theme, undefined)
})

test('文件不存在时读出默认值', () => {
  const prefs = createPrefs({ dir: tempDir() })
  assert.deepEqual(prefs.read(), { model: undefined, provider: undefined, theme: undefined })
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
  assert.deepEqual(prefs.read(), { model: undefined, provider: undefined, theme: undefined })
})

test('字段类型不对时被丢弃', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: 42, provider: { a: 1 } }))
  assert.deepEqual(createPrefs({ dir }).read(), { model: undefined, provider: undefined, theme: undefined })
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

// ── 写失败必须如实上报（否则界面会报假成功）────────────────────────────

test('write 返回 ok:true 表示真的落盘了', () => {
  const prefs = createPrefs({ dir: tempDir() })
  const result = prefs.write({ model: 'a/b' })
  assert.equal(result.ok, true)
  assert.equal(result.value.model, 'a/b')
})

test('write 在路径不可写时返回 ok:false，而不是假装成功', () => {
  const dir = tempDir()
  // 在「目录」该在的位置放一个**文件**，mkdirSync 必然失败。
  const blocker = path.join(dir, 'blocker')
  fs.writeFileSync(blocker, 'not a directory')
  const prefs = createPrefs({ dir: path.join(blocker, 'config') })

  const result = prefs.write({ model: 'a/b' })
  assert.equal(result.ok, false, '写不进去就必须说写不进去')
  assert.equal(fs.existsSync(prefs.file), false)
})

test('写成功时文件权限被收紧到 0600（含已存在的文件）', () => {
  const dir = tempDir()
  const prefs = createPrefs({ dir })
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, '{}')
  fs.chmodSync(file, 0o644)
  prefs.write({ model: 'a/b' })
  const mode = fs.statSync(file).mode & 0o777
  // Windows 上 chmod 不生效，跳过断言。
  if (process.platform !== 'win32') assert.equal(mode, 0o600, `权限应为 0600，实际 ${mode.toString(8)}`)
})
