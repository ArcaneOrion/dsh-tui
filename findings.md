# 设计依据与运行时发现

## 第二轮反馈与定位

- 用户不喜欢“› 写下你要做的事”，认为首次进入太单调、双方角色区分不足。
- 第一版已提交 f8ce820；保留第一版 benchmark 为固定材料。
- Ctrl+T 的应用级 input listener 位于 pi-tui 的 key-release 过滤之前；当前没有过滤 release/repeat，可能按下和松开各切一次。
- 原生 sessionQuery.listSessions() 读取持久与 live 统一目录，readTitleSnapshots 可批量读取标题；只有启动参数 --resume 已实现。
- Tavily 搜索受账号额度限制，已直接读取 Claude Code 官方 interactive-mode / common-workflows / sessions 文档。
- 官方资料确认 /resume 在会话内打开选择器，Ctrl+O 切换详细 transcript；这里保留用户已使用的 Ctrl+T 思考切换，不照搬 Claude Code 的任务清单绑定。
- 输入角色采用 > 标记与底色，助手采用 ● 与 DeepSeek 标签；欢迎页恢复鲸鱼，增加快捷入口与会话信息，输入框仅保留边界和光标提示符。
- 第二轮真实 PTY：持久会话标题进入 /resume 列表，选择后恢复用户文字、模型路由、5.9k 上下文；选择过程无外部模型调用。
- 第二轮 304 项测试通过；窄/宽欢迎页与会话界面均无字符宽度越界。

## 已确认

- 使用 pi-tui 0.82 的命令式 render(width) → string[]，继承终端原生滚动。
- DSH 提供 durable session/event 与 transient agent/assistant-stream 两条路径。
- 人类 transcript 应保留 append-origin 事件；model-visible surface 可被压缩替换。
- 工具自身有 presentCall / presentResult 展示契约，不需要硬编码工具名称。
- 现有审批、提问、模型选择、预设切换、命令与 @ 路径补全已有实现。
- 目前输入只发送文本；@ 补全不等于附件注入。必须核对 file-reference 原生契约。
- 工作区已有 src/index.js、kernel.js、model-catalog.js 与 model-catalog 测试的未提交修改。

## 审查基线

- 282 个测试分别执行全部通过；npm check 与 audit 通过。
- 100 条历史，一次 app.requestRender 后全量重建 100 条。
- 模型从 1M 窗口切到 32k，旧 contextLimit 继续使用。
- footer 从 100 列缩到 40 列仍复用旧横线；分支字段没进入缓存键。
- registry 是 apply 内部对象，外部 Cordis 插件无法取得活跃实例。
- setFooter 乱序卸载会清除后注册者并复活已经卸载的前注册者。
- thinking 与工具长输出缺少展开入口。

## 原生接口核对

- fileReferences.list(agent, query, signal) 返回 {path, kind}；原生设计就是路径引用，模型按需 read；支持 @"带空格路径"，不应在 UI 偷偷展开文件。
- session.deriveMessages() 为当前模型上下文，session.requestHeader() 为最近请求配置；不调用新的 prompt assembly 来伪称实际注入。
- agent.inbox.nextTurn / nextStep 及 inbox.remove 提供排队与 steering 可见性；后续核对 agent.steer。
- subagents.listChildren(parentSessionId) 为持久子 Agent 目录，无需唤醒子 Agent。
- 选择将 /context、/tools、/agents、/queue、/inspect 作为工作台入口；实际内容只来自运行时契约。

## 实机证据

- 隔离 DSH_HOME=/tmp/dsh-tui-native-v1 下启动真实 dsh tui 成功；使用 standard 预设，无提示词、无模型请求。
- /tools 显示当前作用域的 26 个真实工具，证实 scoped schemas 与预设已连接。
- PTY 演示跑通 Ctrl+K → 上下文 → 全文 → Esc → Ctrl+C，退出恢复终端。
- 生成对照：同一 fixture 基线 37 行、第一版 30 行；48 与 100 列均零宽度越界。
- 1000 条历史 / 20 次界面更新：基线额外渲染 20000 行，第一版 0；仅计受控工作负载，不推论网络延迟。
- Chromium 已截图检查对照页；终端配色与浏览器展示可能因字体不同略有差异。

## 2026-10-01 Cordis 审查初始发现
- 工作区初始干净；HEAD ac880bb。
- 历史 progress 记录：cordis preset 缺少 cordisInspect 宿主依赖；权限服务已存在但无 TUI 入口；startup-info 有代码和测试却未接入。
- 以上是历史记录，需要结合代码验证，不能直接归因为 Cordis 内核缺陷。
- 代码确认：createKernel 在 apply 期间等待 preset.resolve，250ms 轮询、20s 超时；UI 在其后创建，因此启动依赖问题挡住修复入口。
- index.js 声明最小 inject，但 cordis.patch.yml 又声明 agents/sessions/agentDefaultModel 必需依赖；软降级与装配层硬等待并存。
- prompts.choose 默认异常路径仍 finish(undefined)，仅 DEBUG_PROMPT=1 写错误；异常与用户取消仍混为同一结果。
- 当前历史只覆盖 2026-09-30 至 10-01 的 TUI 仓库，不能代表上游 Cordis 的长期演化。
- 隔离复现：showOverlay 抛错与用户 Esc 都返回 undefined，无法区分；无 DEBUG 开关时无错误反馈。
- 隔离复现：parseArgs(['--model','--preset','cordis']) 返回 model='--preset'、prompt='cordis' 且无 error。
- 隔离复现：无任何内核服务时命令清单仍含 permission，与 README 的缺服务隐藏入口描述不符。
- 内核 preset.select 在 turnBoundary.lastTurn > 0 时拒绝切换；创造模式承诺装好后 /preset 选择，但创建本身用掉一个回合，原会话切换必然被锁。TUI 自己没有 /new，需重开进程或依赖宿主额外命令。
- Loader index.ts:134 将 YAML inject 合并进 fiber.inject，确认代码最小 inject 无法取消 YAML 的硬依赖。
- 本轮最终判断与证据分级见 docs/CORDIS-REVIEW-2026-10-01.md；全部 337 项现有测试通过仍不覆盖创造模式从创建到使用的完整闭环。

## 2026-10-01 右侧文件视图讨论
- 用户实际关注会话流与文件编辑视图分工，而非 Cordis 插件架构审查。
- 现有 EditPane 为 nonCapturing overlay，右侧固定 36%，终端少于 96 列隐藏；左侧整棵布局缩窄。
- 右栏只持有最后一次 diff 工具调用，回合结束保留；不能独立滚动、不能切换文件，长行截断；因此只是编辑预览，不是完整审阅视图。
- 现有源码关于“与 Claude Code 一致”的注释仅是旧实现声称，本轮需用当前官方资料核验。
- 当前 Claude Code 官方 interactive-mode 文档明确：v2.1.260+、fullscreen、git、至少110列可打开持久 /diff 侧栏，144列首次编辑自动打开；文件列表+增删数+diff、独立滚动、选区加入下一条提问、会话/未提交/分支基线切换；非fullscreen降级为占输入区的 viewer。
- 官方 Desktop 支持 chat/diff/file/terminal 等可重排 pane，Normal 模式折叠工具摘要；VS Code 的 Focus view、终端的 /focus 进一步压缩过程。不同入口不能混同。
- Tavily 搜索经授权安装依赖后遭远端 SSL EOF，未取得搜索证据；本轮依据已直接取得的官方文档与官方 CHANGELOG，不引用搜索摘要。
