/**
 * 工具卡测试。
 *
 * 这个模块的核心主张是「**按工具自己声明的展示意图渲染，不按工具名硬编码**」，
 * 所以测试全部围绕卡片类型展开，不出现任何具体工具名。
 *
 * 另外钉死一条降级原则：认不出的卡片类型 / 没有视图时**退回原文**，
 * 绝不编造——宁可朴素不可撒谎。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { visibleWidth } from '@earendil-works/pi-tui'

import { createTheme } from '../src/theme.js'
import { clampLines, lineDiff, renderCallView, renderDiffs, renderResultView, ToolCard } from '../src/tool-cards.js'

const theme = createTheme(undefined, { COLORTERM: 'truecolor' })
const plain = (lines) => lines.join('\n')

// ── 行级 diff ────────────────────────────────────────────────────────────

test('lineDiff：全新建文件（oldText 为 null）全部算新增', () => {
  const rows = lineDiff(null, 'a\nb')
  assert.deepEqual(rows, [
    { kind: 'add', text: 'a' },
    { kind: 'add', text: 'b' },
  ])
})

test('lineDiff：纯替换给出 remove + add', () => {
  const rows = lineDiff('old', 'new')
  assert.deepEqual(rows, [
    { kind: 'remove', text: 'old' },
    { kind: 'add', text: 'new' },
  ])
})

test('lineDiff：共用行保留为 context，不重复输出', () => {
  const rows = lineDiff('a\nb\nc', 'a\nX\nc')
  assert.deepEqual(rows, [
    { kind: 'context', text: 'a' },
    { kind: 'remove', text: 'b' },
    { kind: 'add', text: 'X' },
    { kind: 'context', text: 'c' },
  ])
})

test('lineDiff：纯插入', () => {
  const rows = lineDiff('a\nc', 'a\nb\nc')
  assert.deepEqual(rows, [
    { kind: 'context', text: 'a' },
    { kind: 'add', text: 'b' },
    { kind: 'context', text: 'c' },
  ])
})

test('lineDiff：内容相同则全是 context', () => {
  const rows = lineDiff('a\nb', 'a\nb')
  assert.ok(rows.every((r) => r.kind === 'context'))
})

test('lineDiff：超大输入给出摘要行，**不伪造**全删全增', () => {
  // 早期版本在这里把整份前后文标成「全删 + 全增」，再被行数上限截掉——
  // 用户会看到「前 40 行被删」，而实际只改了一行。那是编造。
  const big = Array.from({ length: 600 }, (_, i) => `line${i}`).join('\n')
  const rows = lineDiff(big, big + '\n尾巴')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'summary')
  assert.match(rows[0].text, /600 行 → 601 行/)
  assert.ok(!rows.some((r) => r.kind === 'remove'), '不得伪造删除行')
})

test('renderDiffs：摘要行照原样渲染，不加 +/- 标记', () => {
  const out = renderDiffs([{ path: 'big.ts', oldText: 'a\n'.repeat(600), newText: 'b\n'.repeat(600) }], theme)
  const text = out.join('\n')
  assert.match(text, /改动过大/)
  assert.match(text, /big\.ts/)
  assert.ok(!/\+\s*b/.test(text), '不得伪造新增行')
})

test('renderDiffs：多文件合计也有行数上限', () => {
  const diffs = Array.from({ length: 20 }, (_, i) => ({
    path: `f${i}.ts`,
    oldText: 'a',
    newText: 'b',
  }))
  const out = renderDiffs(diffs, theme, { maxLinesPerFile: 40, maxTotalLines: 12 })
  assert.ok(out.length <= 14, `总行数应受限，实际 ${out.length}`)
})

// ── 截断 ─────────────────────────────────────────────────────────────────

test('clampLines：未超限时不动，超限时报告隐藏行数', () => {
  assert.deepEqual(clampLines('a\nb', 5), { lines: ['a', 'b'], hidden: 0 })
  assert.deepEqual(clampLines('a\nb\nc', 2), { lines: ['a', 'b'], hidden: 1 })
})

// ── 调用态卡片 ───────────────────────────────────────────────────────────

test('调用卡：terminal 显示命令、cwd 与描述', () => {
  const out = plain(renderCallView({ card: 'terminal', title: 'ls -la', cwd: '/tmp', description: '列目录' }, theme))
  assert.match(out, /ls -la/)
  assert.match(out, /\/tmp/)
  assert.match(out, /列目录/)
})

test('调用卡：diff 显示文件名与增删行', () => {
  const out = plain(
    renderCallView(
      { card: 'diff', title: 'Write foo.ts', diffs: [{ path: 'foo.ts', oldText: 'a', newText: 'b' }] },
      theme,
    ),
  )
  assert.match(out, /Write foo\.ts/)
  assert.match(out, /foo\.ts/)
  assert.match(out, /-\s*a/)
  assert.match(out, /\+\s*b/)
})

test('调用卡：generic 用 kind 选图标，未知 kind 退回默认图标', () => {
  assert.match(plain(renderCallView({ card: 'generic', title: '读文件', kind: 'read' }, theme)), /读文件/)
  assert.match(plain(renderCallView({ card: 'generic', title: '某事', kind: '非常奇怪的kind' }, theme)), /某事/)
})

test('调用卡：没有视图时返回空（由调用方决定退路）', () => {
  assert.deepEqual(renderCallView(undefined, theme), [])
  assert.deepEqual(renderCallView(null, theme), [])
})

// ── 结果态卡片 ───────────────────────────────────────────────────────────

test('结果卡：terminal 显示输出与退出码，非零码用错误色', () => {
  const ok = plain(renderResultView({ card: 'terminal', output: 'done', exitCode: 0 }, '', theme))
  assert.match(ok, /done/)
  assert.match(ok, /exit 0/)

  const bad = renderResultView({ card: 'terminal', output: 'boom', exitCode: 1 }, '', theme)
  assert.match(plain(bad), /exit 1/)
  assert.ok(bad.join('\n').includes(theme.fg('error', '  exit 1')))
})

test('结果卡：terminal 被信号杀掉时说明信号', () => {
  assert.match(plain(renderResultView({ card: 'terminal', signal: 'SIGTERM' }, '', theme)), /SIGTERM/)
})

test('结果卡：search/matches 按文件分组，并显示截断提示', () => {
  const out = plain(
    renderResultView(
      {
        card: 'search',
        shape: 'matches',
        files: [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'const x = 1' }] }],
        truncated: true,
        total: 99,
      },
      '',
      theme,
    ),
  )
  assert.match(out, /a\.ts/)
  assert.match(out, /3: const x = 1/)
  assert.match(out, /99/)
})

test('结果卡：search/paths 列出路径', () => {
  const out = plain(
    renderResultView({ card: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: false, total: 2 }, '', theme),
  )
  assert.match(out, /a\.ts/)
  assert.match(out, /b\.ts/)
})

test('结果卡：read 带行号与总行数', () => {
  const out = plain(
    renderResultView(
      { card: 'read', path: 'a.ts', offset: 1, totalLines: 120, lines: [{ number: 1, text: 'first' }] },
      '',
      theme,
    ),
  )
  assert.match(out, /a\.ts/)
  assert.match(out, /1\/120 行/)
  assert.match(out, /first/)
})

test('结果卡：web/search 列出来源标题与 URL', () => {
  const out = plain(
    renderResultView(
      { card: 'web', kind: 'search', sources: [{ title: '标题', url: 'https://x' }], truncated: false },
      '',
      theme,
    ),
  )
  assert.match(out, /标题/)
  assert.match(out, /https:\/\/x/)
})

test('结果卡：web/fetch 显示状态码与 URL', () => {
  const out = plain(renderResultView({ card: 'web', kind: 'fetch', url: 'https://x', statusCode: 200 }, '', theme))
  assert.match(out, /200/)
  assert.match(out, /https:\/\/x/)
})

test('结果卡：认不出的卡片类型退回原文，不编造', () => {
  const out = plain(renderResultView({ card: '未来才有的卡' }, '原始结果文本', theme))
  assert.match(out, /原始结果文本/)
})

test('结果卡：没有视图时退回原文', () => {
  assert.match(plain(renderResultView(undefined, '原始结果文本', theme)), /原始结果文本/)
})

test('结果卡：既没有视图也没有原文时输出为空，不产出空壳', () => {
  assert.deepEqual(renderResultView(undefined, '', theme), [])
  assert.deepEqual(renderResultView({ card: 'generic' }, '', theme), [])
})

// ── 组件 ─────────────────────────────────────────────────────────────────

test('ToolCard：没有展示意图时退回「工具名 + 状态」的朴素头', () => {
  const card = new ToolCard({ row: { toolName: 'mystery', done: true, text: '输出' }, theme })
  const out = plain(card.render(80))
  assert.match(out, /mystery/)
  assert.match(out, /输出/)
})

test('ToolCard：有展示意图时用卡片头，且状态并列显示', () => {
  const card = new ToolCard({
    row: { toolName: 'x', done: false, callView: { card: 'terminal', title: 'ls' }, text: '' },
    theme,
  })
  const out = plain(card.render(80))
  assert.match(out, /ls/)
  assert.match(out, /运行中/)
})

test('ToolCard：任何宽度下都不溢出', () => {
  const card = new ToolCard({
    row: {
      toolName: 'edit',
      done: true,
      callView: { card: 'diff', title: '一段很长很长的标题'.repeat(3), diffs: [{ path: 'a/very/long/path.ts', oldText: 'x'.repeat(200), newText: 'y'.repeat(200) }] },
      text: '',
    },
    theme,
  })
  for (const width of [20, 40, 80, 120]) {
    card.invalidate()
    for (const line of card.render(width)) {
      assert.ok(visibleWidth(line) <= width, `宽度 ${width} 下溢出：${JSON.stringify(line)}`)
    }
  }
})
