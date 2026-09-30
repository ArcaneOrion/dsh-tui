/**
 * 外观件的测试：banner、语法高亮、启动信息块。
 *
 * 这三个的共同点是**降级必须干净**：宽度不够就截、语言不认识就不高亮、
 * 服务没接上就整节消失。任何一处「硬来」都会在真终端里变成花屏或崩溃。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { visibleWidth } from '@earendil-works/pi-tui'

import { bannerLines, createBanner } from '../src/banner.js'
import { createHighlighter } from '../src/highlight.js'
import { collectStartupSections, infoRenderer } from '../src/startup-info.js'
import { createTheme } from '../src/theme.js'

const theme = createTheme(undefined, { COLORTERM: 'truecolor' })
const plain = (lines) => lines.join('\n')

// ── banner ───────────────────────────────────────────────────────────────

test('bannerLines：宽终端下鲸鱼与字标并列', () => {
  const { lines, mode } = bannerLines(120)
  assert.equal(mode, 'full')
  assert.equal(lines.length, 5)
  assert.ok(visibleWidth(lines[0]) > 20)
})

test('bannerLines：中等宽度只留鲸鱼', () => {
  const { lines, mode } = bannerLines(30)
  assert.equal(mode, 'whale')
  assert.equal(lines.length, 5)
})

test('bannerLines：极窄也要能出东西（不返回空）', () => {
  const { lines } = bannerLines(5)
  assert.ok(lines.length > 0)
})

test('banner 组件：任何宽度下都不溢出（越界会把整个 TUI 打崩）', () => {
  const banner = createBanner({ theme, getSubtitle: () => 'dsh-tui 0.1.0 · provider/model' })
  for (const width of [5, 12, 30, 60, 93, 120, 200]) {
    banner.invalidate()
    for (const line of banner.render(width)) {
      assert.ok(visibleWidth(line) <= width, `宽度 ${width} 下溢出：${JSON.stringify(line)}`)
    }
  }
})

test('banner 组件：有副标题时追加一行', () => {
  const banner = createBanner({ theme, getSubtitle: () => 'v1' })
  const without = createBanner({ theme })
  assert.ok(banner.render(120).join('\n').includes('v1'))
  assert.equal(banner.render(120).length, without.render(120).length)
})

// ── 语法高亮 ─────────────────────────────────────────────────────────────

// 测试用 <tag>…</tag> 代替 ANSI，便于断言；strip 要把两者都去掉。
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/<\/?[a-z]+>/g, '')
const ink = (name) => (t) => `<${name}>${t}</${name}>`

const highlight = createHighlighter({
  code: ink('code'),
  comment: ink('comment'),
  string: ink('string'),
  number: ink('number'),
  keyword: ink('keyword'),
})

test('高亮：不认识的语言返回 undefined（让 pi-tui 退回纯色）', () => {
  assert.equal(highlight('whatever', 'brainfuck'), undefined)
  assert.equal(highlight('whatever', undefined), undefined)
})

test('高亮：关键字被标记，且文本内容一字不改', () => {
  const out = highlight('const x = 1', 'js')
  assert.equal(strip(out.join('\n')), 'const x = 1')
  assert.match(out.join('\n'), /<keyword>const<\/keyword>/)
})

test('高亮：数字与字符串分开标记', () => {
  const out = highlight('let a = "hi" + 42', 'js').join('\n')
  assert.match(out, /<string>"hi"<\/string>/)
  assert.match(out, /<number>42<\/number>/)
})

test('高亮：行注释整段吃掉，注释里的关键字不再被标记', () => {
  const out = highlight('const a = 1 // const b = 2', 'js').join('\n')
  assert.match(out, /<comment>\/\/ const b = 2<\/comment>/)
  assert.equal(strip(out), 'const a = 1 // const b = 2')
})

test('高亮：块注释跨行保持状态', () => {
  const out = highlight('/* 开始\n中间\n结束 */ const a', 'js')
  assert.match(out[0], /<comment>/)
  assert.match(out[1], /<comment>中间<\/comment>/)
  assert.match(out[2], /<comment>结束 \*\/<\/comment>/)
  assert.match(out[2], /<keyword>const<\/keyword>/)
})

