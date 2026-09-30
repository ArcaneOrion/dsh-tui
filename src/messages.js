/**
 * 默认消息渲染器。
 *
 * 这些**不是**写死的组件，而是注册进 registry 的**默认实现**。任何一方都能
 * 用 `registry.setMessageRenderer(role, fn)` 把它们整体换掉——包括用一层
 * 外框把全部角色包起来（这正是「给所有消息加线框」的正确做法，不需要 patch
 * 任何原型）。
 *
 * 工厂签名统一为：`({ row, theme, registry }) => Component`
 * 其中 Component 只需要满足 pi-tui 的 `{ render(width), invalidate() }`。
 */

import { Box, Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui'

/** 工具参数里最值得显示的一行（尽量短）。 */
function summarizeArgs(rawArgs) {
  if (typeof rawArgs !== 'string' || rawArgs.trim() === '') return ''
  try {
    const parsed = JSON.parse(rawArgs)
    if (parsed !== null && typeof parsed === 'object') {
      for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'prompt', 'task']) {
        if (typeof parsed[key] === 'string') return clamp(parsed[key], 100)
      }
      const first = Object.values(parsed).find((v) => typeof v === 'string')
      if (typeof first === 'string') return clamp(first, 100)
    }
  } catch {
    // 参数不是合法 JSON（模型还在流式生成）时，直接显示原文。
  }
  return clamp(rawArgs, 100)
}

function clamp(text, max) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

/** 工具结果只显示前若干行，避免一次读文件刷满整屏。 */
function truncateResult(text, maxLines = 12) {
  const lines = String(text).split('\n')
  if (lines.length <= maxLines) return { text: lines.join('\n'), hidden: 0 }
  return { text: lines.slice(0, maxLines).join('\n'), hidden: lines.length - maxLines }
}

// ── 各角色默认渲染器 ─────────────────────────────────────────────────────

/** 用户消息：整块带背景，便于和模型输出区分。 */
export function userRenderer({ row, theme }) {
  const box = new Box(1, 0, (s) => theme.bg('toolPendingBg', s))
  box.addChild(new Text(theme.fg('userText', row.text), 0, 0))
  return box
}

/** 助手正文：Markdown 渲染（标题/列表/代码块/表格）。 */
export function assistantRenderer({ row, theme }) {
  const container = new Container()
  if (typeof row.reasoning === 'string' && row.reasoning.trim() !== '') {
    // 推理内容折叠成一行提示；展开是后续版本的事。
    const lines = row.reasoning.split('\n').length
    container.addChild(new Text(theme.fg('reasoningText', `✻ 思考（${lines} 行，已折叠）`), 1, 0))
  }
  container.addChild(new Markdown(row.text, 1, 0, theme.markdown))
  if (row.interrupted === true) {
    container.addChild(new Text(theme.fg('warning', '（本回合被中断，以上为已生成部分）'), 1, 0))
  }
  return container
}

/** 推理片段（独立角色时使用）。 */
export function reasoningRenderer({ row, theme }) {
  return new Text(theme.fg('reasoningText', row.text), 1, 0)
}

/** 工具调用卡片。 */
export function toolRenderer({ row, theme }) {
  const container = new Container()
  const name = row.toolName ?? 'tool'
  const status = row.done !== true ? theme.fg('dim', '运行中…') : row.isError === true ? theme.fg('error', '失败') : theme.fg('success', '完成')
  const title = theme.fg('toolTitle', `▸ ${name}`) + '  ' + status
  container.addChild(new Text(title, 1, 0))

  const summary = summarizeArgs(row.args)
  if (summary !== '') container.addChild(new Text(theme.fg('dim', '  ' + summary), 1, 0))

  if (typeof row.text === 'string' && row.text.trim() !== '') {
    const { text, hidden } = truncateResult(row.text)
    container.addChild(new Text(theme.fg('toolOutput', indent(text, '  ')), 1, 0))
    if (hidden > 0) container.addChild(new Text(theme.fg('dim', `  … 另有 ${hidden} 行`), 1, 0))
  }

  if (typeof row.errorReason === 'string' && row.errorReason !== '') {
    container.addChild(new Text(theme.fg('error', '  ' + row.errorReason), 1, 0))
  }
  return container
}

/** 系统提示行（例如切换模型、会话恢复）。 */
export function noticeRenderer({ row, theme }) {
  return new Text(theme.fg('dim', '· ' + row.text), 1, 0)
}

function indent(text, prefix) {
  return String(text)
    .split('\n')
    .map((line) => prefix + line)
    .join('\n')
}

/**
 * 把默认渲染器安装到注册表。
 * @param {object} registry - createRegistry() 的产物
 * @returns {() => void} 一次性卸载全部默认渲染器
 */
export function installDefaultRenderers(registry) {
  const disposers = [
    registry.setMessageRenderer('user', userRenderer),
    registry.setMessageRenderer('assistant', assistantRenderer),
    registry.setMessageRenderer('reasoning', reasoningRenderer),
    registry.setMessageRenderer('tool', toolRenderer),
    registry.setMessageRenderer('notice', noticeRenderer),
    // 兜底：未知角色按提示行渲染，永不崩。
    registry.setMessageRenderer('*', noticeRenderer),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

export { Spacer }
