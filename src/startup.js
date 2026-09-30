/**
 * 本前门的命令行提供者。
 *
 * dsh 的 launcher 只解析它自己的旗标（--profile / --patch / --dump-config…），
 * 其余参数**原样**交给被启动的树（`ctx.cmdlineArgs`）。所以每个 app 自己
 * 拥有旗标家族、自己的 --help 文本和自己的解析错误。
 *
 * 这个插件把解析结果发布成普通 Cordis 服务 `dshTuiStartup`，入口插件再注入
 * 它。这样入口可以一直等到参数就绪才激活；`--help` 这类路径根本不会发布
 * 服务，入口也就不挂载。
 */

import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** 稳定的 Cordis 插件名。 */
export const name = 'dsh-tui-startup'

/** 需要命令行就绪才能解析。 */
export const inject = ['cmdlineArgs']

/** 本插件提供、由入口插件注入的服务名。 */
export const DSH_TUI_STARTUP_SERVICE = 'dshTuiStartup'

/**
 * 构造本 app 的命令定义。
 *
 * 每次调用返回全新的 program，方便同一进程内多次解析（测试）。
 * @returns {Command}
 */
export function dshTuiCommand() {
  return new Command()
    .name('dsh <profile>')
    .description('Interactive terminal front door for the DeepSeek Harness.')
    .helpOption('-h, --help', 'show this help')
    .option('-r, --resume <session-id>', 'resume a persisted session instead of starting a new one')
    .option('-m, --model <provider/model>', 'override the model route for this session')
    .argument('[prompt...]', 'initial prompt; multiple words are joined by spaces')
    .addHelpText(
      'after',
      `
Examples:
  dsh <profile>                      start an interactive session
  dsh <profile> "run the tests"      start with an initial prompt
  dsh <profile> --resume <id>        resume a persisted session

Environment:
  DSH_TUI_PERSONA     override the agent persona for this surface
  DSH_TUI_COLOR       force color depth: truecolor | 256
  DSH_TUI_FORCE_TTY   set to 1 to mount even when stdout/stdin are not TTYs
`,
    )
}

/**
 * 解析命令行并发布启动参数。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 携带 cmdlineArgs 的插件上下文
 */
export function apply(ctx) {
  const program = dshTuiCommand()

  program.action(() => {
    const opts = program.opts()
    ctx.provide(DSH_TUI_STARTUP_SERVICE, {
      /** 初始提示词；无参数时为空串。 */
      prompt: program.args.join(' '),
      /** 要恢复的 session id；未指定时为 undefined。 */
      resume: opts.resume,
      /** 本次会话的模型路由覆盖，形如 `provider/model`；未指定时为 undefined。 */
      model: opts.model,
    })
  })

  // parseCmdline 是 commander 适配器：它负责把 ctx.cmdlineArgs 交给 program，
  // 校验失败会走 commander 自己的错误路径（打印用法并以非零码退出）。
  parseCmdline(ctx, program)
}
