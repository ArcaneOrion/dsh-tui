/**
 * 本前门的命令行解析。
 *
 * **这个文件刻意不 import 任何东西。**
 *
 * 原因是一个真实的坑：profile 用 `link:` 安装本插件时，`node_modules/@arcaneorion/dsh-tui`
 * 是软链，而 Node 默认把软链解析成**真实路径**。于是模块解析从插件源码目录往上走，
 * 永远走不到 `~/.dsh/profiles/node_modules/` 那个共享仓库——`commander` 和
 * `@deepseek-ai/dsh-cmdline` 都会 `ERR_MODULE_NOT_FOUND`，表现为
 * `dsh-tui-startup: failed to import`，进而让主插件永远 `pending (waiting for service)`。
 *
 * 本 TUI 的旗标就那么几个，手写解析比拉两个包更小、更可控，而且 `parseArgs` 是纯函数，
 * 可以完整单测。
 *
 * dsh 的 launcher 只解析它自己的旗标（`--profile` / `--patch` / `--dump-config`…），
 * 其余原样通过 `ctx.cmdlineArgs` 交给我们，所以这里拿到的是属于本 app 的那一段。
 */

/** 稳定的 Cordis 插件名。 */
export const name = 'dsh-tui-startup'

/** 命令行就绪才能解析。 */
export const inject = ['cmdlineArgs']

/** 本插件提供、由入口插件注入的服务名。 */
export const DSH_TUI_STARTUP_SERVICE = 'dshTuiStartup'

/** `--help` 文本。 */
export const HELP_TEXT = `Usage: dsh <profile> [options] [prompt...]

Interactive terminal front door for the DeepSeek Harness.

Options:
  -r, --resume <session-id>   resume a persisted session instead of starting a new one
  -m, --model <provider/model>  override the model route for this session
  -h, --help                  show this help
  --                          everything after this is literal prompt text

Examples:
  dsh tui                      start an interactive session
  dsh tui "run the tests"      start with an initial prompt
  dsh tui --resume <id>        resume a persisted session

Environment:
  DSH_TUI_PERSONA     override the agent persona for this surface
  DSH_TUI_COLOR       force color depth: truecolor | 256
  DSH_TUI_FORCE_TTY   set to 1 to mount even when stdout/stdin are not TTYs
`

/** 需要独立取值的旗标。 */
const VALUE_FLAGS = {
  '-r': 'resume',
  '--resume': 'resume',
  '-m': 'model',
  '--model': 'model',
}

/**
 * 解析本 app 的参数。
 *
 * 纯函数，不读 process.argv、不写任何东西，方便单测。
 *
 * @param {readonly string[]} argv - `ctx.cmdlineArgs` 的值
 * @returns {{prompt:string, resume:string|undefined, model:string|undefined, help:boolean, error:string|undefined}}
 */
export function parseArgs(argv) {
  const result = { prompt: '', resume: undefined, model: undefined, help: false, error: undefined }
  const words = []
  const args = Array.isArray(argv) ? argv : []
  let literal = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]

    if (literal) {
      words.push(arg)
      continue
    }

    // `--` 之后一律当作字面提示词，不再当旗标解析。
    if (arg === '--') {
      literal = true
      continue
    }

    if (arg === '-h' || arg === '--help') {
      result.help = true
      continue
    }

    const key = VALUE_FLAGS[arg]
    if (key !== undefined) {
      const value = args[i + 1]
      if (value === undefined || value === '') {
        result.error = `option ${arg} requires a value`
        return result
      }
      result[key] = value
      i += 1
      continue
    }

    // `--resume=xxx` 形式
    const eq = arg.indexOf('=')
    if (eq > 0) {
      const long = arg.slice(0, eq)
      const eqKey = VALUE_FLAGS[long]
      if (eqKey !== undefined) {
        const value = arg.slice(eq + 1)
        if (value === '') {
          result.error = `option ${long} requires a value`
          return result
        }
        result[eqKey] = value
        continue
      }
    }

    if (arg.startsWith('-') && arg !== '-') {
      result.error = `unknown option: ${arg}`
      return result
    }

    words.push(arg)
  }

  result.prompt = words.join(' ')
  return result
}

/**
 * 从上下文里取本次调用的参数快照。
 *
 * **注意**：`ctx.cmdlineArgs` 是一个**服务对象**，不是数组。
 * dsh-cmdline 的契约是「`get()` 是它的全部接口，返回参数快照」。
 * 直接把它当数组用会得到一个对象（`JSON.stringify` 回 `{}`），
 * 于是所有旗标被静默丢弃——不报错，只是全部失效。
 *
 * @param {object} ctx
 * @returns {readonly string[]}
 */
export function readCmdlineArgs(ctx) {
  const service = ctx?.get?.('cmdlineArgs')
  if (service === undefined || service === null) return []
  if (typeof service.get === 'function') return service.get() ?? []
  // 兼容「直接给数组」的实现，避免将来 dsh 简化这一层时又炸一次。
  return Array.isArray(service) ? service : []
}

/**
 * 解析命令行并发布启动参数。
 *
 * `--help` 不发布服务——那样入口插件就不会挂载，终端保持干净。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 携带 cmdlineArgs 的插件上下文
 */
export function apply(ctx) {
  const rawArgs = readCmdlineArgs(ctx)

  // DSH_TUI_DEBUG_ARGS=1 时把 launcher 交过来的原始参数打到 stderr。
  // 排查「旗标到底有没有从 dsh launcher 到我们手里」时非常有用——这一层
  // 有好几个可能吃掉参数的地方（包装脚本、launcher、服务对象本身）。
  if (process.env.DSH_TUI_DEBUG_ARGS === '1') {
    process.stderr.write(`dsh-tui: cmdlineArgs = ${JSON.stringify(rawArgs)}\n`)
  }

  const parsed = parseArgs(rawArgs)

  const exit = ctx.get('appExit')
  const quit = (code) => {
    if (typeof exit === 'function') {
      exit(code)
      return
    }
    process.exitCode = code
  }

  if (parsed.help) {
    process.stdout.write(HELP_TEXT)
    quit(0)
    return
  }

  // 用法问题**只警告，不退出、也不阻止挂载**。
  //
  // 为什么不用错误码退出：本 bundle 可能被装进一个由**别的宿主**拥有的 profile
  // （你之前就把旧的 dsh-tui 留在 web profile 里）。那种情况下 `cmdlineArgs`
  // 是宿主的参数（例如 `--no-open --port 3080`），我们的解析器当然认不出来；
  // 此时若 exit(2)，会把宿主进程一起杀掉。
  // 少了这个风险，代价仅仅是自己的旗标拼错时静默走默认值。
  if (parsed.error !== undefined) {
    process.stderr.write(`dsh-tui: ignoring command line (${parsed.error})\n`)
  }

  ctx.provide(DSH_TUI_STARTUP_SERVICE, {
    prompt: parsed.prompt,
    resume: parsed.resume,
    model: parsed.model,
  })
}
