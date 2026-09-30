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

---

## 第 5 轮 · 「回车提交不了」的第一次误判

**（保留原样，因为它记录了两个错误结论是怎么产生的——它们本身是教训。）**

首次实机交互时判断为「终端把 Enter 发成 LF 而 pi-tui 只认 CR」。这个判断
**基于真实测量**（用真 `Editor` 实例喂字节确认过），但**不是你遇到的问题**——
你的终端发的是 CR。

留下的是 `src/input-compat.js`：它仍然有价值（LF 终端确实会撞上 pi-tui 这个
行为），但它不是病因。真正的病因见第 6 轮。


**现象**：`dsh tui` 完全正常渲染——banner、开机信息块、底栏五段真实数据全部到位
（`6.8k/1.0M (0.7%)` 说明 tokenMeter 通了，`workspace-write` 说明 sandboxPolicy 通了）。
**能打字，但回车后什么都没发生，且没有任何报错。** 终端提示符留下 `INT` 标记。

### 定位过程（记录方法，因为它值得复用）

1. **先排除按键分派层**：读 pi-tui `tui.js` 的 `handleInput`，确认输入监听器返回
   `undefined` 不会吞掉按键，`data` 会继续传给 focus 组件。
2. **再确认提交链**：读 `editor.js`，`kb.matches(data,"tui.input.submit")` →
   `submitValue()` → `this.onSubmit(result)`；`tui.input.submit` 默认就是 `enter`、
   `disableSubmit` 为 false。而且 `submitValue()` **先清空编辑器再回调**——
   所以「文字消失但什么都没发生」是必然表现，问题在下游。
3. **消除静默失败**：`kernel.submit` 原本在 agent 未就绪时直接 `return`（调用方也没
   catch）。改为抛错并显示。加 `DSH_TUI_DEBUG_SUBMIT=1` 开关区分「回调没被调到」
   与「调到了但内核没反应」。
4. **实机反馈：开关什么都没打出** → 回调根本没被调到，问题回到按键层。
5. **绕开 TTY 直接测**：把真实的 `Editor` 实例化出来喂字节——

   ```
   输入"1"后按 CR(\r) → onSubmit 触发，内容 "1"
   输入"1"后按 LF(\n) → 不触发
   （加不加补全 provider 都一样；"/h" 后按 CR 也能提交 → 不是补全抢键）
   ```

### 根因

pi-tui 的 Editor 里**「换行」分支排在「提交」分支前面**，而 `tui.input.newLine`
的默认键含 **`ctrl+j`**——**Ctrl+J 在终端里发出的就是 LF(`\n`)，与 Enter 同一个
字节**。所以把 Enter 发成 LF 的终端，回车被**合法地**解释成「插入换行」。

**这解释了为什么完全不像出错**：按键正常、字符正常显示，只是悄悄换了一行。

### 修法

`src/input-compat.js`：在最早的输入拦截点做**自动判定**——

- **见过 CR** → 该终端用 CR 提交，`LF` 保留 `Ctrl+J` 换行的原义，不干预
- **没见过 CR** → 把裸 LF 翻译成 CR

可用 `DSH_TUI_LF_SUBMITS=0/1` 覆盖。因为 URL 里的 `search` 参数不会被影响
（多字节序列与括号粘贴整体通过，单测覆盖）。

### 这次得到的教训

**「没有任何报错」不等于「没出错」。** 这个缺陷从头到尾没有抛过一次异常——
它是按键被合法地解释成了另一种操作。所以：

- 静默失败（`if (x === undefined) return`）比抛错危险得多，已全部改为显式。
- 当症状是「什么都没发生」时，最有价值的动作不是继续读代码，而是
  **构造一个能绕开环境限制的最小复现**。这次是把 `Editor` 单独实例化喂字节，
  一次就定位了。

---

## 第 6 轮 · 「回车没反应」的真正原因（端到端排查）

