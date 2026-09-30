/** Fixed, invented records for design comparison; no model requests or filesystem tools. */
export const fixtureEvents = [
  { seq: 0, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '检查 @src/session.ts 的恢复逻辑，修复重复消息，并验证结果。' }] } },
  { seq: 1, type: 'tool/call', data: { callId: 'read-1', name: 'read', arguments: '{"path":"src/session.ts"}' } },
  { seq: 2, type: 'tool/result', data: { message: { toolCallId: 'read-1', content: [{ type: 'text', text: 'export function restore(events) {\n  const messages = events.filter(isMessage);\n  return messages.map(project);\n}' }] } } },
  { seq: 3, type: 'tool/call', data: { callId: 'edit-1', name: 'edit', arguments: '{"path":"src/session.ts","change":"filter replacement events"}' } },
  { seq: 4, type: 'tool/result', data: { message: { toolCallId: 'edit-1', content: [{ type: 'text', text: '已更新 src/session.ts' }] } } },
  { seq: 5, type: 'assistant/message', surfaceOp: 'append', data: { message: { role: 'assistant', content: [
    { type: 'reasoning', text: '会话记录与模型上下文具有不同的身份语义。\n替换事件应该更新模型输入，但不能成为新的对话。\n恢复路径和实时路径需要遵守同一规则。' },
    { type: 'text', text: '恢复逻辑已更新。替换事件会更新模型上下文，历史对话保持连续。\n\n- 保留用户已读过的消息\n- 排除重复的替换副本\n- 接下来验证恢复与实时路径的一致性' },
  ] } } },
]

export const fixturePresent = {
  call(name) { return name === 'edit' ? { card: 'generic', kind: 'edit', title: 'src/session.ts' } : { card: 'generic', kind: 'read', title: 'src/session.ts' } },
  result(name) { return name === 'edit' ? { card: 'diff', diffs: [{ path: 'src/session.ts', oldText: 'const messages = events.filter(isMessage);', newText: 'const messages = events.filter(isAppendMessage);' }] } : undefined },
}

export const fixtureSnapshot = { model: 'deepseek-flash', thinking: 'high', dir: 'workspace', branch: 'fix/session', tokens: { used: 18420, limit: 128000 }, sandbox: 'workspace-write' }

export function fixtureRuntime() {
  const queued = []
  return {
    snapshot: () => ({ status: 'idle', queued: queued.filter((row) => row.target === 'next-turn').length, steering: queued.filter((row) => row.target === 'next-step').length }),
    context: () => [
      { id: 'system', role: 'system', source: { kind: 'system-prompt' }, text: '你是一个编程助手。\n先阅读，再修改；用测试验证行为。\n\n这是演示用上下文，不是本机真实会话。' },
      { id: 'instructions', role: 'user', source: { kind: 'agent-instructions', form: 'instructions' }, text: '# AGENTS.md\n\n使用中文回复。保持修改范围清晰。\n\n上下文来源与聊天记录分开呈现。' },
      { id: 'prompt', role: 'user', source: { kind: 'user' }, text: fixtureEvents[0].data.content[0].text },
    ],
    tools: () => ({ ready: true, source: '演示目录', tools: [{ name: 'read', description: '读取工作区文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }, { name: 'edit', description: '精确编辑文件', parameters: { type: 'object' } }] }),
    queue: () => [...queued],
    removeQueued(id) { const index = queued.findIndex((row) => row.id === id); if (index < 0) return false; queued.splice(index, 1); return true },
    children: async () => [{ id: 'demo-review', label: '审查恢复路径', mode: 'continuable', status: 'running' }, { id: 'demo-tests', label: '验证回放一致性', mode: 'one-shot', status: 'inactive' }],
    submit(text, { delivery = 'followup' } = {}) { queued.push({ id: 'demo-' + queued.length, target: delivery === 'followup' ? 'next-turn' : 'next-step', text }) },
  }
}

export function memoryTerminal(columns = 100, rows = 32) {
  return { columns, rows, output: '', start(onInput, onResize) { this.onInput = onInput; this.onResize = onResize },
    stop() {}, write(data) { this.output += data }, hideCursor() {}, showCursor() {}, clearLine() {},
    moveBy() {}, clearScreen() {}, setTitle() {}, setProgress() {}, clearProgress() {},
  }
}
