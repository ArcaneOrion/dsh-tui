/**
 * UI 实现点注册表 —— 本前门的架构核心。
 *
 * 设计原则（这条决定了这个 TUI 能不能被改造）：
 *
 *   每一个界面区域都是一个**可整体替换的单一实现点**，而不是写死在
 *   应用里的常量。默认实现由应用自己安装，第三方（或未来的你）可以用
 *   同样的接口把它换掉。
 *
 * 对比一下两种做法的代价：
 *   - 写死：想给所有消息加外框，只能去 patch 组件原型（脆弱、要 fail-closed）。
 *   - 注册表：`registry.setMessageRenderer('assistant', MyFrame)` 一行的事。
 *
 * 约定：
 *   - 每个 setRegister 返回 **disposer**，卸载时还原上一个实现。
 *   - 所有变更通过 `subscribe` 通知，宿主据此 requestRender。
 *   - 注册被拒绝（重复 key、非法参数）时**抛错**而非静默忽略 —— 这是
 *     第一方内部接口，不该宽容错误；对外插件接口才需要 fail-soft。
 */

/** 消息角色。渲染管线按角色选组件。 */
export const MessageRole = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  REASONING: 'reasoning',
  TOOL: 'tool',
  NOTICE: 'notice',
})

/** 所有合法角色，供缺省渲染器兜底。 */
export const MESSAGE_ROLES = Object.freeze(Object.values(MessageRole))

/** 编辑器上下方挂件的落点。 */
export const WidgetPlacement = Object.freeze({
  ABOVE_EDITOR: 'above-editor',
  BELOW_EDITOR: 'below-editor',
})

/**
 * 创建一个注册表实例。一个应用实例一个，不共享全局状态。
 * @returns {object} 注册表
 */
