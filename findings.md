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
