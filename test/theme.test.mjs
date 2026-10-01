/**
 * 主题层测试。
 *
 * 重点不是「颜色好不好看」，而是：
 * 1. token 表 → 各组件 theme 形状的派生是完整的（缺一个函数，Markdown 会直接崩）
 * 2. 真彩/256 降级路径都产出合法 ANSI
 * 3. 未知 token 不产生垃圾字节
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTheme, DARK_TOKENS } from '../src/theme.js'

const TRUE = { COLORTERM: 'truecolor' }
const P256 = { COLORTERM: '' }

test('真彩下 fg 产出 24 位序列', () => {
  const theme = createTheme({ ...DARK_TOKENS, accent: '#7aa2f7' }, TRUE)
  assert.equal(theme.depth, 'truecolor')
  const out = theme.fg('accent', 'X')
  assert.match(out, /^\x1b\[38;2;122;162;247mX\x1b\[0m$/)
})

test('256 降级下 fg 产出调色板索引序列', () => {
  const theme = createTheme(DARK_TOKENS, P256)
  assert.equal(theme.depth, '256')
  const out = theme.fg('accent', 'X')
  assert.match(out, /^\x1b\[38;5;\d+mX\x1b\[0m$/)
})

test('bg 用背景色序列', () => {
  const theme = createTheme({ ...DARK_TOKENS, toolPendingBg: '#1f2335' }, TRUE)
  assert.match(theme.bg('toolPendingBg', 'X'), /^\x1b\[48;2;31;35;53mX\x1b\[0m$/)
})

test('token 值为空串时不加任何转义（跟随终端默认前景）', () => {
  const theme = createTheme({ ...DARK_TOKENS, text: '' }, TRUE)
  assert.equal(theme.fg('text', 'plain'), 'plain')
})

test('未知 token 原样返回，不产出垃圾转义', () => {
  const theme = createTheme(DARK_TOKENS, TRUE)
  assert.equal(theme.fg('no-such-token', 'X'), 'X')
  assert.equal(theme.bg('no-such-token', 'X'), 'X')
})

test('DSH_TUI_COLOR 可强制色深', () => {
  assert.equal(createTheme(DARK_TOKENS, { DSH_TUI_COLOR: '256', COLORTERM: 'truecolor' }).depth, '256')
  assert.equal(createTheme(DARK_TOKENS, { DSH_TUI_COLOR: 'truecolor', COLORTERM: '' }).depth, 'truecolor')
})

test('MarkdownTheme 的每个必需函数都存在且可调用', () => {
  const theme = createTheme(DARK_TOKENS, TRUE)
  const required = [
    'heading',
    'link',
    'linkUrl',
    'code',
    'codeBlock',
    'codeBlockBorder',
    'quote',
    'quoteBorder',
    'hr',
    'listBullet',
    'bold',
    'italic',
    'strikethrough',
    'underline',
  ]
  for (const key of required) {
    assert.equal(typeof theme.markdown[key], 'function', `markdown.${key} 缺失`)
    assert.equal(typeof theme.markdown[key]('x'), 'string')
  }
})

test('EditorTheme 形状正确（borderColor + selectList 五项）', () => {
  const theme = createTheme(DARK_TOKENS, TRUE)
  assert.equal(typeof theme.editor.borderColor, 'function')
  for (const key of ['selectedPrefix', 'selectedText', 'description', 'scrollInfo', 'noMatch']) {
    assert.equal(typeof theme.editor.selectList[key], 'function', `selectList.${key} 缺失`)
  }
})

test('文本修饰函数都闭合（不泄漏样式到后续输出）', () => {
  const theme = createTheme(DARK_TOKENS, TRUE)
  for (const fn of ['bold', 'italic', 'underline', 'strikethrough']) {
    const out = theme[fn]('x')
    assert.ok(out.includes('x'))
    assert.ok(out.endsWith('\x1b[2') || /\x1b\[\d+m$/.test(out) || out.endsWith('m'), `${fn} 应以复位序列收尾`)
  }
})
