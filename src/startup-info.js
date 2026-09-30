/**
 * 启动信息块：开机时列出「我加载了什么」。
 *
 * 照 pi 的做法分节（`[Context]` / `[Skills]` / `[Commands]` / `[Plugins]` /
 * `[Theme]`），写进对话区，然后随对话自然滚进终端 scrollback——它不是常驻
 * 面板，只在开机能告诉你一次我用上了哪些东西。
 *
 * 每一节都**独立降级**：某个服务没挂或调用失败，那一节整节消失，其余照常。
 * 空的节不占位置，不写「(none)」这种废话。
 */

import { Container, Text } from '@earendil-works/pi-tui'

/** 取一个安全值：任何异常都当成「没有」，不打断启动。 */
async function safely(fn) {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

/**
 * 收集启动信息的分节。
 *
 * @param {object} options
 * @param {object} options.ctx
 * @param {()=>Array<{name:string}>} [options.listCommands]
 * @param {object} [options.theme]
 * @param {string} [options.cwd]
 * @param {string} [options.version]
 * @returns {Promise<Array<{label:string, items:string[]}>>}
 */
export async function collectStartupSections({ ctx, listCommands, theme, cwd = process.cwd(), version }) {
  const sections = []

  // ── 上下文 ─────────────────────────────────────────────────────────────
  const contextItems = [cwd]
  const instructions = await safely(async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    let dir = cwd
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(dir, 'AGENTS.md')
      if (fs.existsSync(candidate)) return candidate
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return undefined
  })
  if (instructions !== undefined) contextItems.push(instructions)
  sections.push({ label: '[Context]', items: contextItems })

  // ── 技能 ───────────────────────────────────────────────────────────────
  const skills = await safely(async () => {
    const service = ctx.get('skills')
    if (service === undefined || typeof service.list !== 'function') return undefined
    const list = await service.list()
    return Array.isArray(list) ? list.map((s) => s?.name).filter((n) => typeof n === 'string') : undefined
  })
  if (Array.isArray(skills) && skills.length > 0) {
    sections.push({ label: '[Skills]', items: [skills.join(', ')] })
  }

  // ── 命令 ───────────────────────────────────────────────────────────────
  const commands = await safely(() => {
    if (typeof listCommands !== 'function') return undefined
    const list = listCommands()
    return Array.isArray(list) ? list.map((c) => `/${c.name}`) : undefined
  })
  if (Array.isArray(commands) && commands.length > 0) {
    sections.push({ label: '[Commands]', items: [commands.join(' ')] })
  }

  // ── 插件行 ─────────────────────────────────────────────────────────────
  const plugins = await safely(() => {
    const loader = ctx.get('loader')
    if (loader === undefined || typeof loader.entries !== 'function') return undefined
    const names = []
    for (const entry of loader.entries()) {
      if (entry?.disabled === true) continue
      const id = entry?.options?.id
      if (typeof id === 'string' && id.startsWith('dsh-tui')) continue // 自己不算
      if (typeof id === 'string') names.push(id)
    }
    return names
  })
  if (Array.isArray(plugins) && plugins.length > 0) {
    sections.push({ label: '[Plugins]', items: [plugins.join(', ')] })
  }

  // ── 主题 ───────────────────────────────────────────────────────────────
  if (theme !== undefined && typeof theme.depth === 'string') {
    const tokens = Object.keys(theme.tokens ?? {}).length
    const versionText = typeof version === 'string' ? `dsh-tui ${version} · ` : ''
    sections.push({ label: '[Theme]', items: [`${versionText}${theme.depth} · ${tokens} tokens`] })
  }

  return sections
}

/**
 * 分节渲染器。
 *
 * 标签用 dim，内容用 muted，整体缩进——照 pi 的 `[Section]` 视觉。
 * 值的换行交给 pi-tui 的 Text（它会按宽度折行）。
 */
export function infoRenderer({ row, theme }) {
  const container = new Container()
  for (const section of row.sections ?? []) {
    container.addChild(new Text(theme.fg('dim', String(section.label ?? '')), 1, 0))
    for (const item of section.items ?? []) {
      container.addChild(new Text(theme.fg('muted', '  ' + String(item)), 1, 0))
    }
  }
  return container
}
