/**
 * 底部状态栏。
 *
 * 它在注册表里是**默认实现**——`registry.setFooter(component)` 可以整体换掉它。
 *
 * 每一段都来自真实数据，不猜、不占位：
 *
 *   模型     kernel 解析出的 provider/model
 *   目录     当前工作目录的 basename
 *   分支     向上找 .git 读 HEAD（带 TTL 缓存，不每帧 stat）
 *   用量     ctx.tokenMeter.measure(session).totalTokens / 模型 contextWindow
 *   沙箱     ctx.sandboxPolicy.resolve({session}).mode
 *   状态     注册表里的 setStatus 片段（调用方自带配色）
 *
 * 任何一个数据源缺失（服务没挂、不在 git 仓库、模型没报窗口）都**整段消失**，
 * 而不是显示占位符或 0——状态栏上出现假数字比缺一段糟糕得多。
 */

import fs from 'node:fs'
import path from 'node:path'

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { createEventTail } from './session-events.js'

/**
 * 分段之间的分隔符。
 *
 * 用 `|` 而不是 `│`——与 pi 底栏的实际输出一致（实机对照过）。
 */
const SEPARATOR = ' | '

/** 末尾的权限/沙箱模式用 `·` 与前文分开（pi 的写法：`…  ·  yolo`）。 */
const MODE_SEPARATOR = '  ·  '

/**
 * 把 token 数格式化成人类可读的短形式。
 * @param {number} n
 */
export function formatTokens(n) {
  if (!Number.isFinite(n) || n < 0) return undefined
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + 'k'
  return String(Math.round(n))
}

/**
 * 读当前 git 分支名。
 *
 * 不 spawn `git`（每帧一次进程启动太贵）；直接向上找 .git 读 HEAD。
 * 结果带 TTL 缓存——分支不会每帧都变。
 *
 * @param {string} startDir
 * @param {number} now - 单调时钟毫秒
 * @param {{value?:string, at?:number}} cache - 复用的缓存槽
 * @param {number} [ttlMs]
 * @returns {string|undefined}
 */
