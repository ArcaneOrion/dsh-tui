/**
 * 杂散输出防护测试。
 *
 * 背景（实测确认）：**pi-tui 不拦截 console / stdout**。任何插件在 TUI 拥有屏幕
 * 时 `console.log`，那一行就直接写进终端把画面搅乱——在 `model-channel-manager`
 * 上撞到过。
 *
 * 边界很重要：**只接管 `console.*`，绝不碰 `process.stdout.write`**——后者是
 * pi-tui 的渲染通道，接管了就等于把渲染搞坏。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { installConsoleGuard } from '../src/console-guard.js'

function tempLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dshtui-guard-')), 'stray.log')
}

test('console.log 被重定向到文件，不再进终端', () => {
  const logPath = tempLog()
  const restore = installConsoleGuard({ logPath })
  try {
    console.log('来自插件的一行')
  } finally {
    restore()
  }
  const text = fs.readFileSync(logPath, 'utf8')
  assert.match(text, /来自插件的一行/)
  assert.match(text, /\[log\]/, '应记下级别')
})

test('warn / error / info / debug 一并接管', () => {
  const logPath = tempLog()
  const restore = installConsoleGuard({ logPath })
  try {
    console.warn('w')
    console.error('e')
    console.info('i')
    console.debug('d')
  } finally {
    restore()
  }
  const text = fs.readFileSync(logPath, 'utf8')
  for (const level of ['warn', 'error', 'info', 'debug']) assert.match(text, new RegExp(`\\[${level}\\]`))
})

test('每条日志都传递正文与级别，不再用重定向通知代替正文', () => {
  const logPath = tempLog()
  const notices = []
  const restore = installConsoleGuard({ logPath, onRecord: (m) => notices.push(m) })
  try {
    console.log('1')
    console.warn('2')
    console.error('3')
  } finally {
    restore()
  }
  assert.deepEqual(notices, [{ level: 'log', text: '1' }, { level: 'warn', text: '2' }, { level: 'error', text: '3' }])
})

test('restore 之后 console 恢复原样（不会永久劫持进程）', () => {
  const logPath = tempLog()
  const before = console.log
  const restore = installConsoleGuard({ logPath })
  assert.notEqual(console.log, before, '装上之后应当变了')
  restore()
  assert.equal(console.log, before, '还原之后必须是原来那个函数')
})

test('非字符串参数也能安全成行', () => {
  const logPath = tempLog()
  const restore = installConsoleGuard({ logPath })
  try {
    console.log({ a: 1 }, 42, null, undefined)
  } finally {
    restore()
  }
  const text = fs.readFileSync(logPath, 'utf8')
  assert.match(text, /a: 1/)
  assert.match(text, /42/)
})

test('循环引用不抛错（被接管的 console 抛错会让调用方炸在莫名其妙的地方）', () => {
  const logPath = tempLog()
  const restore = installConsoleGuard({ logPath })
  const circular = {}
  circular.self = circular
  try {
    assert.doesNotThrow(() => console.log(circular))
  } finally {
    restore()
  }
})

test('日志路径写不进去时也不抛错', () => {
  // 在「目录」该在的位置放一个文件，mkdirSync 必然失败。
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dshtui-guard-')), 'blocker')
  fs.writeFileSync(blocker, 'not a directory')
  const restore = installConsoleGuard({ logPath: path.join(blocker, 'sub', 'stray.log') })
  try {
    assert.doesNotThrow(() => console.log('写不进去也不该炸'))
  } finally {
    restore()
  }
})

test('显示回调抛错不影响文件记录', () => {
  const logPath = tempLog()
  const restore = installConsoleGuard({
    logPath,
    onRecord: () => {
      throw new Error('notice exploded')
    },
  })
  try {
    assert.doesNotThrow(() => console.log('仍然要被记下来'))
  } finally {
    restore()
  }
  assert.match(fs.readFileSync(logPath, 'utf8'), /仍然要被记下来/)
})

test('保留占位符和错误堆栈，移除控制序列；回调中的日志不会递归显示', () => {
  const logPath = tempLog(), records = []
  const restore = installConsoleGuard({ logPath, onRecord(record) {
    records.push(record)
    console.debug('显示器内部日志')
  } })
  try {
    console.info('\x1b[2J[plugin] loaded %d tools', 3)
    console.error(new Error('连接失败'))
  } finally { restore() }
  assert.equal(records.length, 2)
  assert.equal(records[0].text, '[plugin] loaded 3 tools')
  assert.match(records[1].text, /Error: 连接失败\n\s+at /)
  assert.match(fs.readFileSync(logPath, 'utf8'), /显示器内部日志/)
})