test('高亮：不同语言用不同的注释符', () => {
  const py = highlight('x = 1  # 注释', 'py').join('\n')
  assert.match(py, /<comment># 注释<\/comment>/)
  const sh = highlight('echo hi # 注释', 'sh').join('\n')
  assert.match(sh, /<comment># 注释<\/comment>/)
})

test('高亮：行数与输入一致', () => {
  const out = highlight('a\nb\nc', 'js')
  assert.equal(out.length, 3)
})

// ── 启动信息块 ───────────────────────────────────────────────────────────

test('collectStartupSections：服务全缺时只给 Context 一节', async () => {
  const sections = await collectStartupSections({
    ctx: { get: () => undefined },
    cwd: '/tmp/some-project',
    theme,
    version: '0.1.0',
  })
  assert.ok(sections.some((s) => s.label === '[Context]'))
  assert.ok(!sections.some((s) => s.label === '[Skills]'))
  assert.ok(!sections.some((s) => s.label === '[Plugins]'))
})

test('collectStartupSections：有技能时列出名字', async () => {
  const sections = await collectStartupSections({
    ctx: { get: (name) => (name === 'skills' ? { list: async () => [{ name: 'a' }, { name: 'b' }] } : undefined) },
    cwd: '/tmp',
    theme,
    version: '0.1.0',
  })
  const skills = sections.find((s) => s.label === '[Skills]')
  assert.match(skills.items.join(''), /a, b/)
})

test('collectStartupSections：skills.list 抛错时整节消失，其余照常', async () => {
  const sections = await collectStartupSections({
    ctx: {
      get: (name) =>
        name === 'skills'
          ? {
              list: async () => {
                throw new Error('boom')
              },
            }
          : undefined,
    },
    listCommands: () => [{ name: 'help' }],
    cwd: '/tmp',
    theme,
    version: '0.1.0',
  })
  assert.ok(!sections.some((s) => s.label === '[Skills]'))
  assert.ok(sections.some((s) => s.label === '[Commands]'))
})

test('collectStartupSections：空的节不占位置', async () => {
  const sections = await collectStartupSections({
    ctx: { get: (name) => (name === 'skills' ? { list: async () => [] } : undefined) },
    cwd: '/tmp',
    theme,
    version: '0.1.0',
  })
  assert.ok(!sections.some((s) => s.label === '[Skills]'), '空技能列表不该渲染成一个空节')
})

test('collectStartupSections：插件行排除自己，且跳过 disabled', async () => {
  const sections = await collectStartupSections({
    ctx: {
      get: (name) =>
        name === 'loader'
          ? {
              entries: () => [
                { options: { id: 'dsh-tui' } },
                { options: { id: 'dsh-tui-startup' } },
                { options: { id: 'tool-bash' } },
                { options: { id: 'tool-pwsh' }, disabled: true },
              ],
            }
          : undefined,
    },
    cwd: '/tmp',
    theme,
    version: '0.1.0',
  })
  const plugins = sections.find((s) => s.label === '[Plugins]')
  assert.match(plugins.items.join(''), /tool-bash/)
  assert.ok(!plugins.items.join('').includes('pwsh'), 'disabled 的行不该列出来')
  assert.ok(!plugins.items.join('').includes('dsh-tui'), '不该把自己列进去')
})

test('infoRenderer：按节渲染标签与缩进内容', () => {
  const component = infoRenderer({
    row: { sections: [{ label: '[Context]', items: ['/a', '/b'] }] },
    theme,
  })
  const out = plain(component.render(80))
  assert.match(out, /\[Context\]/)
  assert.match(out, /\/a/)
  assert.match(out, /\/b/)
})

test('infoRenderer：空 sections 不产出空壳', () => {
  const component = infoRenderer({ row: { sections: [] }, theme })
  assert.deepEqual(component.render(80), [])
})