**现象**：`dsh tui` 渲染完全正常，能打字，回车后**什么都没发生**，也没有任何报错。

### 查到的事实（都有证据）

用 `script -qec` 分配真 PTY 自己跑，并把按键字节、屏幕转储、会话日志三路对齐：

```
按键通道   init: isRaw=true              ← raw mode 正常
           tui: "a" "b" "\r"             ← 输入确实到了 TUI
提交链路   onSubmit 触发 → followup 调用 → turn/start → user/message ✓
模型调用   assistant/attempt: AUTH 401    ← 失败在这一步
           turn/end: {kind:'error', error:{code:'AUTH', status:401}}
```

**所以：回车一直是好的，消息也进了会话，是模型调用在失败**——
`deepseek-official`（dsh-base 的默认 provider）在这台机器上 key 无效。
而**投影层只认 `assistant/message`，把 `turn/end` 的错误整个丢掉了**，
界面上只剩一个转完就停的 spinner。

### 修掉的真 bug

`MessageRole.ERROR` + 投影在 `turn/end.reason.kind === 'error'` 时落一行
+ `formatFailure()` + 红色 `errorRenderer`。PTY 实测已可见：

```
 ✗ AUTH 401: Authentication Fails, Your api key: ****aac4 is invalid
```

### 排查路上的三个自身错误（都值得记）

| 错误 | 后果 |
|---|---|
| 第一版回车兼容写成「见过 CR 就不再翻译 LF」 | CR 先出现一次就把开关置真，真正的 LF 再也不翻译——**等于没修**。LF 与 Ctrl+J 无法区分，不能靠历史猜 |
| 用 `zlib.zstdDecompressSync` 读会话日志 | 它**只解第一帧**，于是我以为「会话里只有 1 个事件、消息没进会话」，结论完全跑偏。用 `zstd -dc` 才解出全部 20~36 个事件 |
| 说「没有 TTY 所以测不了」 | 错的。`script -qec` 就能分配真 PTY。**这个项目从一开始就能被我自己端到端测试** |

### 关于「共享 bundle」方案的结论（有实测反例）

原本想把 provider 配置抽成共享 bundle。**实测证明这个方案对本插件行不通**：

1. `dsh-settings` 把改动持久化到**当前 profile 的补丁层**；
2. 补丁语义是**整体替换 `config`，绝不深合并**；
3. 于是插件写一次 `health`，profile 层就出现一份**只有 health 的残缺 config**，
   把 bundle 里的 `groups` 整个盖掉——实测当场复现（`groups 数量: 0`）。

**要做到一份真相**，得把模型定义从「行配置」搬到 `storageDomain`
（`~/.dsh/storages/`，**跨 profile 共享**）——该插件已经用它存健康数据，
把 `groups` 一并搬过去即可。那需要改插件本身。

---

---

## 第 7 轮 · 按 pi 的源码对齐 UI

前几轮是「能用」，这轮开始是「像 pi」。

### 方法：读 pi 的真实组件源码，不靠猜

`pi-coding-agent/dist/modes/interactive/components/` 是**可读的编译产物**。
把三个组件的实现读出来照着对齐——而不是对着截图猜：

| pi 的组件 | 它的做法 | 我原来的 |
|---|---|---|
| `user-message.js` | `Box(1, 1, bg(userMessageBg))` + **Markdown** | `Box(1, 0)` + 纯 `Text` + 借用 `toolPendingBg` |
| `assistant-message.js` | 正文**不铺底色**（方便复制）；思考块 `thinkingText` + 斜体 | 自定义 `✻` 前缀 + `reasoningText` token |
| `tool-execution.js` | **整块有底色的框**，底色随状态变（pending/success/error） | 无底色的纯文本行 |

主题 token 命名改成 pi 的词汇（`userMessageBg` / `userMessageText` / `thinkingText`），
读两边代码时不用做心智翻译。

底栏加上 `think:<档位>` 段（与 pi 同位置同写法），模型只显示模型名。

