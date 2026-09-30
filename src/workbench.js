/** User actions over runtime capabilities. No DSH imports or synthetic model state. */
const ACTIONS = [
  ['context', '上下文', '查看模型能看到的内容与来源'],
  ['inspect', '工具记录', '检查参数、结果和完整输出'],
  ['agents', 'Agent 协作', '当前会话的子 Agent 目录'],
  ['queue', '待处理输入', '查看或撤回排队消息'],
  ['inject', '补充上下文', '等待下一步，不主动唤醒 Agent'],
  ['steer', '介入当前工作', '在最近的下一步送达'],
  ['tools', '可用工具', '最近请求实际携带的工具目录'],
  ['model', '模型', '渠道、模型与推理强度'],
  ['preset', '会话预设', '能力组合'],
  ['thinking', '思考详情', '展开 / 折叠'],
  ['help', '全部命令', '包括运行时注册的命令'],
]

const labels = { system: '系统指令', developer: '能力变更', user: '输入', assistant: '回复', tool: '工具结果' }
const forms = { instructions: '工作区指令', catalog: '能力目录', snapshot: '运行时状态', notice: '上下文通知', relay: 'Agent 消息', recall: '历史材料' }
const entryLabel = (entry) => forms[entry.source?.form] ?? labels[entry.role] ?? entry.role
const pretty = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''

export function toolDocument(row) {
  return [`${row.toolName} · ${row.done ? row.isError ? '失败' : '完成' : '运行中'}`,
    '', '调用参数', pretty(row.args), '', '工具结果', row.text || (row.done ? '无文本输出' : '等待结果…'),
    row.errorReason ? `\n错误说明\n${row.errorReason}` : '',
    row.resultView ? `\n结构化展示数据\n${pretty(row.resultView)}` : ''].filter((line) => line !== undefined).join('\n')
}

