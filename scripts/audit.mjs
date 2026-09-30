/**
 * 项目自检。
 *
 * 存在理由：本项目的第一轮审查抓到一个 P0——`registry.js` 里定义了
 * `setFooter` / `setEditor`，`app.js` 却从不读 `registry.footer` /
 * `registry.editorFactory`，等于**一边宣称「每个区域都可替换」，一边把
 * 它们写死**。这类「接口为真、实现为假」的缺陷最容易躲过测试，因为测试
 * 会去调注册表，而不是去验证消费方真的读了它。
 *
 * 所以把三件事变成可执行的门禁：
 *
 *   1. 每个「实现点」都必须被 src 里的**消费方**真的读取
 *   2. 内核边界：只有 kernel.js 允许真 import `@deepseek-ai/*`
 *   3. 降级原则：不允许出现占位符式的假数据（"N/A"、"?.?" 之类）
 *
 * 用法：node scripts/audit.mjs   （非零退出码 = 有一项不过）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src')

function readSources() {
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'))
  return files.map((name) => {
    const raw = fs.readFileSync(path.join(srcDir, name), 'utf8')
    return { name, text: raw, code: stripComments(raw) }
  })
}

/**
 * 去掉注释后的代码文本。
 *
 * 必要：JSDoc 里的 `@param {import('@deepseek-ai/cordis').Context}` 是**类型
 * 引用**，不是运行时依赖。不剥注释就会把它误判成边界越界——这个自检脚本
 * 第一版就踩了这个坑。
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

const sources = readSources()
const failures = []
const notes = []

// ── 1. 实现点必须被消费方真的读取 ────────────────────────────────────────
//
// 左边是 registry 暴露的读取口，右边是「谁在读它」的可接受位置。
// 只要求**至少有一个 src 文件（排除 registry.js 自己）**出现这个读取表达式。

const SURFACES = [
  { name: 'header', pattern: /registry\.header\b/, why: 'setHeader 的实现点' },
  { name: 'footer', pattern: /registry\.footer\b/, why: 'setFooter 的实现点' },
  { name: 'editorFactory', pattern: /registry\.editorFactory\b/, why: 'setEditor 的实现点' },
  { name: 'workingIndicator', pattern: /registry\.workingIndicator\b/, why: 'setWorkingIndicator 的实现点' },
  { name: 'statusTexts', pattern: /registry\.statusTexts\s*\(/, why: 'setStatus 的实现点' },
  { name: 'widgetList', pattern: /registry\.widgetList\s*\(/, why: 'setWidget 的实现点' },
  { name: 'messageRendererFor', pattern: /registry\.messageRendererFor\s*\(/, why: 'setMessageRenderer 的实现点' },
]

for (const surface of SURFACES) {
  const consumers = sources.filter((s) => s.name !== 'registry.js' && surface.pattern.test(s.text))
  if (consumers.length === 0) {
    failures.push(
      `实现点「${surface.name}」没有任何消费方读取（${surface.why}）——` +
        '这意味着对应的 set* 是死接口：对外宣称可替换，实现里却写死了。',
    )
  } else {
    notes.push(`  ${surface.name.padEnd(18)} ← ${consumers.map((c) => c.name).join(', ')}`)
  }
}

// ── 2. 内核边界 ──────────────────────────────────────────────────────────

const KERNEL_IMPORT = /^\s*import\s[^\n]*from\s*['"]@deepseek-ai\//m
const ALLOWED = new Set(['kernel.js'])

for (const source of sources) {
  if (!KERNEL_IMPORT.test(source.code)) continue
  if (ALLOWED.has(source.name)) continue
  failures.push(`内核边界越界：src/${source.name} 直接 import 了 @deepseek-ai/*，只有 kernel.js 允许。`)
}

// 运行时的动态 import / require（已排除注释里的类型引用）。
for (const source of sources) {
  const bare = source.code.match(/(?<![\w.'"`])(?:require|import)\(\s*['"]@deepseek-ai\//)
  if (bare !== null && source.name !== 'kernel.js') {
    failures.push(`内核边界越界：src/${source.name} 有运行时 import('@deepseek-ai/*')，只有 kernel.js 允许。`)
  }
}

// ── 3. 降级原则：不许出现占位符式假数据 ──────────────────────────────────

const PLACEHOLDERS = [
  { pattern: /['"]N\/A['"]/, why: '占位符 N/A' },
  { pattern: /['"]\?\?\?['"]/, why: '占位符 ???' },
  { pattern: /['"]unknown['"]\s*\)/, why: '占位符 unknown' },
]

for (const source of sources) {
  for (const rule of PLACEHOLDERS) {
    if (rule.pattern.test(source.text)) {
      failures.push(`src/${source.name} 出现${rule.why}——降级应当是「整块消失」，不是显示占位符。`)
    }
  }
}

// ── 4. 入口必须做启动身份判定 ────────────────────────────────────────────
//
// 一个终端前端被装进非 TTY 宿主时必须静默降级，否则会污染宿主输出。

const entry = sources.find((s) => s.name === 'index.js')
if (entry === undefined || !/resolveHostMode/.test(entry.text)) {
  failures.push('src/index.js 没有做启动身份判定（resolveHostMode）——前端必须能判断「我该不该活」。')
}

// ── 输出 ─────────────────────────────────────────────────────────────────

process.stdout.write('实现点消费情况：\n')
for (const note of notes) process.stdout.write(note + '\n')
process.stdout.write('\n')

if (failures.length > 0) {
  process.stdout.write(`自检未通过（${failures.length} 项）：\n`)
  for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`)
  process.exit(1)
}

process.stdout.write('自检通过：实现点全部被消费、内核边界未越界、无占位符假数据。\n')
