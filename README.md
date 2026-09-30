# @arcaneorion/dsh-tui

一个从零写的 **DeepSeek Harness 终端前门**。

渲染地基是 [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)（MIT，与 pi agent 零耦合的通用终端 UI 库），内核是 dsh 自身的 agent / 会话事件 / 审批与提问服务。外观参考 pi 的 TUI。

```sh
dsh tui                    # 启动
dsh tui "跑一下测试"        # 带初始提示词
dsh tui --resume <id>      # 恢复会话（已端到端验证：历史对话会重新渲染）
dsh tui --model provider/model
```

`DSH_TUI_LF_SUBMITS=0` 可保留 `Ctrl+J` 换行（默认把 LF 当回车提交，见下）。

---

## 装起来

本 TUI 是 dsh 的一个 bundle，运行需要一个 profile。四步：

```sh
# 1. 建 profile 并装插件（dsh 会自动初始化 profile）
dsh plugin --profile tui add link:/path/to/DSH-TUI

# 2. 让 profile 引用它（编辑 ~/.dsh/profiles/tui/package.json）
#    "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@arcaneorion/dsh-tui"] } }

# 3. 在 profile 的 cordis.patch.yml 里指定模型路由
#    （dsh-base 的默认是 deepseek-official/deepseek-flash，需要有效的 key）
#    - id: agent-default-model
#      config: { provider: <你的>, model: <你的> }

# 4. 跑
dsh tui
```

**上火先跑 `/doctor`。** 它直接回答「哪些内核服务接上了」——底栏哪一段没出现、
审批弹窗有没有应答者、工具注册表有几件，都在这条命令里。

`dsh tui` 是 `dsh --profile tui` 的简写（由本机 `dsh` 包装脚本重写，
**只认 `tui` 这一个名字**）。

---

## 设计主张

**每个界面区域都是一个「可整体替换的单一实现点」，不是写死的常量。**

这条是它存在的理由。想给所有消息加外框、想换掉整个状态栏、想把输入框固定在屏幕下方——都应该是注册一个实现，而不是去 patch 组件原型。

```js
registry.setMessageRenderer('assistant', ({ row, theme }) => myFramedComponent(row, theme))
registry.setFooter(myStatusBar)
registry.setEditor((tui, theme) => myVimEditor(tui, theme))
registry.setHeader(myBanner)
registry.setStatus('my-plugin', '● active')
registry.setWidget('todos', ['[ ] 一件事'])
registry.setWorkingIndicator({ frames: ['◐', '◓', '◑', '◒'], intervalMs: 120 })
```

每个 setter 都返回 **disposer**，撤销即还原上一个实现。

| | 写死 / patch 原型 | 本项目的注册表 |
|---|---|---|
| 给所有消息加外框 | 包裹 N 个组件的 `render`，配一大套 fail-closed 回滚 | `setMessageRenderer('*', …)` 一行 |
| 换输入框 | 依赖内部导出，版本一升就崩 | `setEditor(factory)` |
| 卸载恢复 | 手工还原原型 | disposer 自动还原 |

## 分层

```
src/kernel.js        内核桥：建/恢复 agent、订阅事件、中断、flush   ← 唯一碰 @deepseek-ai/*
src/projection.js    投影：dsh 事件 → 视图模型（行）
src/registry.js      实现点：7 个可替换区域 + 消息渲染器注册表
src/tool-cards.js    工具卡：按工具自己声明的展示意图渲染
src/messages.js      默认消息渲染器（注册式，非写死）
src/app.js           pi-tui 外壳：组装、输入、动画、退出还原
src/prompts.js       模态层：审批与提问的 overlay
src/interactive.js   人机回环：两个 waterfall 的应答
src/commands.js      斜杠命令：本地命令 + 内核命令 + 补全
src/footer.js        底栏：7 段真实数据
src/banner.js        顶部 banner
src/startup-info.js  开机信息块
src/mentions.js      @ 文件引用补全
src/highlight.js     语法高亮
src/prefs.js         偏好持久化
src/theme.js         颜色 token 表 → pi-tui 三套 theme 形状
src/host.js          启动身份判定（非 TTY 静默降级）
src/startup.js       命令行解析（零 import）
src/index.js         入口：判定 → 装配 → 退出路径
```

**内核边界**：只有 `kernel.js` 允许 import `@deepseek-ai/*`。dsh 还在 `0.x`，升级时改动只落在这一个文件里。

## 三条投影铁律

1. **回放与实时走同一条路**——`applySessionEvent` 同时服务两者，所以 resume / rewind 看到的一定和实时一致。
2. **过程态与提交态分开**——`agent/assistant-stream` 的帧只用于渲染正在生成的文本；一旦 `assistant/message` 提交，就丢弃流式缓冲。流式事件永远不是真相。
3. **未知事件类型静默忽略**——第三方插件追加的事件不能让界面停止更新。

## 降级原则

**任何一个数据源缺失，对应的那一块就消失，而不是显示占位符或假数据。**

底栏少了一段、开机信息块少了一节、代码没高亮——都是在告诉你「那个服务没接上」，而不是在撒谎。想知道具体是哪个服务，跑 `/doctor`。

## 工具为什么不需要按名字硬编码

dsh 的工具自己声明展示意图：

```
presentCall(args)            → generic │ terminal │ diff
presentResult(args, result)  → generic │ terminal │ diff │ search │ read │ web
```

