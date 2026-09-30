/**
 * `@` 文件引用补全。
 *
 * 在编辑器里打 `@` 会列出与已输入片段匹配的项目文件，回车补全成完整路径。
 * 补全后的文本**原样**发给模型（它自己会用 read 工具去读），这里不做内容展开
 * ——展开成附件是另一条更重的路，先不做，也不假装做了。
 *
 * 文件列表带 TTL 缓存并按目录剪枝：不爬 node_modules / .git / 构建产物，
 * 也不在每次按键时重扫磁盘。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 不进入的目录名。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'coverage',
])

/** 单次扫描最多收集多少文件（防大仓库把内存和补全列表撑爆）。 */
const MAX_FILES = 5000
/** 最多下探几层。 */
const MAX_DEPTH = 8
/** 列表缓存时长。 */
const CACHE_TTL_MS = 4000

/**
 * 扫描一个目录树，返回相对路径列表。
 *
 * @param {string} root
 * @returns {string[]}
 */
export function scanFiles(root) {
  const out = []
  const stack = [{ dir: root, depth: 0 }]

  while (stack.length > 0 && out.length < MAX_FILES) {
    const { dir, depth } = stack.pop()
    if (depth > MAX_DEPTH) continue

    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (out.length >= MAX_FILES) break
      const name = entry.name
      if (name.startsWith('.') && name !== '.env.example') {
        // 隐藏文件默认不列，但允许补全到显式打出来的那一部分。
        continue
      }
      const absolute = path.join(dir, name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        stack.push({ dir: absolute, depth: depth + 1 })
      } else if (entry.isFile()) {
        out.push(path.relative(root, absolute))
      }
    }
  }

  out.sort()
  return out
}

/**
 * 造一个带 TTL 缓存的取文件列表函数。
 * @param {string} root
 * @param {{ttlMs?:number}} [options]
 */
export function createFileIndex(root, { ttlMs = CACHE_TTL_MS } = {}) {
  let cache
  let cachedAt = 0

  return function listFiles() {
    const now = Date.now()
    if (cache !== undefined && now - cachedAt < ttlMs) return cache
    cache = scanFiles(root)
    cachedAt = now
    return cache
  }
}

/** 取光标前最后一个 `@` 之后的片段；不是 mention 上下文则返回 undefined。 */
export function mentionFragment(beforeCursor) {
  const at = beforeCursor.lastIndexOf('@')
  if (at === -1) return undefined
  const fragment = beforeCursor.slice(at + 1)
  // mention 片段里不该有空白：`@a b` 说明用户的 @ 已经结束了。
  if (/\s/.test(fragment)) return undefined
  // 行首的 @ 或前面是空白，才算 mention（避免把邮箱地址当引用）。
  if (at > 0 && !/\s/.test(beforeCursor[at - 1])) return undefined
  return fragment
}

/**
 * 建一个 `@` 触发的文件补全 provider。
 *
 * @param {object} options
 * @param {()=>string[]} options.listFiles
 */
export function createMentionAutocomplete({ listFiles }) {
  return {
    triggerCharacters: ['@'],

    async getSuggestions(lines, cursorLine, cursorCol) {
      const line = Array.isArray(lines) ? (lines[cursorLine] ?? '') : ''
      const before = line.slice(0, cursorCol)
      const fragment = mentionFragment(before)
      if (fragment === undefined) return null

      let files
      try {
        files = listFiles()
      } catch {
        return null
      }

      const needle = fragment.toLowerCase()
      const matched = files.filter((f) => f.toLowerCase().includes(needle)).slice(0, 50)
      if (matched.length === 0) return null

      return {
        items: matched.map((f) => ({ value: f, label: f })),
        prefix: '@' + fragment,
      }
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const next = [...lines]
      const line = next[cursorLine] ?? ''
      const before = line.slice(0, Math.max(0, cursorCol - prefix.length))
      const after = line.slice(cursorCol)
      const inserted = '@' + item.value
      next[cursorLine] = before + inserted + after
      return { lines: next, cursorLine, cursorCol: before.length + inserted.length }
    },
  }
}

/**
 * 把两个 autocomplete provider 合成一个：命令走行首 `/`，文件引用走 `@`。
 * pi-tui 的 Editor 只接受一个 provider，所以自己分派。
 */
export function combineAutocomplete(providers) {
  const list = providers.filter((p) => p !== undefined && p !== null)
  return {
    triggerCharacters: [...new Set(list.flatMap((p) => p.triggerCharacters ?? []))],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      for (const provider of list) {
        const result = await provider.getSuggestions(lines, cursorLine, cursorCol, options)
        if (result !== null && result !== undefined) return result
      }
      return null
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      for (const provider of list) {
        // 用 prefix 的首字符决定交给谁：`/` 是命令，`@` 是文件引用。
        if (prefix.startsWith('/') && (provider.triggerCharacters ?? []).includes('/')) {
          return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
        }
        if (prefix.startsWith('@') && (provider.triggerCharacters ?? []).includes('@')) {
          return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
        }
      }
      return { lines, cursorLine, cursorCol }
    },
  }
}
