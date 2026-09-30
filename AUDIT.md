# 审查记录

本文件记录**只读代码审查**的结论与处理。审查按项目约定进行：交付复杂功能模块后，由独立子代理对交付物及其直接依赖做只读 review。

---

## 第 1 轮 · 首个垂直切片

**审查范围**：`src/` 9 个文件、`test/` 5 个文件、`cordis.patch.yml`、`package.json`。
**方式**：静态比对源码与 dsh 类型声明（未运行插件）。
**结论**：机制真实、边界纪律干净，但「每个区域都可整体替换」这条核心主张只兑现 5/7。

### 已修复

| # | 问题 | 修复 |
|---|---|---|
| **P0-1** | **`setFooter` / `setEditor` 是死接口**：`app.js` 里 `const editor = new Editor(...)`、`const footer = new DefaultFooter(...)`，从不读 `registry.footer` / `registry.editorFactory`，等于宣称可替换却在实现里写死 | 两者改为住在各自的**槽位容器**里，`registry` 变更时整体重建；editor 重建后重新 `setFocus`。并补了回归测试 |
| **P0-2** | **`turnActive` 可永久卡在 true → Ctrl+C 死锁**：只由 `turn/start` / `turn/end` 推断，日志若停在 `turn/start`（崩溃的孤儿回合）resume 后就再也回不到 false，`Ctrl+C` 永远只走「中断」分支退不出去。且 `agent/status` 通道整条是空的（`index.js` 没传 `onEvent`） | `replay()` 结束时把 `turnActive` 归零（历史不代表现在有回合在跑）；`index.js` 接上 `agent/status`，以 `running`/`idle` 为**权威**同步回合态 |
| **P0-3** | **`ctx.effect` 清理不 flush（数据丢失）**：Ctrl+C 路径会 flush，profile 卸载/他方 teardown 不会 | `teardown({flush})` 统一两条路径，都先 flush |
| **P0-4** | **`createApp` 抛错 → 内核泄漏**：`agent`、`session/event` 监听、默认渲染器全不回收 | `createApp` 与 `app.start()` 各包 try/catch，失败即 `teardown()` |
| **P0-5** | **无信号兜底**：SIGHUP / SIGTERM / 外部 SIGINT 直接杀进程，alt-screen、raw mode、光标不复位（终端会被搞坏） | 注册 SIGHUP/SIGINT/SIGTERM → 同一 `shutdown`；`process.on('exit')` 做最后一道同步还原；`ctx.effect` 里全部退订 |
| **P1-6** | **流式期间全量重渲染 O(行数)**：每个 token 都推进 `view.revision`，帧缓存必然失效，于是几百上千行历史被反复重建（每行都 `new Box/Markdown/Container`） | 行模型加 `rev` 版本号；`ChatView` 增加**行级缓存**，帧缓存失效时只有变化的行重渲染。另修掉 `lines.push(...arr)` 在行数上万时的 `RangeError` 风险 |
| **P1-7** | **空选择被当成真选择**：无默认模型时返回 `{provider:undefined,model:undefined}`，再作为 `current` 传给 `installModelSelection` | 无可用选择时返回 `undefined`，并整体省略 `agentOptions` |
| **P1-8** | **`cancel` 默认清空 inbox**：用户按 Esc 想「这次别说了」，却把已排队的后续输入也静默删了 | 改为 `cancel({kind:'user'}, {keepInbox:true})` |
| — | `setWorkingIndicator({intervalMs})` 永不生效（定时器间隔只读一次）；订阅回调漏 `working.invalidate()` | 定时器间隔每次重建时现取；订阅里补 `working.invalidate()` |

### 已知未修（P2，明确记录）

| 问题 | 影响 | 为什么暂不修 |
|---|---|---|
| 投影忽略 surface 事件的 `{op:'replace'}` | 压缩（compaction）发生后，界面可能保留旧行、与实际 surface 分叉 | 需要接 `foldSurface` / `isReplacementSurfaceEvent` 重做投影的行身份模型，属于**独立一块工作**，不在当前切片范围内 |
| `system/message` 被整体丢弃 | 压缩摘要不可见 | 同上 |
| 只含图片的 `user/message` 被静默跳过 | 用户发纯图时界面无反应 | 图片渲染尚未接入（`terminalImages` 未做），等图片支持一起处理 |
| `assistant/message` 不记录 turn/step 做去重 | 提交事件若晚于 `turn/end`，可能先落一条 `interrupted:true` 的假行 | 需要确认真实时序才能定去重键，留待运行时观察 |
| 退出无超时兜底 | `flush` 卡住时无法强退 | 需要实测 flush 的最坏耗时 |

### 待运行时验证（静态审查无法定论）

- resume 后 `agent.session.events` 是否已含崩溃孤儿回合的合成 `turn/end`。
- `ctx.get('agentDefaultModel').currentSelection()` 的服务名与返回形状。
- `installModelSelection` 在 `current` 为 `undefined` 时的行为。
- `agent/status` 在回合边界上的实际发放时机（是否存在 idle 早于最后一个 `assistant/message` 的窗口）。

