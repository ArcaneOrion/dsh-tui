import { createApp } from '../src/app.js'
import { createView, applySessionEvent } from '../src/projection.js'
import { createRegistry } from '../src/registry.js'
import { createTheme } from '../src/theme.js'
import { installDefaultRenderers } from '../src/messages.js'
import { createBanner } from '../src/banner.js'
import { createWorkbench } from '../src/workbench.js'
import { createCommandAutocomplete, LOCAL_COMMANDS, helpText, parseCommandLine } from '../src/commands.js'
import { fixtureEvents, fixturePresent, fixtureSnapshot, fixtureRuntime } from './fixtures.mjs'

const theme = createTheme(), registry = createRegistry(), view = createView()
installDefaultRenderers(registry)
for (const event of fixtureEvents) applySessionEvent(view, event, fixturePresent)
const runtime = fixtureRuntime()
let app, workbench
async function command(line) {
  const parsed = parseCommandLine(line)
  if (!parsed) return
  if (await workbench.execute(parsed.name, parsed.rest)) return
  if (parsed.name === 'exit' || parsed.name === 'quit') return exit()
  await app.document({ title: '演示模式', text: helpText(LOCAL_COMMANDS) + '\n\n模型和预设切换请在 dsh tui 中使用。演示不会调用模型、修改文件或保存会话。' })
}
function exit() { app?.dispose(); process.exit(0) }
app = createApp({ view, theme, registry,
  getSnapshot: () => fixtureSnapshot, getState: () => ({ turnActive: false }), getQueueState: runtime.snapshot,
  getSessionLabel: () => 'demo-v1',
  combineProviders: () => createCommandAutocomplete({ list: () => LOCAL_COMMANDS }),
  onSubmit(text) { runtime.submit(text); app.notice('演示：输入已排队 · /queue 查看；不会调用模型。') },
  onCommand: (line) => { void command(line).catch((error) => app.notice(error.message)) },
  onInterrupt() {}, onExit: exit,
})
workbench = createWorkbench({ app, kernel: { runtime, submit: runtime.submit }, view, registry, runCommand: command })
registry.setHeader(createBanner({ theme, getSubtitle: () => '交互演示 · 固定样例 · 无网络请求', getPreset: () => 'DESIGN 02', hasConversation: () => view.rows.length > 0 }))
process.on('SIGTERM', exit)
process.on('SIGINT', exit)
app.start()