所以 `tool-cards.js` 里**一个工具名都不出现**，新工具装上就自带合适的卡片。认不出的卡片类型退回原文。

## 滚动模型

pi-tui 只把「底部一个屏高」维持为活视口，其余行推进终端原生 scrollback。所以历史滚动、选择、复制、搜索**全部由终端原生提供**，本项目不需要写虚拟列表。

## 界面上有什么

```
   ▄▄███▄▄      ▄▄        ██████╗ ███████╗███████╗██████╗ …
  █████████▄▄▄▄██         ██╔══██╗██╔════╝██╔════╝██╔══██╗…
  ███   ████████▀         ██║  ██║█████╗  █████╗  ██████╔╝…
  ████▄    ▄████          ██║  ██║██╔══╝  ██╔══╝  ██╔═══╝ …
   ▀██████████▀           ██████╔╝███████╗███████╗██║     …
 dsh-tui 0.1.0 · deepseek-official/deepseek-flash

 [Context]
   /path/to/project
 [Skills]
   ...
 [Commands]
   /help /model /doctor /exit /compact …

 · 你好
 ┌──────────────────────────────────────────────┐
 │ 你好！有什么可以帮你的？                        │
 └──────────────────────────────────────────────┘
 ⠋ working
 ┌──────────────────────────────────────────────┐
 │ <输入>                                        │
 └──────────────────────────────────────────────┘
──────────────────────────────────────────────────
 deepseek-official/deepseek-flash │ dir project │ ⏵ main │ 12.3k/1.0M (1.2%) │ yolo   3f8a21c4
```

- **审批与提问**弹模态框：工具要授权时选「允许一次 / 拒绝」；模型问问题时给选项菜单或文本框。
- **工具卡**按工具自己的声明渲染：`read` 是带行号的代码视图、`edit`/`write` 是真实三色 diff、`grep` 是分组命中、`web_search` 是引用列表。
- **命令补全**在行首 `/` 触发；**文件引用补全**在 `@` 触发。
- `Esc` 中断当前回合（保留你已排队的后续输入），`Ctrl+C` 空闲时退出。

## 开发

```sh
pnpm install     # pi-tui + 内核包（devDependencies，供 link: 安装时解析）
pnpm test        # 200 个用例，全部无需 TTY
pnpm check       # 语法检查
```

测试全部**无需 TTY**：pi-tui 的组件是 `render(width) → string[]` 的纯函数，所以宽度约束、缓存、错误边界、实现点可替换性、降级行为都能钉死。真实终端里的观感仍需人验。

### 为什么内核包是 devDependencies

`kernel.js` 直接 `import '@deepseek-ai/dsh-agent'` 等。这些包**也是** peerDependencies（声明运行时契约）——但只写 peer 会踩一个坑：

profile 用 `link:` 安装本插件时，`node_modules/@arcaneorion/dsh-tui` 是软链，Node 会把它解析成**真实路径**，模块解析因此从插件源码目录往上走，**走不到 `~/.dsh/profiles/node_modules/` 那个共享仓库**，于是 `ERR_MODULE_NOT_FOUND`。

把同样的版本同时写进 devDependencies，`pnpm install` 就会把它们装进本目录，`link:` 安装也能解析。

## 已知限制（明确不做或没做）

| 限制 | 说明 |
|---|---|
| 无代码高亮的语言 | `highlight.js` 只认注释/字符串/数字/关键字，且只对常见语言；其余退回纯色 |
| `/preset` 只能在空白会话切换 | 内核契约：预设决定工具目录，已有回合的会话切换会破坏日志一致性（canonical `agent-preset/locked`）；命令会把错误如实显示 |
| `@` 引用不做内容展开 | 补全成路径后原样发给模型，由它自己用 read 工具读 |
| 投影忽略 surface 的 `replace` 语义 | 压缩（compaction）后界面可能与实际 surface 分叉；见 `AUDIT.md` |
| 纯图片消息不渲染 | 图片渲染尚未接入 |
| 长会话全量重渲染 | 已做行级缓存，但帧组装仍是 O(行数)；几千行以上会变慢 |

## 模型与会话预设

**运行时切换模型（不需要重开会话）：**

```
/model                              # 渠道 → 模型 → 推理强度 三级弹窗（真实 llm 目录）
/model my-opencode-go/deepseek-v4.1-flash
/model roundrobin/round-glm-5-3f/deepseek-v4.1-flash   # 虚拟轮询组也支持
```

切换语义与内核 canonical 一致：`llm.resolveCallConfig` 先校验（无效渠道/模型/强度直接报错）→
写入 durable `model/selection` 事件（resume 后仍然有效）→ 更新可变 selection ref（**下一步请求生效**，
正在运行的请求不受影响）→ 后台保存为新默认（保存失败会如实提示）。

**会话预设（capability composition）：**

```
/preset            # 弹出预设列表（standard / ptc / minimal / cordis）
dsh tui --preset ptc
```

预设决定一个会话的工具目录、提示词与委托能力。启动时按 `--preset`（或 registry 默认 `standard`）
挂载；resume 时按 durable 记录恢复——**历史会话绝不会被新默认覆盖**。

## 状态

已可运行：profile `tui` 已建立，`dsh --profile tui --dump-config` 组合通过，非 TTY 下给出明确诊断。

**已实测（PTY 端到端）**：挂载、流式回复、审批弹窗、会话恢复、`/model` 选择器与直切、`/preset` 列表。
**仍需人验**：真实终端里的观感、长会话性能。
