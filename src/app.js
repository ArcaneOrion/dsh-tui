/**
 * 主应用外壳：用 pi-tui 把各区域组装成一个终端应用。
 *
 * 关键设计：**这里的每个区域都只是「默认实现」**，一律从 registry 读取
 * 覆盖。没有任何一个区域是写死在组装代码里的常量。所以第三方（或未来的你）
 * 可以换掉 header / footer / editor / 挂件 / 消息渲染器，而不需要改动本文件。
 *
 * 布局（自上而下）：
 *
 *   [header]            可选，registry.setHeader
 *   [chat]              行模型 → 组件 → 行；历史滚入终端原生 scrollback
 *   [working]           回合进行中时的动画行
 *   [widget × n]        编辑器上方挂件
 *   [editor]            可替换
 *   [widget × n]        编辑器下方挂件
 *   [footer]            默认状态栏，可替换
 *
 * 滚动交给终端：pi-tui 只把「底部一个屏高」维持为活视口，其余行推进终端
 * scrollback。所以历史滚动、选择、复制全部是终端原生行为，不需要虚拟列表。
 */

import { Container, Editor, Key, matchesKey, ProcessTerminal, Text, TUI, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { DefaultFooter } from './footer.js'
import { createPrompter } from './prompts.js'
import { WidgetPlacement } from './registry.js'

/** 默认的工作动画帧。 */
const DEFAULT_WORKING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const DEFAULT_WORKING_INTERVAL = 100

/**
 * 对话区组件：把视图模型（行）渲染成终端行。
 *
 * 缓存键是 `(width, view.revision)`：宽度没变、模型没变就复用上一帧的行数组，
 * 这是 pi-tui 要求的 render 约定（它的差分渲染依赖组件自己缓存）。
 */
export class ChatView {
  constructor({ view, theme, registry }) {
    this.view = view
    this.theme = theme
    this.registry = registry
    this.cache = undefined
    this.rowCache = undefined
  }

  invalidate() {
    this.cache = undefined
    // 行级缓存也要清：主题换了之后每一行都得按新配色重画。
    if (this.rowCache !== undefined) this.rowCache.clear()
  }

  /** 渲染单行模型条目，返回字符串数组。 */
  renderRow(row, width) {
    const factory = this.registry.messageRendererFor(row.role)
    if (typeof factory !== 'function') return []
    let component
    try {
      component = factory({ row, theme: this.theme, registry: this.registry })
    } catch (error) {
      return [this.theme.fg('error', `渲染 ${row.role} 行失败：${error?.message ?? error}`)]
    }
    if (component === undefined || component === null) return []
    if (typeof component.render !== 'function') return []
    try {
      return component.render(width)
    } catch (error) {
      return [this.theme.fg('error', `渲染 ${row.role} 行失败：${error?.message ?? error}`)]
    }
  }

  /**
   * 按行缓存渲染结果。
   *
   * 为什么必须做：流式期间每个 token 都会推进 `view.revision`，帧缓存必然失效；
   * 如果这时把几百上千行历史全部重建一遍（每行都 new Box/Markdown/Container），
   * 就是「每个 token 一次全量 Markdown 渲染」。命中这里的缓存后，重绘只剩下
   * 若干次 Map 查表和数组拼接，是一次 O(行数) 的廉价操作，而不是 O(行数) 的重建。
   */
  renderRowCached(row, width) {
    this.rowCache ??= new Map()
    const key = row.key ?? `idx-${this.rowCache.size}`
    const rev = row.rev ?? 0
    const hit = this.rowCache.get(key)
    if (hit !== undefined && hit.rev === rev && hit.width === width) return hit.lines
    const lines = this.renderRow(row, width)
    this.rowCache.set(key, { rev, width, lines })
    return lines
  }

  render(width) {
    if (this.cache !== undefined && this.cache.width === width && this.cache.revision === this.view.revision) {
      return this.cache.lines
    }

    const lines = []
    // 注意：不要用 `lines.push(...arr)` —— 行数上万时会撞参数上限抛 RangeError。
    const append = (arr) => {
      for (const line of arr) lines.push(line)
    }

    for (const row of this.view.rows) {
      append(this.renderRowCached(row, width))
      lines.push('') // 条目之间的空行
    }

    // 正在生成的文本：按 assistant 渲染，末尾加一个光标块。
    // 这一行每帧都会变，所以有意不进行缓存。
    const streaming = this.view.streaming
    if (streaming !== null && (streaming.text !== '' || streaming.reasoning !== '')) {
      const pseudo = {
        key: streaming.key,
        role: 'assistant',
        text: streaming.text + this.theme.fg('accent', '▌'),
        reasoning: streaming.reasoning,
        done: false,
      }
      append(this.renderRow(pseudo, width))
      lines.push('')
    }

    if (lines.length === 0) {
      lines.push('')
      lines.push(this.theme.fg('dim', '  开始输入吧。Ctrl+C 退出，Esc 中断当前回合。'))
      lines.push('')
    }

    this.cache = { width, revision: this.view.revision, lines }
    return lines
  }
}

/**
 * 回合进行中的动画行。
 */
class WorkingLine {
  constructor({ theme, registry, getState }) {
    this.theme = theme
    this.registry = registry
    this.getState = getState
    this.frame = 0
    this.cache = undefined
    this.lastKey = ''
  }

  setFrame(frame) {
    this.frame = frame
    this.cache = undefined
  }

  invalidate() {
    this.cache = undefined
  }

  render(width) {
    const state = this.getState()
    const options = this.registry.workingIndicator
    const frames = options?.frames ?? DEFAULT_WORKING_FRAMES
    const active = state.turnActive === true
    const key = `${active}|${this.frame}|${state.statusText}`
    if (this.cache !== undefined && this.lastKey === key) return this.cache
    this.lastKey = key

    if (!active || frames.length === 0) {
      this.cache = []
      return this.cache
    }

    const spin = frames[this.frame % frames.length]
    const text = state.statusText ?? '正在工作'
    this.cache = [truncateToWidth(' ' + this.theme.fg('accent', spin) + ' ' + this.theme.fg('muted', text), width)]
    return this.cache
  }
}

/**
 * 组装应用。
 *
 * @param {object} options
 * @param {object} options.view       - 投影层的视图模型
 * @param {object} options.theme      - createTheme() 的产物
 * @param {object} options.registry   - createRegistry() 的产物
 * @param {(text:string)=>void} options.onSubmit   - 用户提交了一行输入
 * @param {()=>void} options.onInterrupt           - 请求中断当前回合
 * @param {()=>void} options.onExit                - 请求退出
 * @param {()=>({model?:string,session?:string,mode?:string})} options.getSnapshot - 状态栏数据快照（每帧同步取）
 * @param {()=>string|undefined} [options.getSessionLabel] - 右对齐的会话短标签
 * @param {()=>({turnActive:boolean,statusText?:string})} options.getState
 */
export function createApp(options) {
  const { view, theme, registry, onSubmit, onCommand, onInterrupt, onExit, getSnapshot, getSessionLabel, getState } = options

  const terminal = new ProcessTerminal()
  const tui = new TUI(terminal)
  // 审批与提问用的模态弹窗。内核会停下来等它们的回答。
  const prompter = createPrompter({ tui, theme })

  const root = new Container()
  const headerSlot = new Container()
  const chat = new ChatView({ view, theme, registry })
  const working = new WorkingLine({ theme, registry, getState })
  const aboveWidgets = new Container()
  const belowWidgets = new Container()

  // 编辑器与底栏各自住在一个槽位容器里，registry 一变就整体重建。
  //
  // 这一段是本设计的要害：如果把它们写成常量（`const footer = new DefaultFooter()`），
  // 那么 registry 里的 setFooter / setEditor 就只是**看着存在、实际从不生效**的
  // 死接口 —— 整个「每个区域都可替换」的主张就成了假的。
  const editorSlot = new Container()
  const footerSlot = new Container()

  /** 当前生效的编辑器实例（重建时会换）。 */
  let editor
  /** 当前生效的底栏实例。 */
  let footer
  let disposed = false

  function buildEditor() {
    const factory = registry.editorFactory
    const component =
      typeof factory === 'function' ? factory(tui, theme, registry) : new Editor(tui, theme.editor)
    if (component === undefined || component === null) return component

    component.onSubmit = (text) => {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return
      component.setText('')
      // pi-tui 的 Editor 自带历史；显式记一笔，翻上下键能找回刚发的内容。
      component.addToHistory?.(trimmed)
      // 斜杠行走命令通道，**绝不**当作消息发给模型。
      if (trimmed.startsWith('/')) onCommand?.(trimmed)
      else onSubmit(trimmed)
    }

    // 补全：命令走行首 `/`，文件引用走 `@`。pi-tui 的 Editor 只接受一个
    // provider，所以在这里合流。
    if (typeof component.setAutocompleteProvider === 'function' && options.combineProviders !== undefined) {
      try {
        component.setAutocompleteProvider(options.combineProviders())
      } catch {
        // 补全装不上不影响正常输入。
      }
    }

    return component
  }

  function rebuildEditor() {
    editorSlot.clear()
    editor = buildEditor()
    editorSlot.addChild(editor)
    // 焦点跟着新编辑器走；但**有弹窗时不能抢**，否则模态框会失灵。
    try {
      if (tui.hasOverlay?.() !== true) tui.setFocus(editor)
    } catch {
      // start() 之前 setFocus 可能不可用；start 之后会再设一次。
    }
  }

  function rebuildFooter() {
    footerSlot.clear()
    footer = registry.footer ?? new DefaultFooter({ theme, registry, getSnapshot, getSessionLabel })
    footerSlot.addChild(footer)
  }

  /** 工作动画定时器。帧间隔每次重建时从 registry 现取，所以 setWorkingIndicator 真的生效。 */
  let ticker
  function restartTicker() {
    if (ticker !== undefined) clearInterval(ticker)
    const intervalMs = registry.workingIndicator?.intervalMs ?? DEFAULT_WORKING_INTERVAL
    ticker = setInterval(() => {
      if (disposed) return
      if (getState().turnActive !== true) return
      working.setFrame(working.frame + 1)
      tui.requestRender()
    }, Math.max(16, intervalMs))
    ticker.unref?.()
  }

  // ── 变更响应 ────────────────────────────────────────────────────────────
  //
  // 关键：**只在实现点的引用真的变了时才重建**。
  //
  // 早期版本无条件 `rebuildEditor()`。后果很严重：`setStatus` / `setWidget`
  // 是对外开放的常规接口，一个按 token 刷新状态片段的插件会让订阅回调每帧
  // 触发一次，于是用户正在打的内容、光标位置、编辑历史被反复清空，而且
  // `setFocus` 会把焦点从打开的弹窗上抢走。
  //
  // 重建是「换实现」的动作，不是「界面变了」的动作——这两件事必须分开。
  let lastHeader
  let lastFooter
  let lastEditorFactory
  let lastIndicatorKey
  let lastWidgetKeys = ''

  function widgetKey(list) {
    return list.map((w) => `${w.order}:${Array.isArray(w.component) ? w.component.join('\u0000') : 'c'}`).join('|')
  }

  const unsubscribe = registry.subscribe(() => {
    if (disposed) return

    const header = registry.header
    if (header !== lastHeader) {
      lastHeader = header
      headerSlot.clear()
      if (header !== undefined && header !== null) headerSlot.addChild(header)
    }

    const headWidgets = registry.widgetList(WidgetPlacement.ABOVE_EDITOR)
    const footWidgets = registry.widgetList(WidgetPlacement.BELOW_EDITOR)
    const widgetKeys = widgetKey(headWidgets) + '#' + widgetKey(footWidgets)
    if (widgetKeys !== lastWidgetKeys) {
      lastWidgetKeys = widgetKeys
      rebuildWidgets(aboveWidgets, headWidgets)
      rebuildWidgets(belowWidgets, footWidgets)
    }

    if (registry.editorFactory !== lastEditorFactory) {
      lastEditorFactory = registry.editorFactory
      rebuildEditor()
    }

    if (registry.footer !== lastFooter) {
      lastFooter = registry.footer
      rebuildFooter()
    }

    const indicatorKey = JSON.stringify(registry.workingIndicator ?? null)
    if (indicatorKey !== lastIndicatorKey) {
      lastIndicatorKey = indicatorKey
      restartTicker()
    }

    chat.invalidate()
    working.invalidate()
    tui.requestRender()
  })

  rebuildEditor()
  rebuildFooter()
  restartTicker()

  // 记下初始实现的引用，这样后续通知不会把刚建好的东西又重建一遍
  // （重建 = 丢输入内容 + 抢焦点，代价很高）。
  lastHeader = registry.header
  lastFooter = registry.footer
  lastEditorFactory = registry.editorFactory
  lastIndicatorKey = JSON.stringify(registry.workingIndicator ?? null)
  lastWidgetKeys =
    widgetKey(registry.widgetList(WidgetPlacement.ABOVE_EDITOR)) +
    '#' +
    widgetKey(registry.widgetList(WidgetPlacement.BELOW_EDITOR))

  root.addChild(headerSlot)
  root.addChild(chat)
  root.addChild(working)
  root.addChild(aboveWidgets)
  root.addChild(editorSlot)
  root.addChild(belowWidgets)
  root.addChild(footerSlot)

  tui.addChild(root)
  tui.setFocus(editor)

  // 输入监听：拦截应用级按键。
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl('c'))) {
      if (getState().turnActive === true) onInterrupt()
      else onExit()
      return { consume: true }
    }
    if (matchesKey(data, Key.escape)) {
      if (getState().turnActive === true) {
        onInterrupt()
        return { consume: true }
      }
      return undefined
    }
    return undefined
  })

  return {
    tui,
    /** 弹一个选择框，返回选中值或 undefined。供人机回环使用。 */
    choose: prompter.choose,
    /** 弹一个文本输入框，返回输入内容或 undefined。 */
    askText: prompter.askText,
    get editor() {
      return editor
    },
    /** 重新渲染（模型更新后由 kernel 层调用）。 */
    requestRender: () => {
      if (disposed) return
      chat.invalidate()
      working.invalidate()
      footer?.invalidate?.()
      tui.requestRender()
    },
    /** 在编辑器里放一段文本（语音输入、外部注入等用）。 */
    setEditorText: (text) => {
      if (disposed) return
      editor?.setText?.(text)
      tui.requestRender()
    },
    /** 往对话区插一行本地内容（不进 session）。 */
    pushRow: (row) => {
      if (disposed) return
      view.rows.push({ rev: 0, done: true, key: `local-${view.rows.length + 1}`, ...row })
      // 与 projection.js 的 touch() 保持一致：任何结构变化都要推进 revision，
      // 否则组件的 (width, revision) 缓存会拿到陈旧的一帧。
      view.revision += 1
      chat.invalidate()
      tui.requestRender()
    },
    /** 往对话区插一条本地提示（不进 session）。 */
    notice: (text) => {
      if (disposed) return
      view.rows.push({ key: `notice-${view.rows.length + 1}`, role: 'notice', text, done: true })
      view.revision += 1
      chat.invalidate()
      tui.requestRender()
    },
    /** 一次性结算所有还在等回答的弹窗（退出路径必须先调它）。 */
    cancelPrompts: () => prompter.cancelAll(),
    /** 当前在等回答的弹窗数量（诊断用）。 */
    pendingPrompts: () => prompter.pendingCount(),
    start: () => tui.start(),
    dispose: () => {
      if (disposed) return
      disposed = true
      // **先**结算所有还等着的弹窗：否则退出路径上 `await kernel.dispose()`
      // 可能在等一个永远不来的审批回答，shutdown 就走不到 process.exit。
      prompter.cancelAll()
      if (ticker !== undefined) clearInterval(ticker)
      unsubscribe()
      try {
        tui.stop()
      } catch {
        // 终端可能已经被外部关掉了；退出路径不能因为还原失败而再抛。
      }
    },
  }
}

/** 把挂件列表塞进一个容器（每次 registry 变更时重建）。 */
function rebuildWidgets(container, list) {
  container.clear()
  for (const entry of list) {
    const widget = entry.component
    if (Array.isArray(widget)) {
      container.addChild(new Text(widget.join('\n'), 0, 0))
    } else if (widget !== undefined && widget !== null && typeof widget.render === 'function') {
      container.addChild(widget)
    }
  }
}