### 顺带修掉一个潜伏 bug：活会话读事件的方式

底栏取不到真实路由，打日志才发现 `seq=19` 而 `events.length=0`。

**活会话上 `session.events` 是空的**，必须按序号用 `session.eventAt(seq)` 读——
依据是 dsh 自己 headless 的实现（`dsh-headless/lib/index.js` 里那句
"Iterate a live Session's durable events in order"）。

两处受影响，第二处更严重：

| 位置 | 影响 |
|---|---|
| `footer.js` 取真实路由 | `think:` 段永远不出现 |
| **`kernel.js` 的 resume replay** | **resume 看不到任何历史对话** |

新增 `src/session-events.js` 统一这个读取方式（含增量读，避免每帧 O(n)）。

**`--resume` 已端到端验证**：第一次会话发「记住一个词：蓝色」→ 退出 →
`dsh tui --resume <id>` → 屏幕上恢复了 `记住一个词` 与 `蓝色`（40 个事件，
4 条 user + 4 条 assistant）。这条路径此前从没测过。

### 再补一个高可用缺口：杂散输出防护

实测确认 **pi-tui 不拦截 `console` / `stdout`**。`model-channel-manager` 在 boot 时
就 `console.log` 了一行；会话期间任何插件这么干，那行会直接写进终端把画面搅乱。

`src/console-guard.js`：**只接管 `console.*`，绝不碰 `process.stdout.write`**
（后者是 pi-tui 的渲染通道）。杂散内容写进 `~/.dsh-tui/stray-console.log`，
界面只提示一次。

写这个时自己踩了一次 TDZ：`restoreConsole` 声明在使用它的 `teardown` 之后，
中间的错误路径（`createApp` 失败等）会撞上暂时性死区。改成提前 `let` 声明。

### 本轮结果

测试 235 → **257 个用例**全部通过。宽屏（120 列）开机画面与 pi 的截图结构一致：
banner → `[Context]`/`[Skills]`/`[Commands]`/`[Plugins]`/`[Theme]` → 底栏。

### 仍未对齐的（明确记录）

| 项 | 为什么没做 |
|---|---|
| OSC 133 shell 集成标记 | pi 用它做「跳到上一条命令」。收益小，且转义序列可能干扰宽度计算与虚拟化 |
| 「有更新可用」提示框 | 它服务的是 pi 的更新检查功能；本 TUI 没有该功能，加一个没人调用的渲染器就是死代码 |
| 底栏的 `⚙ <扩展名>` 段 | 机制已在（`registry.setStatus`），但没有插件往里写。dsh 侧没有对应物 |

### 工具调用链路的真机验证（本轮）

用 PTY 跑「用 bash 运行 echo hello-from-tool」，会话日志给出 ground truth：

```
turn/start → step/start → tool/call → tool/result → assistant/message → step/end → turn/end: completed
```

`tool/result` 内容里带着 `hello-from-tool`。**工具调用链路是通的。**

### 审批弹窗：试了但没触发，原因是机制本身

构造了一个「写工作区之外」的操作想逼出授权弹窗，结果**没有弹窗**。查会话日志：

```
permission/preset: workspace-write
sandbox/mode:      workspace-write
approval/policy:   ask          ← 策略确实是 ask
```

而那次 `/tmp/outside-workspace-probe.txt` 的写入**实际成功了**（`isError: false`，
文件确实存在）。模型在回复里说「越界拒绝，也不需要审批」——那是它在描述预期，
不是实际结果。

**结论**：`workspace-write` 模式下 `/tmp` 是允许的，不需要升级，所以不弹审批。
审批路径只在更窄的一组目标上触发（模型自己提到 `~` / `/etc` / `/root`）。

**没有继续验证下去**：要触发就得往那些路径写东西，那是拿用户的系统当试验场，
不该在没有明确要求时做。所以授权弹窗目前的状态是——**代码路径有单测覆盖
（认领 / 交回链上 / 已取消不弹窗 / 多问题中途取消），但没有真机端到端过**。

