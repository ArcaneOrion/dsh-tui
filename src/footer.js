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
import os from 'node:os'
import path from 'node:path'

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { createEventTail } from './session-events.js'
import { fit, pair } from './layout.js'

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
  if (cache.at !== undefined && now - cache.at < ttlMs) return cache.value

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
      headPath = path.join(path.resolve(path.dirname(gitDir), match[1]), 'HEAD')
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
 * HOME 前缀换成 `~`（与 pi 的底栏一致）。不匹配时原样返回。
 * @param {string|undefined} target
 * @param {string} [home]
 */
export function shortenHome(target, home = os.homedir()) {
  if (typeof target !== 'string' || target === '') return undefined
  if (typeof home !== 'string' || home === '' || !target.startsWith(home)) return target
  return '~' + target.slice(home.length)
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
export function createFooterInfo({ ctx, getAgent, getSelection, cwd = process.cwd(), onUpdate }) {
  const gitCache = {}
  let contextLimit
  let limitKey
  const limits = new Map()
  /** tokenMeter 的测量结果缓存：按会话日志版本号失效。 */
  let tokenCache = { seq: -1, used: undefined }
  /** 最近一次请求的真实路由（增量扫描，只读新事件）。 */
  let latestRouteCache
  let eventTail
  let observedSession

  /**
   * 机器指标（CPU / 内存 / 时间）。每秒最多采一次——footer 每帧都渲染，
   * `os.cpus()` 会分配数组，不能每帧调；loadavg 本身很便宜。
   */
  const cpuCount = Math.max(1, os.cpus()?.length ?? 1)
  let metricsCache = { at: 0, cpu: undefined, mem: undefined, clock: undefined }

  function metrics(now) {
    if (now - metricsCache.at < 1000) return metricsCache
    let cpu
    try {
      const load = os.loadavg?.()[0]
      if (Number.isFinite(load)) cpu = Math.max(0, Math.min(100, Math.round((load / cpuCount) * 100)))
    } catch {
      cpu = undefined
    }
    let mem
    try {
      const total = os.totalmem()
      if (Number.isFinite(total) && total > 0) {
        mem = Math.max(0, Math.min(100, Math.round(((total - os.freemem()) / total) * 100)))
      }
    } catch {
      mem = undefined
    }
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
    metricsCache = {
      at: now,
      cpu,
      mem,
      clock: `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    }
    return metricsCache
  }

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
    if (session !== observedSession) {
      observedSession = session
      eventTail = undefined
      latestRouteCache = undefined
      tokenCache = { seq: -1, used: undefined }
      gitCache.at = undefined
    }
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
    const selection = getSelection()
    if (selection?.provider === undefined || selection?.model === undefined) return
    const key = JSON.stringify([selection.provider, selection.model])
    if (key === limitKey) return limits.get(key)
    limitKey = key
    contextLimit = undefined
    if (!limits.has(key)) {
      limits.set(key, Promise.resolve().then(async () => {
        try {
          const info = await ctx.get('llm')?.resolveModelInfo?.(selection.provider, selection.model)
          const limit = info?.contextWindow ?? info?.context?.contextWindow
          return Number.isFinite(limit) && limit > 0 ? limit : undefined
        } catch { return undefined }
      }))
    }
    const limit = await limits.get(key)
    if (limitKey === key) { contextLimit = limit; onUpdate?.() }
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
      const key = selection ? JSON.stringify([selection.provider, selection.model]) : undefined
      if (key !== limitKey && selection) void resolveContextLimit()
      const recordedContext = getAgent()?.session?.requestContext?.()
      const recordedLimit = recordedContext && recordedContext.provider === selection?.provider && recordedContext.model === selection?.model
        ? recordedContext.contextWindow : undefined

      // 优先「下一步要用的」（getSelection，/model 切换立即生效），退回
      // 「上一次实际用的」（request/header）。只显示模型名——与 pi 的底栏一致。
      const model = selection?.model ?? route?.model
      const effort = selection ? selection.reasoningEffort : route?.effort

      const used = measureTokens()
      // 用 path.basename 而不是 split('/')：后者在 Windows 上会把整个路径
      // 当文件名显示出来。
      const activeCwd = getAgent()?.session?.header?.cwd ?? cwd
      const base = path.basename(activeCwd)
      const machine = metrics(Date.now())
      return {
        model,
        thinking: effort,
        dir: base === '' ? activeCwd : base,
        path: shortenHome(activeCwd),
        branch: readGitBranch(activeCwd, Date.now(), gitCache),
        tokens: used === undefined ? undefined : { used, limit: recordedLimit ?? (key === limitKey ? contextLimit : undefined) },
        sandbox: shortSandboxMode(sandboxMode()),
        cpu: machine.cpu,
        mem: machine.mem,
        clock: machine.clock,
      }
    },
  }
}

/**
 * 底栏色块段布局常量。
 *
 * 视觉对齐 Claude Code 的状态行：每段一块**饱和底色 + 浅色文字**，段间没有
 * 分隔符，最后一段铺满剩余宽度。数据仍全部来自真实来源（缺就整段消失）。
 */
const SEG_PAD = 1
/** 目录段左截断后至少保留的可见宽度。 */
const DIR_MIN_WIDTH = 10

/** 从左侧截断到 width 个显示列（保留尾部——路径尾部信息量最大）。 */
export function truncateLeft(text, width) {
  const chars = [...String(text ?? '')]
  let out = ''
  let used = 0
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const w = visibleWidth(chars[i])
    if (used + w > width) break
    out = chars[i] + out
    used += w
  }
  return out
}

/**
 * 默认底栏。
 *
 * 可替换实现点：`registry.setFooter(component)` 换掉它。
 *
 * 段顺序（左→右）：模型 · think · 用量 · 沙箱 · 路径 · 分支 · 会话 · 状态片段
 * · CPU · MEM · 时间。窄屏按 priority 从低到高丢弃（1 = 最后丢），所以先消失
 * 的是时间/内存/CPU，最后才动用用量与权限。
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
   * 把快照拼成色块段。
   *
   * @returns {Array<{id:string,text:string,bg:string,priority:number,flex?:boolean}>}
   *   priority 1 = 最优先保留；flex 段可左截断。
   */
  buildSegments(snapshot) {
    const segments = []
    const push = (id, text, bg, priority, extra = undefined) => {
      if (typeof text !== 'string' || text === '') return
      segments.push({ id, text, bg, priority, ...extra })
    }

    push('model', snapshot.model, 'segBlue', 3)
    if (snapshot.thinking !== undefined) push('think', `think:${snapshot.thinking}`, 'segAmber', 7)

    const tokens = snapshot.tokens
    if (tokens !== undefined) {
      const used = formatTokens(tokens.used)
      const limit = formatTokens(tokens.limit)
      if (used !== undefined) {
        const ratio = tokens.limit > 0 ? tokens.used / tokens.limit : undefined
        const percent = ratio === undefined ? '' : ` (${(ratio * 100).toFixed(1)}%)`
        const text = limit === undefined ? `${used} tok` : `${used}/${limit}${percent}`
        const bg = ratio === undefined ? 'segGreen' : ratio >= 0.95 ? 'segRed' : ratio >= 0.8 ? 'segAmber' : 'segGreen'
        push('usage', text, bg, 1)
      }
    }

    if (snapshot.sandbox !== undefined) {
      push('sandbox', snapshot.sandbox, snapshot.sandbox === 'yolo' ? 'segRed' : 'segSlate', 2)
    }

    // 路径优先用 ~ 缩写的完整路径（像 Claude Code 的状态行），缺了退回 basename。
    push('dir', snapshot.path ?? snapshot.dir, 'segTeal', 4, { flex: true })
    if (snapshot.branch !== undefined) push('branch', `⎇ ${snapshot.branch}`, 'segGreen', 5)
    push('session', this.getSessionLabel(), 'segSlate', 11)
    for (const text of this.registry.statusTexts()) push(`status:${text}`, text, 'segSlate', 6)
    if (snapshot.cpu !== undefined) push('cpu', `CPU${snapshot.cpu}%`, 'segGreen', 8)
    if (snapshot.mem !== undefined) push('mem', `MEM${snapshot.mem}%`, 'segBlue', 9)
    if (snapshot.clock !== undefined) push('clock', snapshot.clock, 'segGray', 10)

    return segments
  }

  render(width) {
    const theme = this.theme
    const snapshot = this.getSnapshot()
    const statuses = this.registry.statusTexts()
    const sessionLabel = this.getSessionLabel()

    const plain = JSON.stringify([width, snapshot, statuses, sessionLabel])
    if (this.cache !== undefined && this.lastKey === plain) return this.cache
    this.lastKey = plain

    const kept = this.buildSegments(snapshot)
    const segWidth = (segment) => visibleWidth(segment.text) + SEG_PAD * 2
    const total = () => kept.reduce((sum, segment) => sum + segWidth(segment), 0)
    const flexSeg = kept.find((segment) => segment.flex === true)
    const flexPriority = flexSeg === undefined ? Number.POSITIVE_INFINITY : flexSeg.priority

    // 1) 只丢**比目录段更不重要**的段（priority 数值更大 = 更先丢），
    //    尽量让目录段以完整路径留下。比路径重要的段（用量/权限/模型）绝不为
    //    路径让位——否则窄屏下会把用量挤掉，那是这条栏最该保住的东西。
    for (const victim of [...kept].sort((a, b) => b.priority - a.priority)) {
      if (total() <= width) break
      if (victim === flexSeg || victim.priority <= flexPriority) continue
      kept.splice(kept.indexOf(victim), 1)
    }

    // 2) 还超宽 → 目录段左截断：`…/plugin/DSH-TUI` 比 `~/AI/AI-D…` 有用得多。
    if (flexSeg !== undefined && kept.includes(flexSeg) && total() > width) {
      const others = kept.filter((segment) => segment !== flexSeg).reduce((sum, segment) => sum + segWidth(segment), 0)
      const room = width - others - SEG_PAD * 2
      if (room >= DIR_MIN_WIDTH) flexSeg.text = '…' + truncateLeft(flexSeg.text, room - 1)
    }

    // 3) 还是放不下：丢目录段，再继续按优先级丢，直到放得下。
    if (flexSeg !== undefined && kept.includes(flexSeg) && total() > width) kept.splice(kept.indexOf(flexSeg), 1)
    for (const victim of [...kept].sort((a, b) => b.priority - a.priority)) {
      if (total() <= width) break
      kept.splice(kept.indexOf(victim), 1)
    }

    // 4) 连续色块：每段左右各一个空格内边距；剩余宽度用尾段底色铺满。
    //    尾段是告警/危险色时改用中性色——否则窄屏下会拖出一条刺眼的红/黄长条。
    let line = ''
    for (const segment of kept) {
      line += theme.bg(segment.bg, theme.fg('segText', ' '.repeat(SEG_PAD) + segment.text + ' '.repeat(SEG_PAD)))
    }
    const filled = visibleWidth(line)
    if (filled < width) {
      const tail = kept[kept.length - 1]
      const tailBg = tail === undefined || tail.bg === 'segRed' || tail.bg === 'segAmber' ? 'segSlate' : tail.bg
      line += theme.bg(tailBg, ' '.repeat(width - filled))
    }

    this.cache = [truncateToWidth(line, width, '')]
    return this.cache
  }
}
