/**
 * 斜杠命令。
 *
 * 分两层，边界要清楚：
 *
 *   **本地命令**  由 TUI 自己处理，**绝不发给内核**（`/help`、`/exit`）。
 *                  这些是界面自身的能力，内核不认识它们。
 *   **内核命令**  交给 `ctx.commands.execute(agent, line, …)`——注册表、
 *                  执行、`command/run`/`command/done` 事件全部归内核所有。
 *                  TUI 只负责把行发过去、把结果画出来。
 *
 * 这个分法跟 pi 一样：本地命令是前端的事，其余是内核的事。
 */

import { MessageRole } from './registry.js'

/** 本地命令：TUI 自己处理，不经过内核。 */
export const LOCAL_COMMANDS = Object.freeze([
  { name: 'help', description: '列出所有可用命令' },
  { name: 'model', description: '查看或设置默认模型（/model provider/model）' },
  { name: 'doctor', description: '自检：哪些内核服务接上了、哪些没有' },
  { name: 'exit', description: '退出' },
  { name: 'quit', description: '退出（同 /exit）' },
])

/** 本地命令名集合，用于 O(1) 判断。 */
const LOCAL_NAMES = new Set(LOCAL_COMMANDS.map((c) => c.name))

/**
 * 从一行输入里解析出命令名。
 * @param {string} line - 形如 `/model deepseek-flash`
 * @returns {{name:string, rest:string}|undefined}
 */
export function parseCommandLine(line) {
  if (typeof line !== 'string') return undefined
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return undefined
  const body = trimmed.slice(1)
  if (body === '') return undefined
  const space = body.search(/\s/)
  if (space === -1) return { name: body.toLowerCase(), rest: '' }
  return { name: body.slice(0, space).toLowerCase(), rest: body.slice(space + 1).trim() }
}

/**
 * 创建命令系统。
 *
 * @param {object} options
 * @param {object} options.ctx
 * @param {()=>object|undefined} options.getAgent
 */
export function createCommandSystem({ ctx, getAgent }) {
  /** 内核注册的命令描述符；服务缺失或取数失败时给空数组，不抛。 */
  function listKernelDescriptors() {
    const agent = getAgent()
    if (agent === undefined || agent === null) return []
    try {
      return ctx.get('commands')?.list?.(agent) ?? []
    } catch {
      return []
    }
  }

  /** 本地命令 + 内核命令，供补全与 /help 统一使用。 */
  function listAll() {
    const local = LOCAL_COMMANDS.map((c) => ({ name: c.name, description: c.description, local: true }))
    const kernel = listKernelDescriptors().map((c) => ({
      name: c.name,
      description: c.description ?? '',
      input: c.input,
      local: false,
    }))
    return [...local, ...kernel]
  }

  /**
   * 把一行命令交给内核执行。
   *
   * @param {string} line
   * @param {AbortSignal} [signal]
   * @returns {Promise<{kind:'success'|'error', text:string}|undefined>}
   */
  async function executeKernel(line, signal) {
    const agent = getAgent()
    if (agent === undefined || agent === null) return undefined
    const commands = ctx.get('commands')
    if (commands === undefined || typeof commands.execute !== 'function') return undefined

    const execution = await commands.execute(agent, line, [], signal ?? new AbortController().signal)
    if (execution === undefined || execution === null) return undefined

    const result = execution.result
    if (result?.kind === 'error') return { kind: 'error', text: String(result.text ?? '命令执行失败') }
    const text = typeof result?.text === 'string' ? result.text : ''
    return { kind: 'success', text }
  }

  return {
    /** 是不是本地命令（TUI 自己处理的那种）。 */
    isLocal(name) {
      return LOCAL_NAMES.has(name)
    },
    listAll,
    executeKernel,
  }
}

/** `/help` 的正文。 */
export function helpText(commands) {
  if (commands.length === 0) return '没有可用命令。'
  const width = Math.max(...commands.map((c) => c.name.length + 1))
  const lines = commands.map((c) => {
    const name = ('/' + c.name).padEnd(width + 1)
    const tag = c.local === true ? '' : '  '
    return `${name}${tag}${c.description}`
  })
  return ['可用命令：', ...lines].join('\n')
}

/**
 * 命令补全 provider。
 *
 * 只在**行首**是 `/` 且还没输入空格时触发——`/model deepseek` 里的第二个词
 * 不该被命令补全接管（那是命令自己的参数语法）。
 *
 * @param {object} options
 * @param {()=>Array<{name:string,description?:string}>} options.list
 */
export function createCommandAutocomplete({ list }) {
  return {
    triggerCharacters: ['/'],

    async getSuggestions(lines, cursorLine, cursorCol) {
      const line = Array.isArray(lines) ? (lines[cursorLine] ?? '') : ''
      const beforeCursor = line.slice(0, cursorCol)
      const match = /^\/([A-Za-z0-9_-]*)$/.exec(beforeCursor)
      if (match === null) return null

      const typed = match[1].toLowerCase()
      let commands
      try {
        commands = list()
      } catch {
        return null
      }

      const items = commands
        .filter((c) => typeof c?.name === 'string' && c.name.toLowerCase().startsWith(typed))
        .map((c) => ({
          value: c.name,
          label: '/' + c.name,
          description: typeof c.description === 'string' && c.description !== '' ? c.description : undefined,
        }))

      if (items.length === 0) return null
      return { items, prefix: '/' + match[1] }
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const next = [...lines]
      const line = next[cursorLine] ?? ''
      const before = line.slice(0, Math.max(0, cursorCol - prefix.length))
      const after = line.slice(cursorCol)
      const inserted = '/' + item.value
      next[cursorLine] = before + inserted + after
      return { lines: next, cursorLine, cursorCol: before.length + inserted.length }
    },
  }
}

export { MessageRole }