---

## 第 2 轮 · 首次真实装载

**发现方式**：真终端跑 `dsh tui`，报
`dsh-tui-startup (@arcaneorion/dsh-tui/startup): failed to import`，
主插件随之永远 `pending (waiting for service: dshTuiStartup)`。

**结论**：不是插件逻辑问题，是**模块解析模型**的问题。

### 根因

profile 用 `link:` 安装本插件，`node_modules/@arcaneorion/dsh-tui` 是一个**软链**。
Node 默认把软链解析成真实路径，于是模块解析从
`/home/arcaneorion/AI/AI-DSH/plugin/DSH-TUI/` 往上走，
**永远走不到 `~/.dsh/profiles/node_modules/` 那个共享仓库**。

（你现有的 `dsh-teaching-board` 之所以没事，是因为它从 npm 仓库安装，是物理位于
profile `node_modules` 里的真实目录。）

### 已修复

| 问题 | 修复 |
|---|---|
| `startup.js` 找不到 `commander` / `@deepseek-ai/dsh-cmdline` | **改为零 import**：手写参数解析（`parseArgs` 是纯函数，14 条单测覆盖）。额外收益：内核边界从两个文件收缩到只剩 `kernel.js`；也少了两个依赖 |
| `kernel.js` 找不到 `@deepseek-ai/dsh-agent` 等 | 三个内核包 + `@deepseek-ai/cordis` 声明为 **devDependencies**（peer 保留为契约，devDep 供 `link:` 安装解析） |
| 非 TTY 下静默挂起，用户以为坏了 | 改为直接写 **stderr** 的明确诊断（不再走 logger） |
| **认不出参数时 `exit(2)`** ← 安全缺陷 | 若本 bundle 被装进**别的宿主**的 profile（你之前就把旧 dsh-tui 留在 web profile 里），`cmdlineArgs` 是宿主的参数（如 `--no-open --port 3080`），识别失败就退出会**连宿主进程一起杀掉**。改为只警告、不退出、仍发布服务，由入口的身份判定决定挂不挂 |

### 验证结果

```
dsh --profile tui --dump-config   → exit 0，0 条 skipping/incompatible
dsh tui < /dev/null               → 0 条 failed to import / pending / did not activate
                                    并输出明确诊断：
                                    dsh-tui: not mounting — neither stdout nor stdin is a TTY.
```

测试从 51 增至 **76 个用例，全部通过、0 跳过**——修复依赖解析后，原先因缺 profile 环境而跳过的入口集成测试全部真跑。

---

## 第 3 轮 · 功能补完（收尾）

**范围**：审批/提问回环、斜杠命令、工具卡、底栏、banner、开机信息块、`@` 引用、
语法高亮、偏好持久化、`/doctor`、独立启动器。

### 本轮实机踩到并修掉的两个坑

| 坑 | 症状 | 修法 |
|---|---|---|
| **`ctx.cmdlineArgs` 是服务对象不是数组** | `--resume` / `--model` / `--help` / 初始提示词**全部静默失效**，且不报任何错 | 新增 `readCmdlineArgs(ctx)` 调 `get()`；并加 `DSH_TUI_DEBUG_ARGS=1` 调试开关 |
| **`withAbort` 提前求值** | 请求已被取消，弹窗照弹 | 参数从「已建好的 promise」改成「启动函数（thunk）」 |

后者是测试先红才发现的——「已取消时不弹窗」那条断言直接把它照出来了。

### 本轮的安全加固

| 项 | 做法 |
|---|---|
| 非 TTY 宿主 | 从「静默挂起」改为**明确写 stderr 诊断**，但**不主动退出**——本 bundle 可能被装进别的宿主拥有的 profile，擅自退出会连宿主一起杀掉 |
| 认不出的命令行参数 | **不报错退出**，只警告。理由同上一行：那些参数可能是宿主的 |
| 记住的模型失效 | **忘掉它并重试一次**，否则用户会被一个自己都改不掉、而启动又起不来的偏好锁在门外 |
| 审批/提问弹窗抛错 | 交回瀑布链，让内核按自己的策略处理，**而不是替它决定「取消」** |

### 本轮的设计决策

- **工具卡不按工具名硬编码**。dsh 的工具自己声明展示意图
  （`presentCall`/`presentResult` → `generic/terminal/diff/search/read/web`），
  所以 `tool-cards.js` 里一个工具名都不出现，测试里也不出现。
- **降级原则贯穿**：任何数据源缺失，那一块就消失，不显示占位符或假数据。
  底栏少一段、开机信息少一节、代码没高亮，都是在说「那个服务没接上」。
- **`startup.js` 改成零 import**（手写参数解析）。收益：内核边界从两个文件
  收缩到只剩 `kernel.js`，且不再受 `link:` 安装的模块解析限制。