export function createRegistry() {
  /** @type {Record<string, unknown>} */
  const surfaces = {
    header: undefined, // Component | undefined
    footer: undefined, // Component | undefined
    editor: undefined, // (tui, theme, registry) => Component | undefined
    workingIndicator: undefined, // { frames: string[], intervalMs?: number }
  }

  /** 状态栏片段：key → { text, order } */
  const statuses = new Map()
  /** 挂件：key → { component, placement, order } */
  const widgets = new Map()
  /** 消息渲染器：role → factory({ row, theme, registry }) => Component */
  const messageRenderers = new Map()

  const listeners = new Set()
  let revision = 0
  let orderCounter = 0

  function bump() {
    revision += 1
    for (const fn of listeners) {
      try {
        fn(revision)
      } catch {
        // 通知失败不能影响其它订阅者，也不能打断注册流程本身。
      }
    }
  }

  /** 订阅任何界面变更。返回退订函数。 */
  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  // ── 整块区域 ──────────────────────────────────────────────────────────

  /** 顶部区域。传 undefined 还原为「无 header」。 */
  function setHeader(component) {
    const previous = surfaces.header
    surfaces.header = component
    bump()
    return () => {
      surfaces.header = previous
      bump()
    }
  }

  /** 底部区域。传 undefined 还原为内置状态栏。 */
  function setFooter(component) {
    const previous = surfaces.footer
    surfaces.footer = component
    bump()
    return () => {
      surfaces.footer = previous
      bump()
    }
  }

  /**
   * 输入框。传工厂函数而非实例：编辑器需要 tui/theme 才能构造，
   * 而这两者只有应用内部拿得到。
   * 传 undefined 还原为默认 Editor。
   */
  function setEditor(factory) {
    const previous = surfaces.editor
    surfaces.editor = factory
    bump()
    return () => {
      surfaces.editor = previous
      bump()
    }
  }

  /**
   * 正在工作的指示器（spinner）。传 `{ frames: [] }` 隐藏；
   * 传 undefined 还原默认。
   */
  function setWorkingIndicator(options) {
    const previous = surfaces.workingIndicator
    surfaces.workingIndicator = options === undefined ? undefined : { ...options }
    bump()
    return () => {
      surfaces.workingIndicator = previous
      bump()
    }
  }

  // ── 片段 ──────────────────────────────────────────────────────────────

  /**
   * 状态栏片段。key 相同则覆盖。
   * @param {string} key - 片段标识（一般用插件名）
   * @param {string|undefined} text - 文本；undefined 表示移除
   * @param {{ order?: number }} [options]
   */
  function setStatus(key, text, options = {}) {
    if (typeof key !== 'string' || key === '') throw new Error('setStatus: key must be a non-empty string')
    // 记住「我装进去的那个值」和「我替换掉的前值」。
    // disposer 的契约是「还原上一个实现」，但**只有当当前值仍是我装的那个**时
    // 才还原——否则别人早改过它了，我不该把别人的值抹掉。
    // （只记前值是不够的：两个使用者共用同一个 key 时，先撤的那个会把后一个
    //   的值一起清掉。）
    const previous = statuses.get(key)
    const installed = text === undefined ? undefined : { text: String(text), order: options.order ?? orderCounter++ }
    if (installed === undefined) statuses.delete(key)
    else statuses.set(key, installed)
    bump()
    return () => {
      if (statuses.get(key) !== installed) return
      if (previous === undefined) statuses.delete(key)
      else statuses.set(key, previous)
      bump()
    }
  }

  /**
   * 编辑器上方/下方的常驻挂件。
   * @param {string} key
   * @param {unknown} component - Component | string[] | undefined（undefined 表示移除）
   * @param {{ placement?: string, order?: number }} [options]
   */
  function setWidget(key, component, options = {}) {
    if (typeof key !== 'string' || key === '') throw new Error('setWidget: key must be a non-empty string')
    const placement = options.placement ?? WidgetPlacement.ABOVE_EDITOR
    const previous = widgets.get(key)
    const installed =
      component === undefined ? undefined : { component, placement, order: options.order ?? orderCounter++ }
    if (installed === undefined) widgets.delete(key)
    else widgets.set(key, installed)
    bump()
    return () => {
      if (widgets.get(key) !== installed) return
      if (previous === undefined) widgets.delete(key)
      else widgets.set(key, previous)
      bump()
    }
  }

  /**
   * 注册某个角色的消息渲染器。**这是"给所有消息加外框"的正确入口。**
   * @param {string} role - MessageRole 之一，或 '*' 表示兜底
   * @param {(ctx: { row: object, theme: object, registry: object }) => unknown} factory
   */
  function setMessageRenderer(role, factory) {
    if (typeof role !== 'string' || role === '') throw new Error('setMessageRenderer: role must be a non-empty string')
    if (typeof factory !== 'function') throw new Error('setMessageRenderer: factory must be a function')
    const previous = messageRenderers.get(role)
    messageRenderers.set(role, factory)
    bump()
    return () => {
      if (previous === undefined) messageRenderers.delete(role)
      else messageRenderers.set(role, previous)
      bump()
    }
  }

  // ── 读取 ──────────────────────────────────────────────────────────────

  /** 按角色取渲染器，找不到则回退到 '*' 兜底。 */
  function messageRendererFor(role) {
    return messageRenderers.get(role) ?? messageRenderers.get('*')
  }

  /** 按 order 排序的状态栏片段文本数组。 */
  function statusTexts() {
    return [...statuses.values()].sort((a, b) => a.order - b.order).map((s) => s.text)
  }

  /** 取某一落点的挂件，按 order 排序。 */
  function widgetList(placement) {
    return [...widgets.values()]
      .filter((w) => w.placement === placement)
      .sort((a, b) => a.order - b.order)
  }

  return {
    // 变更
    setHeader,
    setFooter,
    setEditor,
    setWorkingIndicator,
    setStatus,
    setWidget,
    setMessageRenderer,
    // 订阅
    subscribe,
    get revision() {
      return revision
    },
    // 读取
    get header() {
      return surfaces.header
    },
    get footer() {
      return surfaces.footer
    },
    get editorFactory() {
      return surfaces.editor
    },
    get workingIndicator() {
      return surfaces.workingIndicator
    },
    messageRendererFor,
    statusTexts,
    widgetList,
    /** 已注册的角色列表（含 '*'），供诊断。 */
    registeredRoles: () => [...messageRenderers.keys()],
  }
}
