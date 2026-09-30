/**
 * 投影层：dsh 事件 → 视图模型（行）。
 *
 * 三条铁律，违反任何一条都会在 resume / rewind 时露馅：
 *
 * 1. **回放和实时走同一条路。** 所有行都由事件派生，组件只读行。不存在
 *    「实时路径直接改 UI、回放路径重放事件」这种双轨。
 * 2. **过程态与提交态分开。** `agent/assistant-stream` 的帧只用于渲染
 *    正在生成的文本；一旦 `assistant/message` 提交，就丢弃流式缓冲、以
 *    提交态为准。流式事件永远不是真相。
 * 3. **未知事件类型不报错。** 插件可以追加事件类型，投影层必须容忍并忽略，
 *    否则一个第三方事件就能让整个界面停止更新。
 *
 * 这一层是纯函数：`apply(view, event) → changed:boolean`，`view` 原地更新。
 * 之所以可变而非不可变，是因为行数量会到几千，每帧重建整棵数组不划算；
 * 组件侧用 `view.revision` 做缓存键即可。
 */

import { MessageRole } from './registry.js'

/** 生成单调递增的行 key。 */
let rowSeq = 0
function nextKey(prefix) {
  rowSeq += 1
  return `${prefix}-${rowSeq}`
}

/**
 * 从消息的 content 块数组里抽出可见文本。
 * dsh 的 content 是判别联合（text / reasoning / tool-call / image …），
 * 这里只认文本块，其余忽略——投影失败不应该让界面报错。
 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** 从内容块里抽出推理（reasoning）文本。 */
export function reasoningOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** 把一次失败格式化成一行可读文本。 */
export function formatFailure(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : undefined
  const status = Number.isFinite(error.status) ? String(error.status) : undefined
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : JSON.stringify(error)
  const tag = [code, status].filter(Boolean).join(' ')
  return tag === '' ? message : `${tag}: ${message}`
}

/** 新建一个空的视图模型。 */
export function createView() {
  return {
    /** 已提交的行，按时间顺序。 */
    rows: [],
    /** 每次变更自增，供组件做缓存键。 */
    revision: 0,
    /** 正在流式生成的内容；提交后清空。 */
    streaming: null, // { key, text, reasoning } | null
    /** 当前是否有回合在跑。 */
    turnActive: false,
    /** 最近一次 turn/end 的原因，供状态栏展示。 */
    lastTurnReason: undefined,
    /** callId → 已插入的工具行，用于把 tool/result 配回 tool/call。 */
    tools: new Map(),
    contextRevision: 0,
    step: undefined,
    turn: undefined,
    turnStartedAt: undefined,
  }
}

function touch(view) {
  view.revision += 1
}

function pushRow(view, row) {
  // `rev` 是行级版本号：行内容原地更新时自增，供渲染层做行级缓存。
  // 没有它，流式期间每个 token 都要把全部历史行重建一遍。
  const stored = { rev: 0, ...row }
  view.rows.push(stored)
  touch(view)
  return stored
}

/**
 * 应用一条**已提交**的会话事件。
 *
 * @param {object} view - createView() 的产物
 * @param {{seq?:number,type:string,data:any}} event - dsh session 事件
 * @param {{call?:Function,result?:Function}} [present] - 工具展示意图解析器。
 *   由内核桥注入（它才有 ctx.tools）；投影层本身不认识任何工具名。
 * @returns {boolean} 是否改变了视图
 */