export function readGitBranch(startDir, now, cache, ttlMs = 2000) {
  if (cache.value !== undefined && cache.at !== undefined && now - cache.at < ttlMs) return cache.value

  let branch
  try {
    let dir = startDir
    let gitDir
    for (let depth = 0; depth < 12 && dir !== undefined; depth += 1) {
      const candidate = path.join(dir, '.git')
      if (fs.existsSync(candidate)) {
        gitDir = candidate
        break
      }
      const parent = path.dirname(dir)
      dir = parent === dir ? undefined : parent
    }
    if (gitDir === undefined) {
      cache.value = undefined
      cache.at = now
      return undefined
    }

    const stat = fs.statSync(gitDir)
    // 工作树里的 .git 是个文件，内容是 `gitdir: /path/to/real`
    let headPath = path.join(gitDir, 'HEAD')
    if (stat.isFile()) {
      const pointer = fs.readFileSync(gitDir, 'utf8').trim()
      const match = /^gitdir:\s*(.+)$/.exec(pointer)
      if (match === null) {
        cache.value = undefined
        cache.at = now
        return undefined
      }
      headPath = path.join(match[1], 'HEAD')
    }

    const head = fs.readFileSync(headPath, 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    branch = ref !== null ? ref[1] : head.slice(0, 7)
  } catch {
    branch = undefined
  }

  cache.value = branch
  cache.at = now
  return branch
}

/**
 * 沙箱模式 → 状态栏上的短标签。
 *
 * `danger-full-access` 显示成 `yolo`：跟你在 pi 里用的词一致，一眼能认出来。
 * @param {string|undefined} mode
 */
export function shortSandboxMode(mode) {
  if (mode === undefined || mode === null || mode === '') return undefined
  if (mode === 'danger-full-access') return 'yolo'
  return mode
}

/**
 * 状态栏用量的配色档位。
 * @param {number|undefined} ratio - used / limit
 */
function tokenTone(ratio) {
  if (ratio === undefined) return 'muted'
  if (ratio >= 0.95) return 'error'
  if (ratio >= 0.8) return 'warning'
  return 'muted'
}

/**
 * 汇总状态栏需要的全部真实数据。
 *
 * 所有取数都在这里，并且**只在这里**——footer 组件本身是纯渲染。
 *
 * @param {object} options
 * @param {object} options.ctx          - 插件上下文
 * @param {()=>object|undefined} options.getAgent   - 当前 agent（可能尚未建好）
 * @param {()=>({provider?:string,model?:string}|undefined)} options.getSelection
 * @param {string} [options.cwd]
 */
export function createFooterInfo({ ctx, getAgent, getSelection, cwd = process.cwd() }) {
  const gitCache = {}
  let contextLimit
  let limitResolved = false
  /** tokenMeter 的测量结果缓存：按会话日志版本号失效。 */
  let tokenCache = { seq: -1, used: undefined }
  /** 最近一次请求的真实路由（增量扫描，只读新事件）。 */
  let latestRouteCache
  let eventTail

  /**
   * 最近一次请求**实际用的**路由（fallback）。
   *
   * 优先级：`getSelection()`（下一步要用的路由，/model 运行时切换会立即更新它）
   * 高于会话日志里最后一条 `request/header`（上一次实际用的）。历史路由只在
   * 没有任何可用选择时兜底——底栏显示的是「下一步将用什么」。
   *
   * 用增量读（`createEventTail`）而不是每次全量扫：这个函数每帧都会被调用，
   * 全量扫会退化成 O(n²)。**注意活会话要用 `eventAt(seq)`**——`session.events`
   * 在活会话上是空的，见 src/session-events.js。
   */
  function latestRoute() {
    const session = getAgent()?.session
    if (session === undefined || session === null) return latestRouteCache
    eventTail ??= createEventTail(session)

    let fresh
    try {
      fresh = eventTail()
    } catch {
      return latestRouteCache
    }

    for (const event of fresh) {
      if (event?.type !== 'request/header') continue
      const config = event.data?.header?.config
      if (config === null || typeof config !== 'object') continue
      latestRouteCache = {
        provider: typeof config.provider === 'string' ? config.provider : undefined,
        model: typeof config.model === 'string' ? config.model : undefined,
        effort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : undefined,
      }
    }

    if (process.env.DSH_TUI_DEBUG_FOOTER === '1' && fresh.length > 0) {
      process.stderr.write(
        `\ndsh-tui[footer] 新事件 ${fresh.length} 条（${fresh.map((e) => e?.type).join(',')}）route=${latestRouteCache === undefined ? 'none' : JSON.stringify(latestRouteCache)}\n`,
      )
    }
    return latestRouteCache
  }

  /** 模型上下文窗口只需要解析一次（异步），其余每帧同步读。 */
  async function resolveContextLimit() {
    if (limitResolved) return
    limitResolved = true
    const selection = getSelection()
    if (selection?.provider === undefined || selection?.model === undefined) return
    try {
      const info = await ctx.get('llm')?.resolveModelInfo?.(selection.provider, selection.model)
      const limit = info?.contextWindow ?? info?.context?.contextWindow
      if (Number.isFinite(limit)) contextLimit = limit
    } catch {
      // 模型目录没报窗口时就不显示上限，而不是编一个。
    }
  }

  /** 当前上下文占用。按会话 seq 缓存——measure 会重放日志，不能每帧调。 */
  function measureTokens() {
    const agent = getAgent()
    const session = agent?.session
    if (session === undefined || session === null) return undefined

    const meter = ctx.get('tokenMeter')
    if (meter === undefined || typeof meter.measure !== 'function') return undefined

    const seq = session.seq ?? -1
    if (tokenCache.seq === seq) return tokenCache.used
    try {
      const measurement = meter.measure(session)
      const used = measurement?.totalTokens
      tokenCache = { seq, used: Number.isFinite(used) ? used : undefined }
    } catch {
      tokenCache = { seq, used: undefined }
    }
    return tokenCache.used
  }

  /** 当前生效的沙箱模式。 */
  function sandboxMode() {
    const agent = getAgent()
    try {
      const policy = ctx.get('sandboxPolicy')
      if (policy === undefined) return undefined
      if (agent?.session !== undefined && typeof policy.resolve === 'function') {
        return policy.resolve({ session: agent.session })?.mode
      }
      if (typeof policy.overrideOf === 'function' && agent?.session !== undefined) {
        return policy.overrideOf(agent.session)
      }
    } catch {
      // 策略服务在会话早期可能还没就绪。
    }
    return undefined
  }

  return {
    /** 后台预热（异步部分只做一次）。 */
    warmUp: resolveContextLimit,
    /**
     * 同步取一份当前快照，供每帧渲染。
     * @returns {{model?:string,dir?:string,branch?:string,tokens?:{used:number,limit?:number},sandbox?:string}}
     */
    snapshot() {
      const selection = getSelection()
      const route = latestRoute()

      // 优先「下一步要用的」（getSelection，/model 切换立即生效），退回
      // 「上一次实际用的」（request/header）。只显示模型名——与 pi 的底栏一致。
      const model = selection?.model ?? route?.model
      const effort = selection?.reasoningEffort ?? route?.effort

      const used = measureTokens()
      // 用 path.basename 而不是 split('/')：后者在 Windows 上会把整个路径
      // 当文件名显示出来。
      const base = path.basename(cwd)
      return {
        model,
        thinking: effort,
        dir: base === '' ? cwd : base,
        branch: readGitBranch(cwd, Date.now(), gitCache),
        tokens: used === undefined ? undefined : { used, limit: contextLimit },
        sandbox: shortSandboxMode(sandboxMode()),
      }
    },
  }
}

/**
 * 默认底栏。
 *
 * 可替换实现点：`registry.setFooter(component)` 换掉它。
 */
export class DefaultFooter {
  /**
   * @param {object} options
   * @param {object} options.theme
   * @param {object} options.registry
   * @param {()=>object} options.getSnapshot - createFooterInfo().snapshot
   * @param {()=>string|undefined} [options.getSessionLabel]
   */
  constructor({ theme, registry, getSnapshot, getSessionLabel }) {
    this.theme = theme
    this.registry = registry
    this.getSnapshot = getSnapshot
    this.getSessionLabel = getSessionLabel ?? (() => undefined)
    this.cache = undefined
    this.lastKey = undefined
  }

  invalidate() {
    this.cache = undefined
  }

  /**
   * 把快照拼成分段列表。每段可以是 {text,tone} 或 {parts:[{text,tone}]}
   * （一段内多色，比如 `dir` 标签青、目录名亮）。
   */
  buildSegments(snapshot) {
    const segments = []

    // 模型名：亮白（对照 pi，模型段是整条栏里最亮的一项）。
    if (snapshot.model !== undefined) segments.push({ text: snapshot.model, tone: 'text' })
    // 推理强度：`think:` 标签与档位同色暖黄。
    if (snapshot.thinking !== undefined) segments.push({ text: `think:${snapshot.thinking}`, tone: 'thinkLabel' })
    if (snapshot.dir !== undefined) {
      segments.push({ parts: [{ text: 'dir ', tone: 'dirLabel' }, { text: snapshot.dir, tone: 'text' }] })
    }
    if (snapshot.branch !== undefined) {
      segments.push({ parts: [{ text: '⎇ ', tone: 'branchLabel' }, { text: snapshot.branch, tone: 'branchLabel' }] })
    }

    const tokens = snapshot.tokens
    if (tokens !== undefined) {
      const used = formatTokens(tokens.used)
      const limit = formatTokens(tokens.limit)
      if (used !== undefined) {
        const ratio = tokens.limit === undefined ? undefined : tokens.used / tokens.limit
        const percent = ratio === undefined ? undefined : ` (${(ratio * 100).toFixed(1)}%)`
        const text = limit === undefined ? `${used} tok` : `${used}/${limit}${percent}`
        segments.push({ text, tone: tokenTone(ratio) })
      }
    }

    if (snapshot.sandbox !== undefined) {
      segments.push({
        text: snapshot.sandbox,
        tone: snapshot.sandbox === 'yolo' ? 'warning' : 'muted',
        separator: MODE_SEPARATOR,
      })
    }

    // 注册表里的状态片段：调用方已自带配色，原样接在后面。
    for (const text of this.registry.statusTexts()) segments.push({ text, tone: undefined })

    return segments
  }

  render(width) {
    const theme = this.theme
    const snapshot = this.getSnapshot()
    const segments = this.buildSegments(snapshot)
    const sessionLabel = this.getSessionLabel()

    const plain = segments.map((s) => s.text).join(SEPARATOR) + '|' + (sessionLabel ?? '')
    if (this.cache !== undefined && this.lastKey === plain) return this.cache
    this.lastKey = plain

    const stylePart = (part) => (part.tone === undefined ? part.text : theme.fg(part.tone, part.text))
    const style = (s) => (s.parts === undefined ? stylePart(s) : s.parts.map(stylePart).join(''))

    // 逐段拼接，让每段可以自带分隔符（模式段用的是 `·` 而不是 `|`）。
    let left = ''
    for (const segment of segments) {
      if (left !== '') left += theme.fg('dim', segment.separator ?? SEPARATOR)
      left += style(segment)
    }
    let right = sessionLabel === undefined ? '' : theme.fg('dim', sessionLabel)

    // 宽度不够时按「先丢右、再截左」的顺序退让，保证永远不溢出。
    const leftWidth = visibleWidth(left)
    const rightWidth = visibleWidth(right)
    if (leftWidth + rightWidth + 3 > width) {
      right = ''
      if (leftWidth + 2 > width) left = truncateToWidth(left, Math.max(0, width - 2))
    }

    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2)
    const body = ' ' + left + ' '.repeat(gap) + right + ' '

    // 顶部分隔线：暖琥珀（pi 的 powerline 底栏同款语气），而不是和正文同色的灰线。
    this.cache = [theme.fg('footerBorder', '─'.repeat(width)), truncateToWidth(body, width)]
    return this.cache
  }
}
