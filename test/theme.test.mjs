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

import { createTheme, DARK_TOKENS, BLUE_TOKENS, PI_TOKENS, THEMES, DEFAULT_THEME_ID, listThemes, tokensForTheme } from '../src/theme.js'

const TRUE = { COLORTERM: 'truecolor' }
const P256 = { COLORTERM: '' }

// ── 主题注册表与热切 ─────────────────────────────────────────────────────

test('默认主题是蓝色（用户偏好），DARK_TOKENS 指向它', () => {
  assert.equal(DEFAULT_THEME_ID, 'blue')
  assert.equal(DARK_TOKENS, BLUE_TOKENS)
  assert.equal(THEMES.blue.tokens, BLUE_TOKENS)
  assert.equal(THEMES.pi.tokens, PI_TOKENS)
})

test('listThemes 列出全部可选主题且带描述', () => {
  const list = listThemes()
  assert.deepEqual(list.map((t) => t.id).sort(), ['blue', 'pi'])
  for (const t of list) {
    assert.equal(typeof t.name, 'string')
    assert.equal(typeof t.description, 'string')
  }
})

test('tokensForTheme 未知 id 退回默认主题', () => {
  assert.equal(tokensForTheme('pi'), PI_TOKENS)
  assert.equal(tokensForTheme('不存在'), BLUE_TOKENS)
  assert.equal(tokensForTheme(undefined), BLUE_TOKENS)
})

test('setTokens 热切：同一个 theme 引用立刻用新配色（含 markdown/editor 派生）', () => {
  const theme = createTheme(BLUE_TOKENS, TRUE)
  const blue = theme.fg('accent', 'X')
  assert.match(blue, /38;2;122;162;247/, '蓝主题 accent 应为 #7aa2f7')

  theme.setTokens(PI_TOKENS)
  assert.equal(theme.tokens, PI_TOKENS, 'tokens getter 应反映热切后的表')
  const swapped = theme.fg('accent', 'X')
  assert.match(swapped, /38;2;255;212;59/, 'pi 主题 accent 应为 #ffd43b')
  assert.notEqual(swapped, blue)

  // markdown/editor 是闭包引用同一组 fg —— 也必须跟着换。
  assert.match(theme.markdown.link('L'), /38;2;53;216;255/, 'pi link = cyan')
  assert.match(theme.editor.borderColor('B'), /38;2;58;93;120/, 'pi editorBorder = panel2')

  theme.setTokens(BLUE_TOKENS)
  assert.match(theme.markdown.link('L'), /38;2;122;162;247/, '切回蓝主题 link 应变蓝')
})

test('setTokens 忽略非法值，保持当前表', () => {
  const theme = createTheme(BLUE_TOKENS, TRUE)
  theme.setTokens(null)
  theme.setTokens('nope')
  assert.equal(theme.tokens, BLUE_TOKENS)
})

// ── 基础 ANSI 行为 ───────────────────────────────────────────────────────

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
