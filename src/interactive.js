/**
 * 人机回环：把内核停下来等的两个 waterfall 接到弹窗上。
 *
 *   approval/request       工具要授权  → 允许一次 / 拒绝
 *   user-questions/request 模型要问人  → 选项菜单 或 自由文本
 *
 * 这两个不接，TUI 就只是个聊天框：任何需要授权的工具都会 fail-closed
 * （审批落到 `unavailable`），模型问问题时也会直接失败。
 *
 * 关于「认领谁的请求」：这个瀑布注册在根上下文上，会看到所有 agent 的请求
 * （包括子 agent）。本 TUI 是这个 profile 里**唯一的应答者**，所以一律认领；
 * 把请求 `next()` 下去等于没人管、直接失败。唯一的例外是界面不可用
 * （正在退出）——那时交回链上，让内核按它自己的策略处理。
 */

import { MessageRole } from './registry.js'

/**
 * 把「等用户回答」和一个取消信号绑在一起。
 *
 * 参数是**启动函数**而不是已经建好的 promise：如果传 promise，`start()` 会在
 * 判断取消之前就执行，于是请求明明已经被取消，弹窗还是照弹。这个坑是实测
 * 踩出来的（测试里断言「已取消时不弹窗」直接红）。
 *
 * 取消时不仅要给内核一个 fallback 值，还**必须把已经弹出来的框撤掉**——
 * 否则那个框会变成僵尸模态框：它继续吃按键，而回合已经结束，Esc 被应用级
 * 监听当成「中断回合」消费掉，用户根本关不掉它。
 *
 * @template T
 * @param {() => Promise<T>} start - 真正开始等待用户回答
 * @param {AbortSignal|undefined} signal
 * @param {T} fallback - 被取消时的返回值
 * @param {() => void} [cancelPrompt] - 撤掉已弹出的框
 * @returns {Promise<T>}
 */
function withAbort(start, signal, fallback, cancelPrompt) {
  if (signal === undefined || signal === null) return Promise.resolve(start())
  if (signal.aborted === true) return Promise.resolve(fallback)

  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      try {
        cancelPrompt?.()
      } catch {
        // 撤框失败也要把内核放走，不能让它继续等。
      }
      resolve(fallback)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const finish = (value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error)
    }

    let promise
    try {
      promise = start()
    } catch (error) {
      fail(error)
      return
    }
    promise.then(finish, fail)
  })
}

/**
 * 问一个问题，返回要放进 `answers` 的条目。
 *
 * @returns {Promise<{id:string, selected:string[], custom?:string}|undefined>} undefined 表示用户取消
 */
async function askOne(app, question, signal) {
  const options = Array.isArray(question.options) ? question.options : []
  const detail = typeof question.detail === 'string' && question.detail !== '' ? question.detail : undefined
  const title =
    typeof question.header === 'string' && question.header !== ''
      ? `${question.header} · ${question.question}`
      : String(question.question ?? '')

  const needsDocument = detail && (question.intent?.kind === 'plan-review' || detail.length > 240)
  if (needsDocument && app.document) {
    const reviewed = await app.document({ title: '审阅计划 · Esc 返回决策', text: detail, signal })
    if (reviewed === undefined || signal?.aborted) return undefined
  }

  if (question.multiSelect && options.length) {
    const selected = new Set()
    for (;;) {
      const action = await app.choose({ title, signal,
        detail: `已选 ${selected.size} 项 · 选择条目切换勾选`, options: [
          ...options.map((option, index) => ({ value: String(index), label: `${selected.has(index) ? '✓' : '○'} ${option.label}`, description: option.description })),
          { value: 'submit', label: '提交选择' }, { value: 'custom', label: '补充文字并提交' },
        ] })
      if (action === undefined) return undefined
      if (action === 'submit' && selected.size) return { id: question.id, selected: [...selected].map((index) => options[index].label) }
      if (action === 'custom') {
        const custom = await app.askText({ title: '补充回答', signal })
        if (custom === undefined) return undefined
        return { id: question.id, selected: [...selected].map((index) => options[index].label), custom }
      }
      const index = Number(action)
      if (Number.isInteger(index) && options[index]) { if (selected.has(index)) selected.delete(index); else selected.add(index) }
    }
  }

  if (options.length > 0) {
    let customValue = '__custom__'
    while (options.some((option) => option.label === customValue)) customValue += '_'
    const picked = await app.choose({
      title,
      detail: needsDocument && app.document ? '详情已展示，请选择回答。' : detail,
      signal,
      options: [...options.map((option) => ({
        value: String(option.label),
        label: String(option.label),
        description: option.description,
      })), { value: customValue, label: '自定义回答…' }],
    })
    if (picked === undefined) return undefined
    if (picked === customValue) {
      const custom = await app.askText({ title: '自定义回答', signal })
      return custom === undefined ? undefined : { id: question.id, selected: [], custom }
    }
    // 契约要求 selected 里放**选项 label**，不是 value。
    return { id: question.id, selected: [picked] }
  }

  const text = await app.askText({ title, detail, signal })
  if (text === undefined) return undefined
  return { id: question.id, selected: [], custom: text }
}

