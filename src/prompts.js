/**
 * 弹窗层：审批与提问用的模态交互。
 *
 * 为什么需要它：`approval/request` 与 `user-questions/request` 都是 **waterfall**
 * ——内核会停下来等一个回答。没有应答者时它们 fail-closed（审批落到
 * `unavailable`，工具直接失败）。所以这两个弹窗不是装饰，是「能不能干活」的开关。
 *
 * 实现用 pi-tui 的 overlay：它渲染在现有内容之上、不占布局、且接管键盘焦点。
 *
 * 两个必须做对的地方（都是实测/审查踩出来的）：
 *
 * 1. **必须能兜底结算。** 弹窗的 Promise 只在「用户选了 / 按了 Esc」时才 settle，
 *    但还有四条路会让它永远不 settle：`app.dispose()`、退出路径里
 *    `await kernel.dispose()`（它可能正在等这次工具调用）、组件 render 抛错、
 *    以及外部直接 `tui.hideOverlay()`。任何一条都会把内核的 waterfall 永久挂住。
 *    所以每个弹窗都登记进 `pending`，`cancelAll()` 一次性结算全部。
 *
 * 2. **overlay 只调顶层组件的 handleInput。** `Box`/`Container` 不实现它，
 *    直接把容器交给 overlay，键盘会石沉大海——必须转发给内部的列表/编辑器。
 */

import { Box, Container, Editor, SelectList, Spacer, Text } from '@earendil-works/pi-tui'

/** 默认的按键提示。 */
const CHOOSE_HINT = '↑↓ 选择 · Enter 确认 · Esc 取消'
const TEXT_HINT = 'Enter 提交 · Esc 取消'

/**
 * 造一个把 `handleInput` 转发给内部组件的包装。
 *
 * render/handleInput 都可能抛（组件 bug、极端终端）。抛出去会让 overlay 每帧
 * 抛错、永远画不出来也永远等不到回答，所以在这里兜住并上报给调用方结算——
 * **宁可关掉弹窗，不可挂住内核**。
 */
export function forwarding(container, onInput, tui, onError) {
  return {
    render(width) {
      try {
        return container.render(width)
      } catch (error) {
        onError(error)
        return []
      }
    },
    invalidate() {
      try {
        container.invalidate()
      } catch {
        // 无缓存的组件不实现它也不该炸。
      }
    },
    handleInput(data) {
      try {
        onInput(data)
      } catch (error) {
        onError(error)
        return
      }
      tui.requestRender()
    },
  }
}

/**
 * 创建弹窗工厂。
 *
 * @param {object} options
 * @param {object} options.tui   - pi-tui 的 TUI 实例
 * @param {object} options.theme - createTheme() 的产物
 */
export function createPrompter({ tui, theme }) {
  /**
   * 所有还没结算的弹窗的结算函数。
   * `cancelAll()` 靠它把内核从永久等待里救出来——见文件头第 1 条。
   * @type {Set<(reason:string)=>void>}
   */
  const pending = new Set()

  /**
   * 一个弹窗的通用骨架：登记 → 渲染 → 结算 → 注销。
   * @param {(finish:(value:any)=>void)=>object} build - 构造交给 overlay 的组件
   * @param {object} overlayOptions
   */
  function open(build, overlayOptions) {
    return new Promise((resolve) => {
      let handle
      let settled = false

      const finish = (value) => {
        if (settled) return
        settled = true
        pending.delete(finish)
        try {
          handle?.hide()
        } catch {
          // overlay 可能已经被整体拆掉了（退出路径）；不能因此吞掉回答。
        }
        resolve(value)
      }

      pending.add(finish)

      let component
      try {
        component = build(finish)
      } catch {
        finish(undefined)
        return
      }

      try {
        handle = tui.showOverlay(component, overlayOptions)
        handle.focus?.()
      } catch {
        // 终端不支持 overlay（极窄/极简）时不要卡住内核，直接给出取消。
        finish(undefined)
      }
    })
  }

  /** 弹窗外框：底色块 + 标题 + 可选说明。 */
  function frame(title, detail) {
    const box = new Box(1, 0, (s) => theme.bg('selectedBg', s))
    box.addChild(new Text(theme.fg('accent', theme.bold(title)), 0, 0))
    if (typeof detail === 'string' && detail !== '') {
      box.addChild(new Text(theme.fg('muted', detail), 0, 0))
    }
    box.addChild(new Spacer(1))
    return box
  }

  /**
   * 弹一个选择框。
   *
   * @param {object} spec
   * @param {string} spec.title
   * @param {string} [spec.detail]
   * @param {Array<{value:string,label:string,description?:string}>} spec.options
   * @returns {Promise<string|undefined>} 选中值；取消时为 undefined
   */
  function choose({ title, detail, options, hint = CHOOSE_HINT, maxVisible = 8 }) {
    return open(
      (finish) => {
        const list = new SelectList(options, Math.min(options.length, maxVisible), theme.selectList)
        list.onSelect = (item) => finish(item.value)
        list.onCancel = () => finish(undefined)

        const container = new Container()
        const box = frame(title, detail)
        box.addChild(list)
        box.addChild(new Spacer(1))
        box.addChild(new Text(theme.fg('dim', hint), 0, 0))
        container.addChild(box)

        return forwarding(container, (data) => list.handleInput(data), tui, () => finish(undefined))
      },
      { anchor: 'center', width: '70%', minWidth: 40, maxHeight: '70%' },
    )
  }

  /**
   * 弹一个单行文本输入框（提问没有选项时用）。
   *
   * @param {object} spec
   * @param {string} spec.title
   * @param {string} [spec.detail]
   * @returns {Promise<string|undefined>}
   */
  function askText({ title, detail, hint = TEXT_HINT }) {
    return open(
      (finish) => {
        const editor = new Editor(tui, theme.editor)
        editor.onSubmit = (text) => {
          const raw = String(text ?? '')
          // 允许提交空串：有些问题就是要「不填」。取消走 Esc。
          finish(raw.trim())
        }

        const container = new Container()
        const box = frame(title, detail)
        box.addChild(editor)
        box.addChild(new Text(theme.fg('dim', hint), 0, 0))
        container.addChild(box)

        // Esc 取消需要自己拦：Editor 不处理 Esc。
        return forwarding(
          container,
          (data) => {
            if (data === '\x1b') {
              finish(undefined)
              return
            }
            editor.handleInput?.(data)
          },
          tui,
          () => finish(undefined),
        )
      },
      { anchor: 'center', width: '70%', minWidth: 40 },
    )
  }

  /**
   * 一次性结算所有还在等的弹窗。
   *
   * 退出路径**必须**调它：否则 `await kernel.dispose()` 可能在等一个永远不来的
   * 审批回答，`shutdown()` 于是走不到 process.exit，进程卡死。
   *
   * @returns {number} 被结算的弹窗数量
   */
  function cancelAll() {
    const count = pending.size
    for (const finish of [...pending]) finish(undefined)
    pending.clear()
    return count
  }

  return {
    choose,
    askText,
    cancelAll,
    /** 当前还有几个弹窗在等回答（诊断用）。 */
    pendingCount: () => pending.size,
  }
}
