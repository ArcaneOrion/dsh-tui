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

import { Box, Container, Editor, SelectList, Spacer, Text, fuzzyFilter, truncateToWidth } from '@earendil-works/pi-tui'
import { DocumentView } from './document.js'

/** 默认的按键提示。 */
const CHOOSE_HINT = '↑↓ 选择 · 输入即搜索 · Backspace 退格 · Enter 确认 · Esc 取消'
const TEXT_HINT = 'Enter 提交 · Esc 取消'

/**
 * 可搜索的选择框内部状态：输入字符即过滤（pi-tui 的 fuzzyFilter，多 token
 * 子序列匹配），Backspace 退格，Enter 选中当前项。
 *
 * SelectList 自带的 setFilter 只做「value 前缀匹配」且空结果文案是英文写死的，
 * 所以在拦截层做自己的过滤、每次重建列表（列表很小，重建是廉价操作）。
 *
 * @param {object} spec
 * @param {Array<{value:string,label:string,description?:string}>} spec.options
 * @param {number} spec.maxVisible
 * @param {(item: {value:string,label:string,description?:string}|undefined) => void} spec.onPick
 */
function searchableList({ theme, options, maxVisible, onPick }) {
  let query = ''

  function computeFiltered() {
    if (query === '') return options
    let filtered = fuzzyFilter(options, query, (item) => `${item.value} ${item.label}`)
    if (filtered.length === 0) {
      // 子序列太严（比如按中文渠道名搜）时退回子串匹配；再不行才真空。
      const lower = query.toLowerCase()
      filtered = options.filter(
        (item) => item.value.toLowerCase().includes(lower) || String(item.label).toLowerCase().includes(lower),
      )
    }
    return filtered
  }

  /**
   * 只建一次实例。mount 挂进外框的就是它——过滤时**原地**更新 items /
   * filteredItems / selectedIndex（SelectList 的公开字段）。
   * 每次重建实例是上一版的 bug：挂在外框里的永远是旧实例，输入过滤毫无效果。
   */
  const list = new SelectList(options, Math.max(1, Math.min(options.length, maxVisible)), theme.selectList)
  list.onSelect = (item) => onPick(item)
  list.onCancel = () => onPick(undefined)

  /** 过滤行：无状态的闭包组件，每次 render 现算，绕开 Text 的缓存。 */
  const filterLine = {
    render(width) {
      if (query === '') return []
      return [truncateToWidth(theme.fg('accent', `搜索: ${query}_`), width)]
    },
    invalidate() {},
  }

  function applyFilter() {
    const filtered = computeFiltered()
    list.items = filtered
    list.filteredItems = [...filtered]
    list.selectedIndex = 0
  }

  return {
    /** 把过滤行与列表挂进外框，返回接收焦点的列表。 */
    mount(frameBox) {
      frameBox.addChild(filterLine)
      frameBox.addChild(list)
      return list
    },
    /** 拦截层输入：先吃搜索键，其余转发给列表。 */
    handleInput(data) {
      if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
        query += data
        applyFilter()
        return
      }
      if (data === '\x7f' || data === '\b') {
        query = Array.from(query).slice(0, -1).join('')
        applyFilter()
        return
      }
      list.handleInput(data)
    },
  }
}

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
  function open(build, overlayOptions, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve(undefined); return }
      let handle
      let settled = false

      const finish = (value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        pending.delete(finish)
        try {
          handle?.hide()
        } catch {
          // overlay 可能已经被整体拆掉了（退出路径）；不能因此吞掉回答。
        }
        resolve(value)
      }

      const onAbort = () => finish(undefined)
      signal?.addEventListener('abort', onAbort, { once: true })

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

  /** 弹窗外框：暗面板色 + 强调标题。整块亮底色会把终端变成一面灰墙。 */
  function frame(title, detail) {
    const box = new Box(1, 1, (s) => theme.bg('panelBg', s))
    box.addChild(new Text(theme.fg('accent', theme.bold(title)), 1, 0))
    if (typeof detail === 'string' && detail !== '') {
      const preview = detail.length > 240 ? detail.slice(0, 240) + '…' : detail
      box.addChild(new Text(theme.fg('muted', preview.split('\n').slice(0, 4).join('\n')), 1, 0))
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
  function choose({ title, detail, options, hint = CHOOSE_HINT, maxVisible = 8, signal }) {
    return open(
      (finish) => {
        const picker = searchableList({
          theme,
          options,
          maxVisible: Math.min(maxVisible, Math.max(1, Math.floor((tui.terminal?.rows ?? 30) * 0.85) - 12)),
          onPick: (item) => finish(item === undefined ? undefined : item.value),
        })

        const container = new Container()
        const box = frame(title, detail)
        picker.mount(box)
        box.addChild(new Spacer(1))
        box.addChild(new Text(theme.fg('dim', hint), 0, 0))
        container.addChild(box)

        return forwarding(
          container,
          (data) => picker.handleInput(data),
          tui,
          (error) => {
            // 静默吞错会让弹窗无声消失，用户以为输入坏了。诊断开关下先留证据。
            if (process.env.DSH_TUI_DEBUG_PROMPT === '1') {
              process.stderr.write(`dsh-tui[prompt] choose error: ${error?.stack ?? error}\n`)
            }
            finish(undefined)
          },
        )
      },
      // 底部居中：贴着输入框上方弹出，视线不用跳到屏幕中央。
      { anchor: 'center', width: '85%', minWidth: 24, maxWidth: '96%', maxHeight: '85%' },
      signal,
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
  function askText({ title, detail, hint = TEXT_HINT, signal }) {
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
      { anchor: 'center', width: '85%', minWidth: 24, maxWidth: '96%', maxHeight: '85%' },
      signal,
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
    document({ title, text, signal }) {
      return open((finish) => new DocumentView({ title, text, theme,
        getHeight: () => tui.terminal?.rows ?? 24, onClose: () => finish(true) }),
      { anchor: 'center', width: '94%', minWidth: 20, maxWidth: '100%', maxHeight: '95%' }, signal)
    },
    cancelAll,
    /** 当前还有几个弹窗在等回答（诊断用）。 */
    pendingCount: () => pending.size,
  }
}
