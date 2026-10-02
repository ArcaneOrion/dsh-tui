/** 导出真实 TUI 合成帧，便于检查分栏、窄屏和浏览状态。 */
import fs from 'node:fs'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createApp } from '../src/app.js'
import { createView } from '../src/projection.js'
import { createRegistry } from '../src/registry.js'
import { createTheme } from '../src/theme.js'
import { installDefaultRenderers } from '../src/messages.js'
import { memoryTerminal, fixtureSnapshot } from './fixtures.mjs'
import { populateFilePaneDemo } from './file-pane-fixtures.mjs'

const output = new URL('../docs/file-pane-preview/', import.meta.url)
fs.mkdirSync(output, { recursive: true })
const scenes = []
for (const [id, width, height] of [['wide', 160, 36], ['compact', 120, 32], ['narrow', 88, 30]]) {
  const view = createView(), registry = createRegistry(), theme = createTheme(undefined, { COLORTERM: 'truecolor' })
  installDefaultRenderers(registry); populateFilePaneDemo(view)
  const app = createApp({ view, registry, theme, terminal: memoryTerminal(width, height), initialPaneMode: 'on',
    getSnapshot: () => ({ ...fixtureSnapshot, permission: { name: 'workspace-write', sandbox: 'workspace-write' } }), getState: () => ({ turnActive: false }) })
  app.tui.requestRender = () => {}
  app.editor.setText('这里能否保留原有消息顺序？')
  app.editPane.follow = false; app.editPane.selected = 'src/session.ts'
  let opening
  if (id === 'narrow') opening = app.showDiff()
  else app.tui.handleInput('\x1b[17~')
  const all = app.tui.compositeOverlays(app.tui.render(width), width, height)
  const lines = all.slice(-height)
  const overflow = lines.filter(line => visibleWidth(line) > width).length
  scenes.push({ id, width, height, lines, overflow })
  app.cancelPrompts(); if (opening) await opening
  app.dispose()
  fs.writeFileSync(new URL(id + '.ansi', output), lines.join('\n'))
}
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
function ansiHtml(input) {
  input = input.replace(/\x1b_[^\x07]*\x07/g, '').replace(/\x1b\][^\x07]*(?:\x07)/g, '')
  let color = '', background = '', bold = false, italic = false, cursor = 0, html = ''
  const span = text => `<span style="width:${visibleWidth(text)}ch;color:${color || 'inherit'};background:${background || 'transparent'};font-weight:${bold ? '700' : '400'};font-style:${italic ? 'italic' : 'normal'}">${escape(text)}</span>`
  for (const match of input.matchAll(/\x1b\[([0-9;]*)m/g)) {
    html += span(input.slice(cursor, match.index))
    const codes = (match[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      if (code === 0) { color = background = ''; bold = italic = false }
      else if (code === 1) bold = true
      else if (code === 22) bold = false
      else if (code === 3) italic = true
      else if (code === 23) italic = false
      else if (code === 39) color = ''
      else if (code === 49) background = ''
      else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
        const value = `rgb(${codes.slice(i + 2, i + 5).join(',')})`
        if (code === 38) color = value; else background = value
        i += 4
      }
    }
    cursor = match.index + match[0].length
  }
  return html + span(input.slice(cursor))
}
fs.writeFileSync(new URL('index.html', output), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH · 会话与文件改动</title>
<style>*{box-sizing:border-box}body{margin:0;padding:32px 40px;background:#0d1420;color:#c9d7eb;font:15px/1.6 sans-serif}header{display:flex;align-items:baseline;gap:28px;margin-bottom:20px}h1{font-size:24px;font-weight:500;margin:0}p{color:#8396b0;margin:0}button{background:#172438;border:1px solid #304763;color:#a4c7f7;padding:8px 16px;cursor:pointer}button.active{background:#2b4a74;color:white}nav{display:flex;gap:8px;margin-bottom:20px}.terminal{display:none;width:max-content;max-width:100%;overflow:auto;background:#161e2e;border:1px solid #304763;border-radius:8px;padding:18px}pre{margin:0;font:14px/1.6 'Sarasa Mono SC','Noto Sans Mono CJK SC',monospace}.line{height:22.4px;white-space:pre}.line span{display:inline-block;height:22.4px;vertical-align:top}.terminal.active{display:block}footer{margin-top:18px;color:#8396b0;font-size:13px}</style>
<header><h1>会话在左，改动在右。</h1><p>实际 TUI 组件输出 · 固定演示数据</p></header><nav>${scenes.map((s, i) => `<button class="${i ? '' : 'active'}" data-scene="${s.id}">${s.width} 列${s.id === 'narrow' ? ' · 全文审阅' : ' · 分栏'}</button>`).join('')}</nav>
${scenes.map((s, i) => `<div id="${s.id}" class="terminal ${i ? '' : 'active'}"><pre>${s.lines.map(line => '<div class="line">' + ansiHtml(line) + '</div>').join('')}</pre></div>`).join('')}
<footer>F6 进入浏览 · [ ] 切文件 · ↑↓ / PgUp / PgDn 滚动 · ←→ 查看长行 · f 跟随 · Esc 回到输入<br>交互体验：npm run demo:files。此页面切换的是实际渲染快照。</footer>
<script>document.querySelectorAll('button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.active').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.getElementById(b.dataset.scene).classList.add('active')})</script></html>`)
fs.writeFileSync(new URL('metrics.json', output), JSON.stringify(scenes.map(({ lines, ...scene }) => scene), null, 2))
console.log(JSON.stringify(scenes.map(({ lines, ...scene }) => scene)))
