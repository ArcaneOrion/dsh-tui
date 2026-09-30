/**
 * 回车兼容测试。
 *
 * 这个模块存在的理由是一个**实测确认**的行为（不是推测）：
 *
 *   pi-tui 的 Editor 只认 CR(`\r`) 提交；裸 LF(`\n`) 被当成「换行」，
 *   因为 Ctrl+J 在终端里发的就是 LF，与 Enter 同一个字节。
 *
 * 所以有些终端（Enter 发 LF）在 pi-tui 下**永远提交不了**，而且完全不像出错：
 * 字符正常显示，回车只是悄悄换行。
 *
 * 最后一条测试用**真实的 Editor 实例**把这个行为钉死——如果哪天 pi-tui 改了
 * 这个判断，这里会红，提醒我们重新评估这个兼容层还要不要。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Editor } from '@earendil-works/pi-tui'

import { createEnterCompat, enterCompatFromEnv } from '../src/input-compat.js'

// ── 翻译器 ───────────────────────────────────────────────────────────────

test('LF 在没见过 CR 之前被翻译成 CR（让 LF 终端的回车能用）', () => {
  const translate = createEnterCompat()
  assert.equal(translate('\n'), '\r')
})

test('见过 CR 之后，LF 保持原样（保留 Ctrl+J 换行的语义）', () => {
  const translate = createEnterCompat()
  assert.equal(translate('\r'), '\r')
  assert.equal(translate('\n'), '\n', 'CR 终端下 Ctrl+J 必须仍然是换行')
})

test('force=true 时无条件把 LF 翻成 CR', () => {
  const translate = createEnterCompat({ force: true })
  translate('\r')
  assert.equal(translate('\n'), '\r')
})

test('force=false 时完全不干预', () => {
  const translate = createEnterCompat({ force: false })
  assert.equal(translate('\n'), '\n')
  assert.equal(translate('\r'), '\r')
})

test('普通字符与多字节序列原样通过', () => {
  const translate = createEnterCompat()
  for (const input of ['a', '中', '\x1b', '\x1b[A', '\x1b[200~多\n行\x1b[201~', '']) {
    assert.equal(translate(input), input, `${JSON.stringify(input)} 不该被改动`)
  }
})

test('不带参数构造也能用', () => {
  assert.doesNotThrow(() => createEnterCompat())
})

test('enterCompatFromEnv 解析覆盖开关', () => {
  assert.equal(enterCompatFromEnv({}), undefined)
  assert.equal(enterCompatFromEnv({ DSH_TUI_LF_SUBMITS: '' }), undefined)
  assert.equal(enterCompatFromEnv({ DSH_TUI_LF_SUBMITS: '1' }), true)
  assert.equal(enterCompatFromEnv({ DSH_TUI_LF_SUBMITS: '0' }), false)
})

// ── 用真实 Editor 钉死 pi-tui 的行为 ─────────────────────────────────────

const editorTheme = {
  borderColor: (s) => s,
  selectList: {
    selectedPrefix: (s) => s,
    selectedText: (s) => s,
    description: (s) => s,
    scrollInfo: (s) => s,
    noMatch: (s) => s,
  },
}

function makeEditor() {
  const submitted = []
  const tui = { requestRender() {}, setFocus() {}, hasOverlay: () => false }
  const editor = new Editor(tui, editorTheme)
  editor.onSubmit = (text) => submitted.push(text)
  return { editor, submitted }
}

test('【行为钉死】pi-tui 的 Editor：CR 提交，裸 LF 不提交', () => {
  const viaCR = makeEditor()
  viaCR.editor.handleInput('1')
  viaCR.editor.handleInput('\r')
  assert.deepEqual(viaCR.submitted, ['1'], 'CR 必须提交')

  const viaLF = makeEditor()
  viaLF.editor.handleInput('1')
  viaLF.editor.handleInput('\n')
  assert.deepEqual(viaLF.submitted, [], '裸 LF 被当成换行，不提交——这正是本模块存在的理由')
})

test('【行为钉死】把 LF 翻译成 CR 之后，同一个 Editor 就能提交了', () => {
  const translate = createEnterCompat()
  const { editor, submitted } = makeEditor()

  editor.handleInput('1')
  const translated = translate('\n')
  editor.handleInput(translated)

  assert.deepEqual(submitted, ['1'], '兼容层必须真的把 LF 终端救回来')
})
