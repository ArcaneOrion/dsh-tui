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

import { Box, Container, Markdown, Text } from '@earendil-works/pi-tui'
import { infoRenderer } from './startup-info.js'
import { ToolCard } from './tool-cards.js'
import { rail, fit } from './layout.js'

// ── 各角色默认渲染器 ─────────────────────────────────────────────────────

/**
 * 用户消息。
 *
 * 对齐 pi 的 `UserMessageComponent`：**上下各留一行**的有底色块，内容走 Markdown
 * 而不是纯文本（所以用户贴的代码块/列表也会被正确渲染），底色与文字各用一个
 * 专门的 token。
 */
export function userRenderer({ row, theme }) {
  const box = new Box(1, 0, (text) => theme.bg('userMessageBg', text))
  box.addChild(new Text(theme.bold(theme.fg('userMessageText', '❯ 你')), 0, 0))
  box.addChild(new Markdown(row.text, 2, 0, theme.markdown, { color: (text) => theme.fg('userMessageText', text) }))
  return box
}

/**
 * 助手正文。
 *
 * 对齐 pi 的 `AssistantMessageComponent`：正文**不铺底色**（方便复制），
 * 只有思考块用 `thinkingText` + 斜体。
 */
export function assistantRenderer({ row, theme, registry }) {
  const container = new Container()
  const hasText = typeof row.text === 'string' && row.text.trim() !== ''
  const hasThinking = typeof row.reasoning === 'string' && row.reasoning.trim() !== ''

  if (hasThinking) {
    // pi 的隐藏思考块是一行斜体标签；这里保持一致，但把行数也带上，
    // 让人知道折叠了多少（pi 没带，这是本地的一点增益）。
    const lines = row.reasoning.trim().split('\n').length
    const expanded = registry?.display?.thinking === true
    const label = expanded ? `思考 · ${lines} 行` : `思考 · ${lines} 行已折叠  /thinking 展开`
    container.addChild(new Text(theme.fg('thinkingText', label), 1, 0))
    if (expanded) container.addChild(new Markdown(row.reasoning, 1, 0, theme.markdown))
  }

  if (hasText) {
    // 正文前留一行——与 pi 的 Spacer(1) 一致。
    container.addChild(new Markdown(row.text, 1, 0, theme.markdown))
  }

  if (row.interrupted === true) {
    container.addChild(new Text(theme.fg('warning', '（本回合被中断，以上为已生成部分）'), 1, 0))
  }
  return {
    invalidate: () => container.invalidate(),
    render(width) {
      return [fit(theme.fg('accent', theme.bold('● DeepSeek')) + theme.fg('dim', row.done === false ? '  正在回应' : ''), width), ...container.render(width)]
    },
  }
}

/** 推理片段（独立角色时使用）。 */
export function reasoningRenderer({ row, theme }) {
  return new Text(theme.italic(theme.fg('thinkingText', row.text)), 1, 0)
}

/**
 * 工具调用卡片。
 *
 * 真正的渲染在 `tool-cards.js`——它按工具**自己声明的**展示意图
 * （`presentCall` / `presentResult`）选卡片，而不是按工具名分支。
 * 所以这里只是一个注册点。
 */
export function toolRenderer({ row, theme }) {
  return new ToolCard({ row, theme })
}

/** 告警行：琥珀色，跟普通提示区分开。 */
export function warnRenderer({ row, theme }) {
  return new Text(theme.fg('warning', '⚠ ' + row.text), 1, 0)
}

/**
 * 错误行：红色，必须醒目。
 *
 * 存在的理由：请求失败（401、超时、模型不存在…）原本被投影层整个丢掉，
 * 用户看到的是「回车没反应」。失败必须说出来。
 */
export function errorRenderer({ row, theme }) {
  return new Text(theme.fg('error', '✗ ' + row.text), 1, 0)
}

/** 系统提示行（例如切换模型、会话恢复）。 */
export function noticeRenderer({ row, theme }) {
  return new Text(theme.fg('dim', '· ' + row.text), 1, 0)
}

export function contextRenderer({ row, theme }) {
  const label = row.title || row.source?.form || '上下文'
  return new Text(theme.fg('dim', ` ◇ ${label} · 已加入上下文  /context 查看`), 0, 0)
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
    registry.setMessageRenderer('warn', warnRenderer),
    registry.setMessageRenderer('error', errorRenderer),
    registry.setMessageRenderer('info', infoRenderer),
    registry.setMessageRenderer('context', contextRenderer),
    // 兜底：未知角色按提示行渲染，永不崩。
    registry.setMessageRenderer('*', noticeRenderer),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
