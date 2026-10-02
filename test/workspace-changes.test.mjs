import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parsePatch, readWorkspaceChanges } from '../src/workspace-changes.js'

const patch = 'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -10,2 +10,3 @@\n same\n-old\n+new\n+added\n'

test('Git patch 保留真实行号，多处修改不计入补丁头', () => {
  const rows = parsePatch(patch + '@@ -40 +41 @@\n-before\n+after\n\\ No newline at end of file\n')
  assert.equal(rows.filter(row => row.kind === 'add').length, 3)
  assert.equal(rows.filter(row => row.kind === 'remove').length, 2)
  assert.equal(rows.find(row => row.text === 'old').oldLine, 11)
  assert.equal(rows.find(row => row.text === 'after').newLine, 41)
})

test('工作区读取支持空格文件名、未跟踪文件和二进制；不执行 diff 驱动或 pathspec', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-changes-'))
  try {
    await fs.writeFile(path.join(root, '新 文件.js'), '一\n二\n')
    await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 2]))
    await fs.symlink('/not-readable', path.join(root, 'link'))
    const run = async (_command, args) => {
      assert.ok(args.includes('--literal-pathspecs'))
      if (args.includes('--show-toplevel')) return { stdout: root + '\n' }
      if (args.includes('--verify')) return { stdout: 'head\n' }
      if (args.includes('status')) return { stdout: ' M :(glob)*.js\0?? 新 文件.js\0?? image.bin\0?? link\0' }
      assert.ok(args.includes('--no-ext-diff'))
      assert.ok(args.includes('--no-textconv'))
      assert.equal(args.at(-1), ':(glob)*.js')
      return { stdout: patch }
    }
    const result = await readWorkspaceChanges(root, { run })
    assert.equal(result.files.length, 4)
    assert.equal(result.files[0].added, 2)
    assert.equal(result.files[1].added, 2)
    assert.equal(result.files[1].lines.at(-1).text, '二')
    assert.match(result.files[2].note, /二进制/)
    assert.match(result.files[3].note, /符号链接/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('没有首次提交的仓库展示当前文件，非仓库明确降级', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-unborn-'))
  try {
    await fs.writeFile(path.join(root, 'first.js'), 'first\n')
    const run = async (_, args) => {
      if (args.includes('--show-toplevel')) return { stdout: root + '\n' }
      if (args.includes('--verify')) throw new Error('unborn')
      return { stdout: 'A  first.js\0' }
    }
    const result = await readWorkspaceChanges(root, { run })
    assert.equal(result.files[0].added, 1)
    const absent = await readWorkspaceChanges(root, { run: async () => { throw new Error('not a repository') } })
    assert.equal(absent.available, false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
