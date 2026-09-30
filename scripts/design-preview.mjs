/** Export actual component output, baseline comparison and deterministic workload counts. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { visibleWidth } from '@earendil-works/pi-tui'
import { fixtureEvents, fixturePresent, fixtureSnapshot, fixtureRuntime, memoryTerminal } from './fixtures.mjs'
import { createPrompter } from '../src/prompts.js'
import { createWorkbench } from '../src/workbench.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'docs', 'benchmark-v1')
fs.mkdirSync(output, { recursive: true })
const baseline = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-baseline-'))
const baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'src', 'package.json'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
for (const file of files) {
  fs.mkdirSync(path.dirname(path.join(baseline, file)), { recursive: true })
  fs.writeFileSync(path.join(baseline, file), execFileSync('git', ['show', `HEAD:${file}`], { cwd: root }))
}
fs.symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'), 'dir')

async function modules(directory) {
  const result = {}
  for (const name of ['app', 'theme', 'registry', 'projection', 'messages', 'banner']) {
    Object.assign(result, await import(pathToFileURL(path.join(directory, 'src', name + '.js')).href))
  }
  return result
}

function setup(api, width = 100, { empty = false } = {}) {
  const theme = api.createTheme(undefined, { COLORTERM: 'truecolor' })
  const registry = api.createRegistry(), view = api.createView()
  api.installDefaultRenderers(registry)
  if (!empty) for (const event of fixtureEvents) api.applySessionEvent(view, event, fixturePresent)
  const app = api.createApp({ view, theme, registry, terminal: memoryTerminal(width, 32),
    getSnapshot: () => fixtureSnapshot, getState: () => ({ turnActive: false }), getSessionLabel: () => 'demo-v1',
    onSubmit() {}, onCommand() {}, onExit() {}, onInterrupt() {},
  })
  app.tui.requestRender = () => {}
  registry.setHeader(api.createBanner({ theme, getSubtitle: () => '固定演示 · 相同会话数据', getPreset: () => 'STANDARD' }))
  return { app, theme, registry, view }
}

function capture(api, width, options) {
  const { app } = setup(api, width, options)
  try { return app.tui.render(width) }
  finally { app.tui.stop = () => {}; app.dispose() }
}

function workload(api) {
  const { app, registry, view } = setup(api)
  let calls = 0
  registry.setMessageRenderer('user', ({ row }) => ({ render() { calls++; return [row.text] } }))
  view.rows = Array.from({ length: 1000 }, (_, index) => ({ key: 'history-' + index, role: 'user', text: '历史消息', rev: 0 }))
  view.revision++
  app.tui.render(100)
  const initial = calls
  const start = performance.now()
  for (let i = 0; i < 20; i++) { view.revision++; app.requestRender(); app.tui.render(100) }
  const elapsedMs = performance.now() - start
  app.tui.stop = () => {}; app.dispose()
  return { historyRows: 1000, updates: 20, initialHistoryRenders: initial, subsequentHistoryRenders: calls - initial, elapsedMs: Number(elapsedMs.toFixed(2)) }
}

const before = await modules(baseline), after = await modules(root)
const scenes = [
  { id: 'before', label: '改版前 · 当前提交基线', width: 100, lines: capture(before, 100) },
  { id: 'after', label: '第一版 · 对话与工具', width: 100, lines: capture(after, 100) },
  { id: 'narrow', label: '第一版 · 48 列窄窗口', width: 48, lines: capture(after, 48) },
  { id: 'welcome', label: '第一版 · 开始工作', width: 100, lines: capture(after, 100, { empty: true }) },
]

const { app, theme, registry, view } = setup(after)
let panel
const prompts = createPrompter({ theme, tui: { terminal: { rows: 32 }, requestRender() {}, showOverlay(component) { panel = component; return { hide() {} } } } })
const runtime = fixtureRuntime()
const workbench = createWorkbench({ app: { ...app, choose: prompts.choose, document: prompts.document }, kernel: { runtime }, registry, view })
const opening = workbench.execute('workbench', '')
scenes.push({ id: 'workbench', label: '第一版 · 工作台', width: 84, lines: panel.render(84) })
prompts.cancelAll(); await opening
const document = prompts.document({ title: '上下文 · 当前快照', text: runtime.context().map((entry) => `${entry.source.kind}\n\n${entry.text}`).join('\n\n────────────────\n\n') })
scenes.push({ id: 'context', label: '第一版 · 上下文全文', width: 84, lines: panel.render(84) })
prompts.cancelAll(); await document
app.tui.stop = () => {}; app.dispose()

const metrics = { baselineCommit, node: process.version, baseline: workload(before), firstVersion: workload(after),
  scenes: scenes.map(({ id, width, lines }) => ({ id, width, renderedLines: lines.length, overflow: lines.filter((line) => visibleWidth(line) > width).length })),
  note: 'Fixed invented fixtures; no live model calls. Timing is one local sample, not a cross-machine performance score. Baseline is HEAD, excluding pre-existing uncommitted model-routing edits.' }
fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n')

const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
function ansiHtml(input) {
  input = input.replace(/\x1b_[^\x07]*\x07/g, '')
  let fg, bg, bold = false, italic = false
  let html = '', cursor = 0
  const pattern = /\x1b\[([0-9;]*)m/g
  const span = (text) => `<span style="${fg ? `color:${fg};` : ''}${bg ? `background:${bg};` : ''}${bold ? 'font-weight:700;' : ''}${italic ? 'font-style:italic;' : ''}">${escape(text)}</span>`
  for (const match of input.matchAll(pattern)) {
    html += span(input.slice(cursor, match.index))
    const codes = (match[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      if (code === 0) { fg = bg = undefined; bold = italic = false }
      else if (code === 1) bold = true
      else if (code === 22) bold = false
      else if (code === 3) italic = true
      else if (code === 23) italic = false
      else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
        const color = `rgb(${codes.slice(i + 2, i + 5).join(',')})`
        if (code === 38) fg = color; else bg = color
        i += 4
      }
    }
    cursor = match.index + match[0].length
  }
  return html + span(input.slice(cursor))
}
for (const scene of scenes) fs.writeFileSync(path.join(output, scene.id + '.ansi'), scene.lines.join('\n') + '\n')
const gallery = ['after', 'workbench', 'context', 'narrow', 'welcome', 'before'].map((id) => scenes.find((scene) => scene.id === id))
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH / Fieldnotes — Design 01</title>
<style>*{box-sizing:border-box}body{margin:0;background:#101819;color:#e5e5dc;font:15px/1.7 'Sarasa UI SC',sans-serif}main{max-width:1100px;margin:60px auto;padding:0 32px}header{padding:0 0 34px;border-bottom:1px solid #354849}.eyebrow{color:#88c8bc;letter-spacing:.16em;font-size:12px}h1{font-size:44px;line-height:1.2;font-weight:500;letter-spacing:-.04em;margin:16px 0}p{color:#9aa8aa;max-width:740px}nav{display:flex;gap:22px;flex-wrap:wrap;margin:26px 0}a{color:#88c8bc;text-decoration:none}section{margin:46px 0}h2{font-size:17px;font-weight:500;display:flex;justify-content:space-between}small{color:#718184;font-size:12px}.terminal{overflow:auto;background:#121b1c;border:1px solid #354849;border-radius:10px;padding:20px 22px}pre{margin:0;font:14px/1.7 'Sarasa Mono SC','Noto Sans Mono CJK SC',monospace;tab-size:2}.metrics{display:flex;gap:36px;padding:22px 0;color:#9aa8aa}.metrics b{display:block;font:28px/1.4 monospace;color:#e5e5dc}footer{border-top:1px solid #354849;padding:24px 0;color:#718184;font-size:12px}@media(max-width:700px){main{padding:0 16px;margin:30px auto}h1{font-size:32px}.metrics{flex-wrap:wrap}.terminal{padding:14px}pre{font-size:12px}}</style>
<main><header><div class="eyebrow">DSH / FIELDNOTES · DESIGN 01</div><h1>把注意力留给工作。</h1><p>终端工作台的第一版：清晰的对话层级、可查看的上下文、可追溯的工具调用。以下画面由实际 TUI 组件直接导出，使用固定演示数据。</p></header>
<nav>${gallery.map((scene) => `<a href="#${scene.id}">${scene.label}</a>`).join('')}</nav>
<div class="metrics"><div><b>${metrics.baseline.subsequentHistoryRenders} → ${metrics.firstVersion.subsequentHistoryRenders}</b>1,000 条历史 × 20 次更新：重复渲染历史行次数</div><div><b>48 / 100</b>可复现的终端宽度</div></div>
${gallery.map((scene) => `<section id="${scene.id}"><h2>${scene.label}<small>${scene.width} columns · ${scene.lines.length} lines</small></h2><div class="terminal"><pre>${ansiHtml(scene.lines.join('\n'))}</pre></div></section>`).join('')}
<footer>基线 ${baselineCommit.slice(0, 12)} · ${process.version} · 固定演示数据，无模型调用。尺寸与排版由终端组件生成；浏览器字体和终端字体可能略有差异。<br>复现：npm run design:preview · 交互：npm run demo · 性能原始数据：metrics.json</footer></main></html>`
fs.writeFileSync(path.join(output, 'index.html'), html)
console.log(JSON.stringify(metrics, null, 2))
