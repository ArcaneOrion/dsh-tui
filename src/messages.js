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

/** 系统提示行（例如切换模型、会话恢复）。 */
export function noticeRenderer({ row, theme }) {
  return new Text(theme.fg('dim', '· ' + row.text), 1, 0)
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
    registry.setMessageRenderer('info', infoRenderer),
    // 兜底：未知角色按提示行渲染，永不崩。
    registry.setMessageRenderer('*', noticeRenderer),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