这一条明确记在这里，不假装验证过。

### 弹窗层的真机集成验证（本轮，补上最后一个缺口）

审批/提问弹窗此前只有 mock 单测——**最容易出问题的部分恰恰是 mock 覆盖不到的**：
overlay 会不会真画出来、按键能不能路由到内部的 SelectList。

用一个临时探针（`/tmp`，不入库）把真实的 `TUI` + `ProcessTerminal` + `createPrompter`
跑在 PTY 里：

```
PROBE: 弹出选择框…
PROBE: 弹窗返回: "allowed-once"     ← 期望 allowed-once
PROBE: 再弹一个文本输入框…
PROBE: 文本框返回: "探针"            ← 期望 探针
PROBE: 两个弹窗都正常结算，退出
```

屏幕上真实画出的内容：

```
允许执行 bash ？
→ 允许一次      只批准这一次调用
  拒绝          本次调用失败
你的名字？
```

**结论**：overlay 渲染、按键路由到 SelectList、Enter 选中、Promise 结算、
文本输入回填——全部真机通过。

至此「有没有应答者」这条链路的两端都验证过了：**弹窗层真机通过**，
**waterfall 处理器单测覆盖**（认领 / 交回链上 / 已取消不弹窗 / 多问题中途取消）。
唯一没走到的是「沙箱真的要求升级」那一刻——如上所述，那需要往 `~` / `/etc` 写东西。

### 审批回环的真机端到端验证 ✅（本轮，最后一个实质缺口关闭）

之前一直触发不了审批，因为在 `workspace-write` 下 `/tmp` 是允许的、不需要升级。
换了个**安全**的思路：不往 `~` / `/etc` 写东西，而是先把会话切到 `read-only`
沙箱——那时**任何写入都需要升级**。

真机结果（PTY + 会话日志）：

```
/permission read-only
  → current preset read-only (available: read-only, workspace-write, danger-full-access)

「在当前目录写一个文件 probe.txt，内容写 hi」
  → 写入被沙箱拒绝（Permission denied / read-only mode）
  → 升级触发

  允许执行 bash ？
  → 允许一次      只批准这一次调用
    拒绝          本次调用失败，模型会看到拒绝

  （回车选中「允许一次」）
  · 需要授权：bash → 已允许
```

**结论**：整条链路真机通过——
沙箱拒绝 → 升级 → waterfall 到达我的处理器 → 弹窗渲染 → 按键选择 →
Promise 结算回内核 → 通知行确认 → 模型继续。

这条路径两端现在是完整的：**弹窗层真机通过**（本轮前一条）+ **waterfall 处理器
单测覆盖** + **真机端到端触发通过**（本条）。

顺带验证到的还有：**斜杠命令系统端到端**——`/permission` 的补全描述符、
执行、以及它的输出被渲染成对话区的通知行，全部正确。

---

## 第 8 轮 · 模型运行时切换与会话预设（用户审计驱动）

**触发**：用户指出「dsh 本身有会话预设选择，tui 没有；tui 的 /model 无法选择已有渠道商」。

### 事实修正（先查证再动手）

| 旧认知 | 实查结论 |
|---|---|
| 会话预设 = profile | 预设是 agent-scoped capability composition（`agentPresets.mount`，setup 内挂载），profile 只是 bundling 单位 |
| `/model` 没有目录可用 | `llm.listProviders/listModels/resolveCallConfig` 就是目录；本轮全接上 |
| 需要自造模型切换机制 | `installModelSelection` 的 ref 本就是可变的；durable 事件 `model/selection` 在 dsh-session 内建词汇表里（KNOWN_SESSION_EVENT_TYPES），不依赖 session-controller |

### 实测抓到的三个真问题（全部修复）