export function createWorkbench({ app, kernel, view, registry, runCommand }) {
  let busy = false
  const runtime = kernel.runtime

  async function context() {
    const entries = runtime.context()
    if (!entries.length) {
      await app.document({ title: '上下文', text: '尚未产生模型请求。\n\n发送第一条消息后，这里会显示内核实际组装的上下文。\n使用 /inject 可以提前排入补充材料；使用 @路径引用文件。' })
      return
    }
    const chosen = await app.choose({ title: '上下文', detail: `当前包含 ${entries.length} 条消息 · 选择来源查看全文`, options: [
      { value: '*', label: '全部上下文', description: '按模型可见顺序查看当前快照' },
      ...entries.map((entry, index) => ({ value: String(index),
        label: `${String(index + 1).padStart(2, '0')}  ${entryLabel(entry)} · ${entry.source?.name ?? entry.source?.kind ?? entry.role}`,
        description: entry.source?.summary ?? entry.text.replace(/\s+/g, ' ').slice(0, 80) })),
    ] })
    if (chosen === undefined) return
    const selected = chosen === '*' ? entries : [entries[Number(chosen)]]
    await app.document({ title: '上下文 · 当前快照', text: selected.filter(Boolean).map((entry) =>
      `${entryLabel(entry)} · ${entry.source?.kind ?? entry.role}\n\n${entry.text}`).join('\n\n────────────────\n\n') })
  }

  async function inspect() {
    const rows = view.rows.filter((row) => row.role === 'tool').reverse()
    if (!rows.length) return app.document({ title: '工具记录', text: '本会话还没有工具调用。\n\n工具运行时会出现在对话中；在这里可以查看完整参数和结果。' })
    const id = await app.choose({ title: '工具记录', detail: `${rows.length} 次调用 · 最近的排在前面`, options: rows.map((row) => ({
      value: row.key, label: `${row.isError ? '✗' : row.done ? '✓' : '○'} ${row.callView?.title ?? row.toolName}`,
      description: row.text.replace(/\s+/g, ' ').slice(0, 70) || '等待结果…',
    })) })
    const row = rows.find((item) => item.key === id)
    if (row) await app.document({ title: `工具 · ${row.toolName}`, text: () => toolDocument(row) })
  }

  async function tools() {
    const catalog = runtime.tools()
    if (!catalog.ready) return app.document({ title: '可用工具', text: '尚未产生模型请求。\n\n第一次请求后，此处显示内核实际携带的工具目录；会话预设可通过 /preset 查看。' })
    if (!catalog.tools.length) return app.document({ title: '可用工具', text: '最近一次请求未携带工具。' })
    const id = await app.choose({ title: '可用工具', detail: `${catalog.source ?? '最近请求'} · ${catalog.tools.length} 个工具`, options: catalog.tools.map((tool, index) => ({
      value: String(index), label: tool.name, description: tool.description?.split('\n')[0],
    })) })
    if (id !== undefined) {
      const tool = catalog.tools[Number(id)]
      await app.document({ title: tool.name, text: `${tool.description ?? ''}\n\n参数定义\n${pretty(tool.parameters)}` })
    }
  }

  async function agents() {
    const children = await runtime.children()
    if (!children.length) return app.document({ title: 'Agent 协作', text: '当前会话尚未派生子 Agent。\n\n当模型使用原生委托工具后，子 Agent 会在这里出现。' })
    const status = { running: '运行中', idle: '空闲', inactive: '未驻留' }
    await app.document({ title: 'Agent 协作', text: children.map((child) =>
      `${status[child.status] ?? child.status}  ${child.label ?? child.id}\n  ${child.mode === 'continuable' ? '可继续会话' : child.mode === 'one-shot' ? '单次任务' : '模式未识别'}\n  ${child.id}`).join('\n\n') })
  }

  async function queue() {
    const items = runtime.queue()
    if (!items.length) return app.document({ title: '待处理输入', text: '没有待处理输入。\n\nEnter：提交下一轮任务\n/steer：在最近的下一步介入\n/inject：补充上下文，不唤醒 Agent' })
    const id = await app.choose({ title: '待处理输入', detail: '下一步输入包括介入消息与上下文补充', options: items.map((item) => ({
      value: item.id, label: `${item.target === 'next-step' ? '下一步' : '下一轮'} · ${item.text.slice(0, 64)}`, description: '选择后可查看或撤回',
    })) })
    const item = items.find((entry) => entry.id === id)
    if (!item) return
    const action = await app.choose({ title: '处理排队消息', options: [
      { value: 'read', label: '查看全文' }, { value: 'remove', label: '撤回这条输入', description: '仅在内核尚未接收处理时生效' },
    ] })
    if (action === 'read') await app.document({ title: '排队消息', text: item.text })
    if (action === 'remove') app.notice(runtime.removeQueued(item.id) ? '已撤回待处理输入' : '该输入已被处理，无法撤回')
    app.requestRender()
  }

  return {
    async execute(name, rest) {
      if (!['workbench', 'context', 'inspect', 'tools', 'agents', 'queue', 'inject', 'steer', 'thinking'].includes(name)) return false
      if (busy) return true
      busy = true
      let nextCommand
      try {
        if (name === 'workbench') nextCommand = await app.choose({ title: '工作台', detail: '选择一个工作视角', options: ACTIONS.map(([value, label, description]) => ({ value, label, description })) })
        else if (name === 'context') await context()
        else if (name === 'inspect') await inspect()
        else if (name === 'tools') await tools()
        else if (name === 'agents') await agents()
        else if (name === 'queue') await queue()
        else if (name === 'thinking') registry.setDisplay({ thinking: !registry.display.thinking })
        else {
          const text = rest || await app.askText({ title: name === 'inject' ? '补充上下文' : '介入当前工作',
            detail: name === 'inject' ? '等待下一次处理；不会主动发起模型请求。' : '送达最近的下一步；空闲时开始一轮工作。' })
          if (text?.trim()) {
            kernel.submit(text, { delivery: name })
            app.notice(name === 'inject' ? '上下文已排入下一步 · /queue 查看' : '介入消息已发送 · /queue 查看待处理输入')
            app.requestRender()
          }
        }
      } finally { busy = false }
      if (nextCommand) await runCommand('/' + nextCommand)
      return true
    },
  }
}
