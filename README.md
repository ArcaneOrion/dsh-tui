# DSH TUI

基于 DSH 原生内核与 `@earendil-works/pi-tui` 的终端工作台。第二版结合原来的鲸鱼标识与 Claude Code 的终端交互：蓝色强调、暖色欢迎框、清楚的角色标记与简洁输入区。上下文与工具全文按需查看。欢迎页是**对话流的第一行内容**（不是常驻表头），会随对话增长自然滚入终端 scrollback，往上滚随时能看到。

[第二版设计说明](docs/DESIGN-V2.md) · [最新前后对照](docs/benchmark-v2/index.html) · [第一版归档](docs/benchmark-v1/index.html)

## 开始使用

```sh
dsh tui
dsh tui "检查这个项目的测试"
dsh tui --resume <session-id>
dsh tui --model provider/model
dsh tui --preset standard
```

本机包装器把 `dsh tui` 转成 `dsh --profile tui`；其他环境可直接使用后者。需要已经安装 DSH、配置模型并建立 profile。

```sh
dsh plugin --profile tui add link:/path/to/DSH-TUI
```

在 `~/.dsh/profiles/tui/package.json` 的 `dsh.profile.bundles` 中加入 `@deepseek-ai/dsh-base` 与 `@arcaneorion/dsh-tui`；在 profile 的 `cordis.patch.yml` 配置 `agent-default-model` 的 provider/model。本仓库需先 `pnpm install`，供 `link:` 安装后的 Node 模块解析使用。

无需模型也能体验：

```sh
npm run demo
```

演示使用固定虚构数据，支持工作台、工具全文、上下文与消息队列；不会调用模型或执行文件工具。

## 操作

| 入口 | 行为 |
|---|---|
| `Ctrl+K`、`/workbench` | 搜索并选择工作视角 |
| `/resume`、`/resume <id>` | 搜索历史会话并原地恢复，可切换当前 / 所有工作区 |
| `Ctrl+O`、`/inspect` | 工具参数、原始结果与结构化展示数据全文 |
| `Ctrl+T`、`/thinking` | 展开 / 折叠思考 |
| `/context` | 当前模型上下文与来源 |
| `/inject 文本` | 补充下一步上下文，不主动唤醒 Agent |
| `/steer 文本` | 最近的下一步介入；空闲时唤醒 |
| 输入后 Enter | 提交下一轮任务 |
| `/queue` | 查看、撤回未处理输入 |
| `/tools` | 最近请求的实际工具目录；首次请求前展示当前作用域目录 |
| `/agents` | 当前会话子 Agent 的持久目录与驻留状态快照 |
| `/model` | 渠道 → 模型 → 推理强度选择 |
| `/model provider/model` | 校验后写入会话事件，下一步生效 |
| `/preset` | standard / ptc / minimal / cordis；仅内核认可的空白会话可切换。`/preset create` 进入创造模式（切到 cordis 预设，由 Agent 起草并安装声明预设的 bundle） |
| `/pane` | 文件编辑右栏：`/pane`（auto→on→off 轮换）或 `/pane auto\|on\|off`。Edit/Write 运行时右侧出现 diff，回合结束保留最后状态；窄终端（<96 列）自动收起 |
| `Shift+Tab`、`/permission` | 权限预设循环 / 选择：`read-only` → `workspace-write` → `danger-full-access`，每档同时定沙箱模式与审批策略（切换写进会话日志，底栏权限段与后续工具调用立即跟随）；`/permission <name>` 直接切 |
| `/theme` | 选择主题配色：`/theme` 弹选择器，`/theme blue\|pi` 直接切。热切即时生效并记住（默认 blue：深蓝底 + 蓝 accent；pi：墨蓝底 + 暖黄） |
| `/help` | TUI 与原生命令，包括已启用的压缩、计划、目标等功能 |
| `/doctor` | 真实服务接入诊断 |

全文面板：`↑↓` / `j k` 滚动，`PgUp/PgDn` 翻页，`Home/End` / `g G` 到首尾，`Esc` 返回。面板打开时 Esc 优先关面板；回到编辑器后 Esc 中断回合，保留待处理输入。空闲时 Ctrl+C 退出，运行时连续两次 Ctrl+C 退出。

Ctrl+T 按一次切换思考显示，长按重复与松开事件不会再次切换。`/resume` 先准备目标会话并保存当前会话，成功后更新历史、模型、预设与状态栏；失败保留当前会话。当前回合、子 Agent 正在运行或仍有待处理输入时，先结束工作或通过 `/queue` 处理队列，再切换。列表显示最近 100 个可恢复的非驻留主会话；也可以直接传完整 ID。

