/**
 * 弹窗层：审批与提问用的模态交互。
 *
 * 为什么需要它：`approval/request` 与 `user-questions/request` 都是 **waterfall**
 * ——内核会停下来等一个回答。没有应答者时它们 fail-closed（审批落到
 * `unavailable`，工具直接失败）。所以这两个弹窗不是装饰，是「能不能干活」的开关。
 *
 * 实现用 pi-tui 的 overlay：它渲染在现有内容之上、不占布局、且接管键盘焦点。
 *
 * 一个容易踩的坑：overlay 收到键盘后只会调**顶层组件**的 `handleInput`，
 * 而 `Box`/`Container` 不实现它。所以必须返回一个把 handleInput 转发给内部
 * 列表/编辑器的三方法对象——直接把容器交给 overlay，键盘会石沉大海。
 */

import { Box, Container, Editor, SelectList, Spacer, Text } from '@earendil-works/pi-tui'

/** 默认的按键提示。 */
const CHOOSE_HINT = '↑↓ 选择 · Enter 确认 · Esc 取消'
const TEXT_HINT = 'Enter 提交 · Esc 取消'

/**
 * 造一个把 `handleInput` 转发给内部组件的包装。
 *
 * @param {object} container - 负责布局的容器
 * @param {(data:string)=>void} onInput - 真正处理按键的组件
 * @param {object} tui
 */
function forwarding(container, onInput, tui) {
  return {
    render: (width) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput: (data) => {
      onInput(data)
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
   * 弹一个选择框。
   *
   * @param {object} spec
   * @param {string} spec.title
   * @param {string} [spec.detail] - 标题下方的说明
   * @param {Array<{value:string,label:string,description?:string}>} spec.options
   * @param {string} [spec.hint]
   * @param {number} [spec.maxVisible]
   * @returns {Promise<string|undefined>} 选中值；取消时为 undefined
   */
  function choose({ title, detail, options, hint = CHOOSE_HINT, maxVisible = 8 }) {
    return new Promise((resolve) => {
      let handle
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        try {
          handle?.hide()
        } catch {
          // overlay 可能已经被整体拆掉了（退出路径）；不能因此吞掉回答。
        }
        resolve(value)
      }

      const list = new SelectList(options, Math.min(options.length, maxVisible), theme.selectList)
      list.onSelect = (item) => finish(item.value)
      list.onCancel = () => finish(undefined)

      const container = new Container()
      const box = new Box(1, 0, (s) => theme.bg('selectedBg', s))
      box.addChild(new Text(theme.fg('accent', theme.bold(title)), 0, 0))
      if (typeof detail === 'string' && detail !== '') {
        box.addChild(new Text(theme.fg('muted', detail), 0, 0))
      }
      box.addChild(new Spacer(1))
      box.addChild(list)
      box.addChild(new Spacer(1))
      box.addChild(new Text(theme.fg('dim', hint), 0, 0))
      container.addChild(box)

      const component = forwarding(container, (data) => list.handleInput(data), tui)
      try {
        handle = tui.showOverlay(component, { anchor: 'center', width: '70%', minWidth: 40, maxHeight: '70%' })
        handle.focus?.()
      } catch {
        // 终端不支持 overlay（极窄/极简）时不要卡住内核，直接给出取消。
        finish(undefined)
      }
    })
  }

  /**
   * 弹一个单行文本输入框（提问没有选项时用）。
   *
   * @param {object} spec
   * @param {string} spec.title
   * @param {string} [spec.detail]
   * @param {string} [spec.hint]
   * @returns {Promise<string|undefined>}
   */
  function askText({ title, detail, hint = TEXT_HINT }) {
    return new Promise((resolve) => {
      let handle
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        try {
          handle?.hide()
        } catch {
          // 同上
        }
        resolve(value)
      }

      const editor = new Editor(tui, theme.editor)
      editor.onSubmit = (text) => {
        const trimmed = String(text ?? '').trim()
        // 允许提交空串：有些问题就是要「不填」。取消走 Esc。
        if (trimmed === '' && String(text ?? '') === '') return
        finish(trimmed)
      }

      const container = new Container()
      const box = new Box(1, 0, (s) => theme.bg('selectedBg', s))
      box.addChild(new Text(theme.fg('accent', theme.bold(title)), 0, 0))
      if (typeof detail === 'string' && detail !== '') {
        box.addChild(new Text(theme.fg('muted', detail), 0, 0))
      }
      box.addChild(new Spacer(1))
      box.addChild(editor)
      box.addChild(new Text(theme.fg('dim', hint), 0, 0))
      container.addChild(box)

      // Esc 取消需要自己拦：Editor 不处理 Esc。
      const component = forwarding(
        container,
        (data) => {
          if (data === '\x1b') {
            finish(undefined)
            return
          }
          editor.handleInput?.(data)
        },
        tui,
      )

      try {
        handle = tui.showOverlay(component, { anchor: 'center', width: '70%', minWidth: 40 })
        handle.focus?.()
      } catch {
        finish(undefined)
      }
    })
  }

  return { choose, askText }
}