### 已知未修（延续第 1 轮）

P2 各项仍然成立（surface `replace` 语义、纯图片消息、assistant 去重、退出超时）。
本轮新增记录：

| 问题 | 影响 | 为什么暂不修 |
|---|---|---|
| 长会话帧组装仍是 O(行数) | 行级缓存已避免重复渲染组件，但每帧仍要拼接全部行 | 需要视口虚拟化；几千行以内可接受 |
| `/model` 只改下次启动 | 运行中切换模型需要重开会话 | 需要接 fork/rewind，是独立一块工作；命令里已明说 |
| 代码高亮覆盖面窄 | 只有常见语言且只做注释/字符串/数字/关键字 | 有意的取舍：**把代码高亮错比不高亮难看得多** |

---

## 第 4 轮 · 交付前审查（复审）

**范围**：全部 19 个源文件、13 个测试文件。**结论：有条件可交付**，抓到 2 个 P0、4 个 P1。

### P0（会让内核永久挂住 / 卡死退出）

| # | 问题 | 修复 |
|---|---|---|
| **P0-1** | **弹窗 Promise 有四条永不 settle 的路径**：`app.dispose()`、退出路径上的 `await kernel.dispose()`（它可能正在等这次工具调用）、组件 `render` 抛错、外部直接 `hideOverlay()`。任何一条都会把内核的审批 waterfall **永久挂住**，`shutdown()` 也走不到 `process.exit` | `createPrompter` 维护 `pending` 集合 + `cancelAll()`；`app.dispose()` 与 `teardown()` 都在 flush **之前**调它；`forwarding` 的 `render`/`handleInput` 包 try 并上报结算 |
| **P0-2** | **abort 只 resolve fallback，不撤掉已弹出的框** → 僵尸模态框：它继续吃按键，而回合已结束，Esc 被应用级监听当成「中断回合」消费掉，**用户根本关不掉它** | `withAbort` 增加 `cancelPrompt` 参数，abort 时主动撤框 |

### P1

| # | 问题 | 修复 |
|---|---|---|
| **P1-1** | **任何 registry 变更都无条件重建编辑器** → 输入内容、光标、历史全丢；`setFocus` 还会从打开的弹窗抢焦点。**这是最容易被漏掉的一条**：`setStatus`/`setWidget` 是对外开放的常规接口，一个按 token 刷新状态片段的插件会让订阅回调每帧触发 | 订阅回调用**引用比较**判断是否真的换了实现，只有变了才重建；`hasOverlay()` 为真时不抢焦点 |
| **P1-2** | 超大 diff 被**伪造成「全删全增」**再截断 → 用户看到「前 40 行被删」而实际只改一行，正面违反本模块「宁可朴素不可编造」 | 超阈值只输出一行 `N 行 → M 行（改动过大，未逐行展开）`；并加全局行数上限 |
| **P1-3** | `@` 补全的同步扫盘跑在**按键路径**上 → 大仓库阻塞事件循环，打字一顿一顿 | 首次扫描预热到启动时；TTL 过期改为 `setTimeout` 后台重扫，按键只读缓存 |
| **P1-4** | `prefs.write` 写失败仍返回成功 → 界面报「已记住默认模型」是**假成功** | 返回 `{ok, value}`，调用方如实上报；已存在的文件显式 `chmodSync` 收紧权限 |

### 一并修掉的 P2

- `tool-cards.js` 的 web/read/search 三处直接插值未校验字段 → 会渲染出字面 `undefined`（违反降级原则）。全部加类型守卫，缺失时给诚实的 `?`。
- `registry.js` 的 `setStatus` / `setWidget` disposer 只删 key、不还原前值，与文件头「还原上一个实现」的契约不符。改成**比较并交换**：只有当当前值仍是我装的那个时才还原（只记前值不够——乱序撤销会抹掉后注册者的值）。
- `footer.js` 用 `cwd.split('/')` 硬编码 POSIX 分隔符 → 改用 `path.basename`。

### 写这一轮时自己踩的坑

修 `setStatus` disposer 时，第一版只记「前值」，测试立刻红：乱序撤销（先撤第一个）会把后注册者的值一起清掉。**只记前值是不够的，必须做比较并交换**。这个坑是测试照出来的，不是想出来的。

### 复审后的主张判定

| 主张 | 判定 |
|---|---|
| pi-tui 地基 / `render(width):string[]` / 无 React | 兑现 |
| 每个界面区域可整体替换 | 兑现（7 个实现点全被消费；重建粒度已修正） |
| 内核边界（仅 kernel.js） | 兑现（`scripts/audit.mjs` 门禁） |
| 投影三条铁律 | 部分兑现（铁律 1 被 `flushStreaming` 打洞，见 P2） |
| 工具卡不按工具名硬编码 | 兑现 |
| 降级原则 | 兑现（含本轮补上的类型守卫与 `prefs` 真失败上报） |