export function applySessionEvent(view, event, present = undefined) {
  if (event === null || typeof event !== 'object') return false
  const data = event.data

  // A replacement changes model input, not the human transcript. Its exact
  // resulting content is available through the native /context inspector.
  if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
    view.contextRevision += 1
    touch(view)
    return true
  }

  switch (event.type) {
    case 'turn/start': {
      view.turnActive = true
      view.turn = data?.turn
      view.turnStartedAt = event.time
      view.lastTurnReason = undefined
      touch(view)
      return true
    }

    case 'turn/end': {
      view.turnActive = false
      view.lastTurnReason = data?.reason
      // 回合结束而流式缓冲没被提交事件收走（例如被中断），也要落下，
      // 否则那段文字会永远停在「正在输入」状态。
      flushStreaming(view)

      // **回合以错误结束必须看得见。**
      //
      // 这是实机踩出来的：请求发出去了、API 返回 401，而投影层只认
      // `assistant/message`，把 `turn/end` 的 error 原因丢进一个没人渲染的字段。
      // 用户看到的就是「回车没反应」——一个转完就停的 spinner，没有任何提示。
      // 静默失败比报错难查一百倍。
      if (data?.reason?.kind === 'error') {
        pushRow(view, {
          key: nextKey('error'),
          role: MessageRole.ERROR,
          text: formatFailure(data.reason.error),
          done: true,
          seq: event.seq,
        })
      }
      touch(view)
      return true
    }

    case 'user/message': {
      // 注意：user/message 的 data **就是** UserMessage 本身（不像
      // assistant/message 那样包在 .message 里）。这里两种形状都兼容。
      const msg = data?.message ?? data
      const text = textOfContent(msg?.content)
      const images = Array.isArray(msg?.content) ? msg.content.filter((block) => block?.type === 'image').length : 0
      if (text === '' && !images) return false
      const source = msg?.source
      const context = typeof source?.form === 'string'
      pushRow(view, {
        key: nextKey('user'),
        role: context ? 'context' : MessageRole.USER,
        text: text + (images ? `\n[图片 × ${images}]` : ''),
        source,
        title: source?.summary ?? source?.name ?? source?.kind,
        done: true,
        seq: event.seq,
        turn: data?.turn,
        step: data?.step,
      })
      return true
    }

    case 'assistant/message': {
      const msg = data?.message
      const text = textOfContent(msg?.content)
      const reasoning = reasoningOfContent(msg?.content)
      // 提交态优先：先丢掉流式缓冲，再落最终文本。
      view.streaming = null
      if (text === '' && reasoning === '') {
        touch(view)
        return true
      }
      pushRow(view, {
        key: nextKey('assistant'),
        role: MessageRole.ASSISTANT,
        text,
        reasoning,
        done: true,
        interrupted: data?.interrupted === true,
        usage: data?.usage,
        seq: event.seq,
        turn: data?.turn,
        step: data?.step,
      })
      return true
    }

    case 'assistant/attempt': {
      // 一次没有提交任何表面消息的尝试（失败/重试/取消）。它不产生行，
      // 但要清掉流式缓冲，否则失败尝试的残字会留在屏幕上。
      view.streaming = null
      touch(view)
      return true
    }

    case 'tool/call': {
      // 问工具本人「你想怎么被展示」，而不是在这里按工具名分支。
      let callView
      try {
        callView = present?.call?.(data?.name, data?.arguments)
      } catch {
        // 展示意图解析失败不影响这次调用被记录。
      }
      const row = pushRow(view, {
        key: nextKey('tool'),
        role: MessageRole.TOOL,
        toolName: data?.name,
        callId: data?.callId,
        args: data?.arguments,
        callView,
        text: '',
        done: false,
        seq: event.seq,
        startedAt: event.time,
      })
      if (typeof data?.callId === 'string') view.tools.set(data.callId, row)
      return true
    }

    case 'tool/result': {
      const callId = data?.message?.toolCallId
      const row = typeof callId === 'string' ? view.tools.get(callId) : undefined
      const text = textOfContent(data?.message?.content)
      const isError = data?.message?.isError === true

      /** 解析结果态展示意图；失败就退回原文。 */
      const resolveResultView = (toolName, rawArgs) => {
        try {
          return present?.result?.(toolName, rawArgs, data)
        } catch {
          return undefined
        }
      }

      if (row !== undefined) {
        row.text = text
        row.done = true
        row.isError = isError
        row.errorReason = data?.error?.reason
        row.finishedAt = event.time
        row.resultView = resolveResultView(row.toolName, row.args)
        row.rev = (row.rev ?? 0) + 1
        touch(view)
        return true
      }
      // 没有配到对应的 call（例如 resume 时只读到了 result），补一行。
      const orphanToolName = data?.message?.name ?? 'tool'
      pushRow(view, {
        key: nextKey('tool-result'),
        role: MessageRole.TOOL,
        toolName: orphanToolName,
        callId,
        text,
        done: true,
        isError,
        resultView: resolveResultView(orphanToolName, undefined),
        seq: event.seq,
      })
      return true
    }

    case 'step/start':
      view.step = data?.step
      touch(view)
      return true
    case 'agent/inbox/spliced':
      touch(view)
      return true
    case 'compaction/start':
      view.compacting = true
      touch(view)
      return true
    case 'compaction/end':
      view.compacting = false
      pushRow(view, { key: nextKey('compact'), role: MessageRole.NOTICE, text: '上下文整理结束 · /context 查看当前内容', done: true })
      return true
    case 'system/message':
      view.contextRevision += 1
      return false
    case 'developer/message':
    case 'request/header':
    case 'request/context':
    case 'session/end-seed':
    case 'step/end':
      // 有意不投影：这些是请求构造或生命周期标记，不是对话内容。
      return false

    default:
      // 未知类型（第三方插件追加的）静默忽略。见铁律 3。
      return false
  }
}