打开列表要扫会话目录（实测全库 ~250ms）并为每个候选折叠标题（~620ms），所以底栏在读取期间显示「正在读取会话目录…」；同一范围 20 秒内重复打开走缓存（实测 66ms）。`DSH_TUI_DEBUG_SESSIONS=1` 会把两段耗时写进 `$TMPDIR/dsh-tui-sessions-timing.log`。

`@` 优先使用原生 `fileReferences`，支持目录与 `@"带空格路径"`。它是路径引用，模型按需 read；UI 不会暗中展开文件全文。缺少服务时降级为本地路径补全。

默认将裸 LF 当作提交；`DSH_TUI_LF_SUBMITS=0` 保留 Ctrl+J 换行。支持扩展键盘协议的终端可以用 Shift+Enter 换行。

## 信息与事实

- 聊天记录保留已读对话，压缩替换不追加为新回复；`/context` 单独显示当前模型可见内容。
- `/context` 读取 `session.deriveMessages()`，不重新执行 prompt assembly。
- `/inject` 尚未被处理的材料位于 `/queue`，不提前标为模型已收到。
- 底栏是一行**连续色块状态行**（对齐 Claude Code 的状态行样式）：模型 · think · 上下文用量 · 权限 · 路径 · 分支 · 状态提示 · CPU · 内存 · 时间，每段一块饱和底色 + 浅色文字、段间无缝、末段铺满整行。窄屏按优先级丢弃（用量与权限最后丢），路径段先左截断成 `…/tail`。切换模型会刷新容量，不沿用旧上限。
- **输入栏是一整块底色**（含上下边框行、铺满整行），读作「一块可以输入的色块」。
- 状态行**下面**还有一行持久权限提示（`⏸ 权限 <预设>（Shift+Tab 循环）`，危险档转警示色 ⚠），对齐 Claude Code 的 `⏸ plan mode on (shift+tab to cycle)`。底部区域预览见 [docs/bottom-area.png](docs/bottom-area.png)。
- 工具预览短小，完整结果在 `/inspect`；面板打开时可以读取工具的新结果。
- 审批与提问只认领当前 TUI 所属 Agent 树，支持独立取消、多选、自定义答案与计划全文审阅。
- 子 Agent 的“未驻留”不表示成功完成。

## 扩展

活跃 UI 发布为 Cordis 服务 `dshTui`：

```js
export const inject = ['dshTui']
export function apply(ctx) {
  const { registry } = ctx.get('dshTui')
  const dispose = registry.setStatus('my-plugin', '● connected')
  ctx.effect(() => dispose)
}
```

支持 `setHeader`、`setFooter`、`setEditor`、`setWidget`、`setWorkingIndicator` 与 `setMessageRenderer(role, factory)`。返回的 disposer 幂等并支持乱序卸载。`'*'` 仅为未注册角色兜底；统一包裹消息时遍历 `registeredRoles()` 并按角色替换。

输入仍由 pi-tui 处理粘贴、历史、IME 与补全，`WorkbenchEditor` 负责外观。只有 `kernel.js` 导入 DSH 运行时包；工作台使用其显式 runtime 接口。

## 验证与设计材料

```sh
npm test
npm run check
npm run audit
npm run demo
npm run design:preview
```

`design:preview` 读取 Git HEAD 作为基线，也可用 `npm run design:preview -- --baseline f8ce820` 指定第一版提交。在 `/tmp` 建源码副本，用同样的事件和宽度渲染新旧组件，输出 HTML、ANSI、JSON 到 `docs/benchmark-v2/`，保留第一版材料；不访问模型。

已验证：组件与交互测试、真实 PTY 演示、隔离 DSH profile 挂载、26 项工具目录、上下文注入与队列撤回。本轮未发送真实模型计费请求；流式、工具结果与审批回归使用确定性事件和服务测试。

## 第一版范围

- 一套深色主题；字体和整体背景由终端控制。
- 保留终端原生滚动，无鼠标工具卡或常驻侧栏。
- 图片显示存在性提示，尚无图片粘贴、上传或像素渲染。
- 子 Agent 面板为读取时快照，目前不直接发送子 Agent 消息或控制其任务。
- 历史行有缓存，但每帧组装仍为 O(消息数)，未实现虚拟化。
