/**
 * 读取会话的持久事件。
 *
 * **活会话上 `session.events` 是空的。** 要按序号用 `session.eventAt(seq)` 逐条读，
 * 序号范围是 `0 .. session.seq - 1`。这一点是实测踩出来的：底栏取不到真实路由，
 * 打日志才发现 `seq=19` 而 `events.length=0`。
 *
 * 依据来自 dsh 自己的 headless 实现（`dsh-headless/lib/index.js`）：
 *
 * ```js
 * / ** Iterate a live Session's durable events in order. * /
 * function* liveEvents(session) {
 *   const length = session.seq
 *   for (let seq = 0; seq < length; seq++) yield session.eventAt(SessionSeq(seq))
 * }
 * ```
 *
 * `events` 只在恢复路径上有内容，所以两种形态都要兼容——不能只认一种。
 */

/**
 * 一次读出全部事件（用于 replay 这种一次性场景）。
 *
 * @param {object} session
 * @returns {readonly object[]}
 */
export function readSessionEvents(session) {
  if (session === undefined || session === null) return []

  // 活会话：按序号读。
  if (typeof session.eventAt === 'function') {
    const total = Number.isFinite(session.seq) ? session.seq : 0
    const out = []
    for (let seq = 0; seq < total; seq += 1) {
      try {
        const event = session.eventAt(seq)
        if (event !== undefined && event !== null) out.push(event)
      } catch {
        // 个别序号读不到不该让整次 replay 失败——已有的部分仍然有用。
      }
    }
    return out
  }

  // 恢复路径：events 本身有内容。
  return Array.isArray(session.events) ? session.events : []
}

/**
 * 增量读取器：只读**新追加**的事件。
 *
 * 适合「每帧都可能被调用」的场景（如底栏取最近一次请求的路由）——
 * 直接每次全量扫会变成 O(n²)。
 *
 * @param {object} session
 * @returns {() => readonly object[]} 返回自上次调用以来新增的事件
 */
export function createEventTail(session) {
  let cursor = 0

  return function readNew() {
    if (session === undefined || session === null) return []
    const total = Number.isFinite(session.seq) ? session.seq : 0
    if (total <= cursor) return []

    const out = []
    if (typeof session.eventAt === 'function') {
      for (let seq = cursor; seq < total; seq += 1) {
        try {
          const event = session.eventAt(seq)
          if (event !== undefined && event !== null) out.push(event)
        } catch {
          // 读不到就跳过这一条。
        }
      }
    } else if (Array.isArray(session.events)) {
      out.push(...session.events.slice(cursor))
    }

    cursor = total
    return out
  }
}