/**
 * 应用一帧**过程态**流式事件（`agent/assistant-stream` 的 payload.frame）。
 * @param {object} view
 * @param {object} frame - { type:'start'|'chunk'|'end', attemptId, revision, index?, chunk? }
 * @returns {boolean} 是否改变了视图
 */
export function applyStreamFrame(view, frame) {
  if (frame === null || typeof frame !== 'object') return false

  switch (frame.type) {
    case 'start':
      view.streaming = { key: nextKey('stream'), text: '', reasoning: '' }
      touch(view)
      return true

    case 'chunk': {
      // 没有 start 就收到 chunk（重连、订阅晚于尝试开始）时补一个缓冲，
      // 否则这段文字会丢。
      if (view.streaming === null) {
        view.streaming = { key: nextKey('stream'), text: '', reasoning: '' }
      }
      const chunk = frame.chunk
      if (chunk === null || typeof chunk !== 'object') return false
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        view.streaming.text += chunk.text
        touch(view)
        return true
      }
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        view.streaming.reasoning += chunk.text
        touch(view)
        return true
      }
      // tool-call-delta 等其余增量：UI 不逐字画工具参数，忽略。
      return false
    }

    case 'end':
      // 提交事件（assistant/message）会在 end 帧之前到达并清空缓冲。
      // 如果到这里缓冲还在，说明这次尝试没有提交表面消息——丢掉它。
      if (view.streaming !== null) {
        view.streaming = null
        touch(view)
        return true
      }
      return false

    default:
      return false
  }
}

/** 把仍在流式的缓冲落成一行已完成的 assistant 行。 */
function flushStreaming(view) {
  const s = view.streaming
  if (s === null) return
  view.streaming = null
  if (s.text.trim() === '' && s.reasoning.trim() === '') return
  view.rows.push({
    key: s.key,
    role: MessageRole.ASSISTANT,
    text: s.text,
    reasoning: s.reasoning,
    done: true,
    interrupted: true,
  })
}

/**
 * 从一串历史事件重建视图（resume / 冷读）。
 * 与实时路径共用 applySessionEvent，所以两条路必然一致。
 * @param {object} [view]
 * @param {Iterable<object>} events
 */
export function replay(view = createView(), events, present = undefined) {
  for (const event of events) applySessionEvent(view, event, present)
  view.streaming = null
  // 回放的是**历史**：日志末尾即使停在 turn/start（上次进程崩过），也不代表
  // 现在有回合在跑。实时性由 agent 状态决定，不由历史决定——否则 resume 之后
  // turnActive 永远为 true，spinner 常转，Ctrl+C 也永远只会去「中断」而退不出。
  view.turnActive = false
  view.compacting = false
  return view
}