/**
 * 安装两个交互 waterfall。
 *
 * @param {object} options
 * @param {object} options.ctx   - 插件上下文
 * @param {object} options.app   - createApp() 的产物（需有 choose / askText）
 * @param {()=>boolean} [options.isAvailable] - 界面此刻能不能提问（正在退出时为 false）
 * @returns {() => void} 卸载
 */
export function installInteractive({ ctx, app, isAvailable = () => true, ownsAgent = () => true, approvalDetail }) {
  const disposers = []

  // ── 工具授权 ────────────────────────────────────────────────────────────

  disposers.push(
    ctx.on('approval/request', async (request, next) => {
      if (!isAvailable() || !ownsAgent(request?.agent)) return next()

      const toolName = String(request?.toolName ?? 'tool')
      // displayReason 是本地化展示用；优先中文，其次英文，最后用 asker 给的 reason。
      const reason =
        request?.displayReason?.zh ?? request?.displayReason?.en ?? request?.reason ?? undefined

      const notice = `需要授权：${toolName}`
      const fullDetail = approvalDetail?.(request)

      let choice
      try {
        choice = await withAbort(
          async () => {
            for (;;) {
              const picked = await app.choose({
              title: `允许执行 ${toolName} ？`,
              detail: typeof reason === 'string' ? reason : undefined,
              signal: request?.signal,
              options: [
                { value: 'allowed-once', label: '允许一次', description: '只批准这一次调用' },
                { value: 'rejected', label: '拒绝', description: '本次调用失败，模型会看到拒绝' },
                ...(fullDetail && app.document ? [{ value: 'detail', label: '查看完整调用', description: '执行参数与授权原因' }] : []),
              ],
              })
              if (picked !== 'detail') return picked
              await app.document({ title: '授权 · 完整调用', text: fullDetail, signal: request?.signal })
              if (request?.signal?.aborted) return 'cancelled'
            }
          },
          request?.signal,
          'cancelled',
          // 撤掉已经弹出来的框，否则它会变成吃按键的僵尸模态框。
          () => { if (!app.supportsPromptSignals) app.cancelPrompts?.() },
        )
      } catch {
        // 弹不出来就交回链上，按内核自己的策略（通常是 unavailable）处理。
        return next()
      }

      if (choice === 'allowed-once' || choice === 'rejected') {
        app.notice?.(`${notice} → ${choice === 'allowed-once' ? '已允许' : '已拒绝'}`)
        return choice
      }
      app.notice?.(`${notice} → 已取消`)
      return 'cancelled'
    }),
  )

  // ── 模型提问 ────────────────────────────────────────────────────────────

  disposers.push(
    ctx.on('user-questions/request', async (request, next) => {
      if (!isAvailable() || !ownsAgent(request?.agent)) return next()

      const questions = Array.isArray(request?.questions) ? request.questions : []
      if (questions.length === 0) return next()

      const answers = []
      for (const question of questions) {
        let answer
        try {
          answer = await withAbort(
            () => askOne(app, question, request?.signal),
            request?.signal,
            undefined,
            () => { if (!app.supportsPromptSignals) app.cancelPrompts?.() },
          )
        } catch {
          return next()
        }
        if (answer === undefined) {
          app.notice?.('提问已取消')
          return next()
        }
        answers.push(answer)
      }

      return { answers }
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 逐个清理，单个失败不影响其余。
      }
    }
    disposers.length = 0
  }
}

export { MessageRole }
