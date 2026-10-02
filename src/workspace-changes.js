/** 只读工作区快照：Git 的未提交改动包含用户已有改动，不归因给 Agent。 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const MAX_FILES = 60
const MAX_FILE_BYTES = 256 * 1024

export function parsePatch(patch) {
  const lines = []
  let oldLine = 0, newLine = 0, inHunk = false
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true
      lines.push({ kind: 'hunk', text })
    } else if (inHunk && text.startsWith('+')) {
      lines.push({ kind: 'add', text: text.slice(1), newLine: newLine++ })
    } else if (inHunk && text.startsWith('-')) {
      lines.push({ kind: 'remove', text: text.slice(1), oldLine: oldLine++ })
    } else if (inHunk && text.startsWith(' ')) {
      lines.push({ kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ })
    } else if (inHunk && text.startsWith('\\')) {
      lines.push({ kind: 'summary', text })
    }
  }
  return lines
}

function counts(lines) {
  return { added: lines.filter(x => x.kind === 'add').length, removed: lines.filter(x => x.kind === 'remove').length }
}

export async function readWorkspaceChanges(cwd, { run = execute } = {}) {
  const git = async (args, directory = cwd) => (await run('git', ['--no-optional-locks', '--literal-pathspecs', ...args], {
    cwd: directory, encoding: 'utf8', timeout: 8000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })).stdout
  let root
  try { root = (await git(['rev-parse', '--show-toplevel'])).trim() }
  catch { return { available: false, files: [], note: '没有可读取的 Git 工作区，显示会话编辑记录' } }
  let base = 'HEAD'
  try { await git(['rev-parse', '--verify', 'HEAD'], root) } catch { base = undefined }
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], root)
  const entries = status.split('\0').filter(Boolean).map(row => ({ code: row.slice(0, 2), path: row.slice(3) }))
  const files = []
  // 限制并发和读取量，避免大仓库阻塞输入或耗尽内存。
  for (let offset = 0; offset < Math.min(entries.length, MAX_FILES); offset += 4) {
    const batch = await Promise.all(entries.slice(offset, Math.min(offset + 4, MAX_FILES)).map(async entry => {
      try {
        let lines
        if (entry.code === '??' || (!base && !entry.code.includes('D'))) {
          const absolute = path.join(root, entry.path)
          const stat = await fs.lstat(absolute)
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
            return { ...entry, lines: [], note: stat.isSymbolicLink() ? '符号链接，未展开' : '文件较大或非普通文件，未展开' }
          }
          const bytes = await fs.readFile(absolute)
          if (bytes.includes(0)) return { ...entry, lines: [], note: '二进制文件，未展开' }
          const text = bytes.toString('utf8').split('\n')
          if (text.at(-1) === '') text.pop()
          lines = text.map((text, index) => ({ kind: 'add', text, newLine: index + 1 }))
        } else {
          const patch = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=3',
            ...(base ? [base] : []), '--', entry.path], root)
          lines = parsePatch(patch)
        }
        return { ...entry, lines, ...counts(lines), note: lines.length ? undefined : '无文本差异（可能为权限、二进制或子模块改动）' }
      } catch { return { ...entry, lines: [], note: '文件变化中或读取失败，按 r 重试' } }
    }))
    files.push(...batch)
  }
  return { available: true, root, files, note: entries.length > MAX_FILES ? `显示前 ${MAX_FILES} 个文件，共 ${entries.length} 个` : undefined }
}
