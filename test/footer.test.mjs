/**
 * 状态栏测试。
 *
 * 重点：
 * 1. 格式化与降级——**任何一个数据源缺失，那一段必须消失**，不能显示占位符或 0。
 *    状态栏上的假数字比缺一段糟糕得多。
 * 2. 宽度约束——窄终端下先丢右、再截左，永不溢出。
 * 3. `createFooterInfo` 的取数在服务缺失时不抛错。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { visibleWidth } from '@earendil-works/pi-tui'

import { createFooterInfo, DefaultFooter, formatTokens, readGitBranch, shortSandboxMode } from '../src/footer.js'
import { createRegistry } from '../src/registry.js'
import { createTheme } from '../src/theme.js'

/** 断言用的纯文本视图：多色段之间夹着 ANSI 码，先剥掉再匹配。 */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

const theme = createTheme(undefined, { COLORTERM: 'truecolor' })

// ── 格式化 ───────────────────────────────────────────────────────────────

test('formatTokens 按量级给出可读短形式', () => {
  assert.equal(formatTokens(842), '842')
  assert.equal(formatTokens(12_345), '12.3k')
  assert.equal(formatTokens(123_456), '123k')
  assert.equal(formatTokens(1_234_567), '1.2M')
  assert.equal(formatTokens(12_345_678), '12M')
})

test('formatTokens 对非法输入返回 undefined（让那一段消失，而不是显示 NaN）', () => {
  assert.equal(formatTokens(Number.NaN), undefined)
  assert.equal(formatTokens(-1), undefined)
  assert.equal(formatTokens(undefined), undefined)
})

test('shortSandboxMode 把 danger-full-access 显示成 yolo', () => {
  assert.equal(shortSandboxMode('danger-full-access'), 'yolo')
  assert.equal(shortSandboxMode('workspace-write'), 'workspace-write')
  assert.equal(shortSandboxMode('read-only'), 'read-only')
  assert.equal(shortSandboxMode(undefined), undefined)
})

// ── git 分支 ─────────────────────────────────────────────────────────────

