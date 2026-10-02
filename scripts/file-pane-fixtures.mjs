/** 固定演示数据：从真实组件生成预览，不读写用户文件，不调用模型。 */
import { fixtureEvents, fixturePresent } from './fixtures.mjs'
import { applySessionEvent } from '../src/projection.js'

export function populateFilePaneDemo(view) {
  applySessionEvent(view, fixtureEvents[0], fixturePresent)
  applySessionEvent(view, { seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text',
    text: '重复消息来自恢复与实时路径对替换事件的处理差异。\n\n我会统一事件投影，补上去重，并用恢复场景验证。' }] } } })
  const files = [
    { path: 'src/session.ts', oldText: 'export function restore(events) {\n  const messages = events.filter(isMessage);\n  return messages.map(project);\n}',
      newText: 'export function restore(events) {\n  const seen = new Set();\n  return events\n    .filter(isAppendMessage)\n    .filter(event => {\n      if (seen.has(event.id)) return false;\n      seen.add(event.id);\n      return true;\n    })\n    .map(project);\n}' },
    { path: 'src/projection.ts', oldText: 'case "replacement":\n  return appendMessage(event);',
      newText: 'case "replacement":\n  updateContext(event);\n  return conversation;' },
    { path: 'test/session.test.ts', oldText: null,
      newText: Array.from({ length: 8 }, (_, i) => `test('恢复场景 ${i + 1} 不重复添加消息', () => {\n  const messages = restore(fixture${i + 1});\n  assert.equal(messages.length, 2);\n});`).join('\n\n') },
  ]
  for (const [index, diff] of files.entries()) {
    const callId = 'demo-file-' + index
    const present = { call: () => ({ card: 'diff', diffs: [diff] }), result: () => ({ card: 'diff', diffs: [diff] }) }
    applySessionEvent(view, { seq: 10 + index * 2, type: 'tool/call', data: { callId, name: 'edit' } }, present)
    applySessionEvent(view, { seq: 11 + index * 2, type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text: '已更新' }] } } }, present)
  }
  applySessionEvent(view, { seq: 20, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text',
    text: '三个文件已更新。\n\n恢复时按事件 ID 去重；上下文替换不再追加为聊天消息。右侧可以逐个检查修改，测试文件中保留了 8 个恢复场景。\n\n你可以继续描述需求，或按 F6 浏览改动。' }] } } })
}