1. **`ctx.loader.await()` 在 apply() 内死锁**：装载树在等本行激活，本行又在等装载树 → 进程静默挂起、TUI 永不渲染。改为有界轮询 `presetService.resolve()`。
2. **preset 行注册与本插件 apply() 竞态**：`Unknown agent preset: standard`。轮询方案顺带解决。
3. **preset 挂载校验缺依赖**：`tool-subagent` 的 `modelSelectionSettings: true` 要求宿主持有 `@deepseek-ai/dsh-tool-subagent/model-selection-settings` 行——官方 web patch 有，我们的组合漏了。补上后挂载通过。

### 验证记录（PTY）

- `/model` 无参 → 「选择渠道商」overlay 列出 65 个渠道（含 38 dormant）、逐渠道模型数。
- `/model roundrobin/round-glm-5-3f/deepseek-v4.1-flash` → 「已切换模型 · reasoning:max」，banner/footer 同步。虚拟 provider id 含斜杠 → 多候选拆分 + `resolveCallConfig` 裁决。
- `/preset` → standard/ptc/minimal/cordis 列表，当前项带 ✓。
- 277 测试全绿；`pnpm run audit` 三项门禁通过。

### 明确不做 / 已知边界

- `/preset` 不支持已有回合的会话（内核契约 `agent-preset/locked`；预设决定工具目录，热切会破坏日志一致性）。
- `resume` 恢复预设的优先级：projection → header → registry 默认；显式 `--preset` 只对新会话生效。
- 未接 `sessionController.selectModel`（需 Host controller 全家桶）；TUI 用「durable 事件 + 可变 ref」实现等价语义，durable 事件是内建词汇，重建行为一致。

---

## 第 9 轮 · UI 打磨（用户截图驱动）

**触发**：用户实机截图指出三点——弹窗位置不对、UI 配色差、渠道选择无搜索。

### 修了什么

| 问题 | 根因 | 修复 |
|---|---|---|
| 弹窗悬在屏幕中央，离输入框太远 | `anchor: 'center'` | 改 `bottom-center` + `offsetY: -3`，贴输入框上方 |
| 弹窗是一整块亮灰板 | frame 用 `selectedBg` 刷全部行 | 新增暗面板色 `panelBg (#161a29)`，标题用 accent 强调 |
| 无搜索 | 只用 SelectList 上下键 | 拦截层即输即搜：`fuzzyFilter` 子序列匹配 → 退化为子串；过滤行实时回显 |
| 底栏全灰 | 每段同色 | 对照 pi 逐段配色：模型白 / `think:` 黄 / `dir` 青 / `⎇ 分支` 紫 / 分隔线琥珀 `#c1843a` |

### 本轮实测抓到的两个真 bug（都静默失败型）

1. **过滤永远不生效**：`applyFilter()` 每次新建 SelectList 实例，但挂在外框里的是旧实例——输入被吃掉、界面纹丝不动。修法：实例只建一次，过滤时原地更新 `items/filteredItems/selectedIndex`（SelectList 的公开字段）。
2. **弹窗无声消失**：过滤行闭包组件引用了 `createPrompter` 闭包里的 `theme`，但 `searchableList` 在模块层定义——`ReferenceError: theme is not defined` 被 `forwarding` 的 onError 静默吞掉后 `finish(undefined)` 关窗。修法：theme 作参数传入；onError 加 `DSH_TUI_DEBUG_PROMPT=1` 诊断输出。

**教训（第 5 轮的回响）**：「没有任何报错」≠「没出错」。onError 静默结算是 P0 模式——它把异常变成 UI 的诡异行为。

### 验证记录（PTY，全部真实按键）

- 输入 `round` → 65 项实时过滤为 9 个 roundrobin 组。
- 全流程：搜索 `round-glm-5-3f` → Enter → 选模型 → Enter → 选强度 `off` →
  `已切换模型：roundrobin/round-glm-5-3f/round-glm-5-3f`，banner/footer 即时更新。
- 277 测试全绿（footer 断言改为剥 ANSI 后匹配多色段）。