function makeFakeRepo(headContent, { gitFile = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshtui-git-'))
  if (gitFile) {
    // 工作树形态：.git 是个文件，内容是 gitdir: <real>
    const real = path.join(root, '.git-real')
    fs.mkdirSync(real)
    fs.writeFileSync(path.join(real, 'HEAD'), headContent)
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${real}\n`)
  } else {
    fs.mkdirSync(path.join(root, '.git'))
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), headContent)
  }
  return root
}

test('readGitBranch 解析 ref 形式的分支名', () => {
  const root = makeFakeRepo('ref: refs/heads/feature-x\n')
  assert.equal(readGitBranch(root, 0, {}), 'feature-x')
})

test('readGitBranch 对 detached HEAD 给出短 sha', () => {
  const root = makeFakeRepo('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n')
  assert.equal(readGitBranch(root, 0, {}), 'a1b2c3d')
})

test('readGitBranch 支持工作树（.git 是文件）形态', () => {
  const root = makeFakeRepo('ref: refs/heads/wt-branch\n', { gitFile: true })
  assert.equal(readGitBranch(root, 0, {}), 'wt-branch')
})

test('readGitBranch 在非 git 目录返回 undefined 而不是抛错', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dshtui-nogit-'))
  assert.equal(readGitBranch(bare, 0, {}), undefined)
})

test('readGitBranch 命中 TTL 缓存，不重复读盘', () => {
  const root = makeFakeRepo('ref: refs/heads/cached\n')
  const cache = {}
  assert.equal(readGitBranch(root, 1000, cache, 5000), 'cached')
  // 把 HEAD 改掉；TTL 内仍应返回缓存值。
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/changed\n')
  assert.equal(readGitBranch(root, 2000, cache, 5000), 'cached')
  // 超出 TTL 后重新读。
  assert.equal(readGitBranch(root, 9999, cache, 5000), 'changed')
})

// ── 底栏组件 ─────────────────────────────────────────────────────────────

function makeFooter(snapshot, { sessionLabel } = {}) {
  const registry = createRegistry()
  return new DefaultFooter({
    theme,
    registry,
    getSnapshot: () => snapshot,
    getSessionLabel: () => sessionLabel,
  })
}

test('快照齐全时五段都在，且顺序为 模型/目录/分支/用量/沙箱', () => {
  const snapshot = { model: 'p/m', dir: 'D', branch: 'main', tokens: { used: 1000, limit: 10_000 }, sandbox: 'yolo' }
  const footer = makeFooter(snapshot)
  const segments = footer.buildSegments(snapshot)
  // dir/branch 段是多色 parts（标签与值分色），取拼接后的纯文本比对。
  assert.deepEqual(
    segments.map((s) => (s.parts === undefined ? s.text : s.parts.map((p) => p.text).join(''))),
    ['p/m', 'dir D', '⎇ main', '1.0k/10.0k (10.0%)', 'yolo'],
  )
})

test('渲染文本包含真实数值与百分比', () => {
  const footer = makeFooter({ model: 'p/m', dir: 'D', branch: 'main', tokens: { used: 12_345, limit: 1_000_000 }, sandbox: 'yolo' })
  const out = stripAnsi(footer.render(120).join('\n'))
  assert.match(out, /p\/m/)
  assert.match(out, /dir D/)
  assert.match(out, /⎇ main/)
  assert.match(out, /12\.3k\/1\.0M \(1\.2%\)/)
  assert.match(out, /yolo/)
})

test('缺数据源的段整段消失，不显示占位符', () => {
  const footer = makeFooter({ model: 'p/m' })
  const out = footer.render(120).join('\n')
  assert.match(out, /p\/m/)
  assert.doesNotMatch(out, /dir /)
  assert.doesNotMatch(out, /⏵/)
  assert.doesNotMatch(out, /tok/)
  assert.doesNotMatch(out, /yolo/)
})

test('没有模型窗口上限时只显示已用量，不编一个分母', () => {
  const footer = makeFooter({ tokens: { used: 12_345 } })
  const out = footer.render(120).join('\n')
  assert.match(out, /12\.3k tok/)
  assert.doesNotMatch(out, /\//)
})

test('用量高时切到告警/错误配色', () => {
  const warn = makeFooter({ tokens: { used: 850_000, limit: 1_000_000 } })
  assert.match(warn.render(120).join('\n'), /\(85\.0%\)/)
  const err = makeFooter({ tokens: { used: 990_000, limit: 1_000_000 } })
  assert.match(err.render(120).join('\n'), /\(99\.0%\)/)
})

test('注册表里的状态片段被接在末尾', () => {
  const registry = createRegistry()
  registry.setStatus('ext', 'EXT')
  const footer = new DefaultFooter({ theme, registry, getSnapshot: () => ({ model: 'p/m' }) })
  const out = footer.render(120).join('\n')
  assert.match(out, /EXT/)
})

test('会话短标签右对齐出现', () => {
  const footer = makeFooter({ model: 'p/m' }, { sessionLabel: 'abcd1234' })
  const out = footer.render(120).join('\n')
  assert.match(out, /abcd1234/)
})

test('任何宽度下都不溢出', () => {
  const footer = makeFooter(
    { model: 'very-long-provider/very-long-model-name', dir: 'a-very-long-directory-name', branch: 'feature/very-long-branch', tokens: { used: 990_000, limit: 1_000_000 }, sandbox: 'yolo' },
    { sessionLabel: 'abcd1234' },
  )
  for (const width of [20, 40, 60, 80, 120, 200]) {
    footer.invalidate()
    const lines = footer.render(width)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `宽度 ${width} 下溢出：${JSON.stringify(line)}`)
    }
  }
})

test('内容不变时复用同一帧', () => {
  const footer = makeFooter({ model: 'p/m' })
  const first = footer.render(80)
  const second = footer.render(80)
  assert.equal(first, second)
})

// ── 取数层 ───────────────────────────────────────────────────────────────

test('createFooterInfo 在服务全缺时也能给出快照且不抛错', () => {
  const info = createFooterInfo({
    ctx: { get: () => undefined },
    getAgent: () => undefined,
    getSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
  })
  const snap = info.snapshot()
  // 只显示模型名，不拼 provider——与 pi 的底栏一致。
  assert.equal(snap.model, 'm')
  assert.equal(snap.thinking, undefined)
  assert.equal(snap.dir, 'tmp')
  assert.equal(snap.tokens, undefined)
  assert.equal(snap.sandbox, undefined)
})

// ── 真实路由（读 request/header）─────────────────────────────────────────

/** 造一个带若干 request/header 事件的假会话。 */
function sessionWith(...headers) {
  return {
    seq: headers.length,
    events: headers.map((config, i) => ({ seq: i + 1, type: 'request/header', data: { header: { config } } })),
  }
}

test('createFooterInfo 优先用 getSelection（下一步要用的路由）', () => {
  const info = createFooterInfo({
    ctx: { get: () => undefined },
    getAgent: () => ({ session: sessionWith({ provider: 'real', model: 'real-model', reasoningEffort: 'max' }) }),
    // /model 运行时切换后 getSelection 立即变成下一步要用的路由，必须胜出。
    getSelection: () => ({ provider: 'asked', model: 'asked-model', reasoningEffort: 'low' }),
    cwd: '/tmp',
  })
  const snap = info.snapshot()
  assert.equal(snap.model, 'asked-model')
  assert.equal(snap.thinking, 'low')
})

test('createFooterInfo 没有 selection 时退回会话日志的实际路由', () => {
  const info = createFooterInfo({
    ctx: { get: () => undefined },
    getAgent: () => ({ session: sessionWith({ provider: 'real', model: 'real-model', reasoningEffort: 'max' }) }),
    getSelection: () => undefined,
    cwd: '/tmp',
  })
  const snap = info.snapshot()
  assert.equal(snap.model, 'real-model')
  assert.equal(snap.thinking, 'max')
})

test('createFooterInfo selection 缺 effort 时借用实际路由的 effort', () => {
  const info = createFooterInfo({
    ctx: { get: () => undefined },
    getAgent: () => ({ session: sessionWith({ provider: 'real', model: 'real-model', reasoningEffort: 'max' }) }),
    // /model 直切不带 effort：显示上一次实际用的档位，比空白诚实。
    getSelection: () => ({ provider: 'asked', model: 'asked-model' }),
    cwd: '/tmp',
  })
  const snap = info.snapshot()
  assert.equal(snap.model, 'asked-model')
  assert.equal(snap.thinking, 'max')
})

test('createFooterInfo 取的是**最后一条** request/header', () => {
  const info = createFooterInfo({
    ctx: { get: () => undefined },
    getAgent: () => ({
      session: sessionWith({ provider: 'a', model: 'first' }, { provider: 'b', model: 'second' }),
    }),
    getSelection: () => undefined,
    cwd: '/tmp',
  })
  assert.equal(info.snapshot().model, 'second')
})

test('没有 request/header 时退回 getSelection', () => {
  const info = createFooterInfo({
    ctx: { get: () => undefined },
    getAgent: () => ({ session: { seq: 0, events: [] } }),
    getSelection: () => ({ provider: 'p', model: 'fallback' }),
    cwd: '/tmp',
  })
  assert.equal(info.snapshot().model, 'fallback')
})

test('request/header 形状不对时不抛错，且不影响其它段', () => {
  const info = createFooterInfo({
    ctx: { get: () => undefined },
    getAgent: () => ({
      session: {
        seq: 2,
        events: [
          { type: 'request/header', data: { header: { config: null } } },
          { type: 'request/header', data: {} },
        ],
      },
    }),
    getSelection: () => ({ provider: 'p', model: 'safe' }),
    cwd: '/tmp',
  })
  assert.doesNotThrow(() => info.snapshot())
  assert.equal(info.snapshot().model, 'safe')
})

test('thinking 段渲染成 think:<档位>，与 pi 同写法', () => {
  const footer = makeFooter({ model: 'm', thinking: 'high' })
  assert.match(footer.render(120).join('\n'), /think:high/)
})

test('没有 thinking 时该段整段消失', () => {
  const footer = makeFooter({ model: 'm' })
  assert.doesNotMatch(footer.render(120).join('\n'), /think:/)
})

test('createFooterInfo 有 tokenMeter 时给出用量，并按 seq 缓存', () => {
  let calls = 0
  const session = { seq: 7 }
  const info = createFooterInfo({
    ctx: {
      get: (name) =>
        name === 'tokenMeter'
          ? {
              measure: () => {
                calls += 1
                return { totalTokens: 2048 }
              },
            }
          : undefined,
    },
    getAgent: () => ({ session }),
    getSelection: () => undefined,
    cwd: '/tmp',
  })

  assert.equal(info.snapshot().tokens.used, 2048)
  assert.equal(calls, 1)
  info.snapshot()
  assert.equal(calls, 1, '同一 seq 下不应重复 measure（它会重放日志）')

  session.seq = 8
  info.snapshot()
  assert.equal(calls, 2, 'seq 变化后应重新计量')
})

test('createFooterInfo 读取沙箱模式并转成短标签', () => {
  const info = createFooterInfo({
    ctx: {
      get: (name) => (name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) } : undefined),
    },
    getAgent: () => ({ session: {} }),
    getSelection: () => undefined,
    cwd: '/tmp',
  })
  assert.equal(info.snapshot().sandbox, 'yolo')
})

test('createFooterInfo 的 measure 抛错时降级为不显示用量', () => {
  const info = createFooterInfo({
    ctx: {
      get: (name) =>
        name === 'tokenMeter'
          ? {
              measure: () => {
                throw new Error('boom')
              },
            }
          : undefined,
    },
    getAgent: () => ({ session: { seq: 1 } }),
    getSelection: () => undefined,
    cwd: '/tmp',
  })
  assert.doesNotThrow(() => info.snapshot())
  assert.equal(info.snapshot().tokens, undefined)
})
