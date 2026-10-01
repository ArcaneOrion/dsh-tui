# 进度记录

## 第十轮

- 用户反馈开机时终端上方会留两行插件日志（`[model-channel-manager] booted …`、`[tavily-web] registered …`），不好看；并问能否像 pi 一样在 TUI 里显示加载内容。
- 求证：两行都是 **`console.log`**，来自用户自己的两个插件（model-channel-manager / tavily-web），且发生在 **dsh-tui 挂载之前**——那时 console 防护还没装上，所以直落终端；console 防护只覆盖安装之后的调用。
- 另一个发现：pi 式开机面板（`startup-info.js` 的 `collectStartupSections`：`[Context]/[Skills]/[Commands]/[Plugins]/[Theme]`）**代码与测试都在，却从没在 index.js 里接上**——用户看不到「加载了什么」正是这个原因。
- 改动：①`app.start()` 先清屏再接管（pi-tui 首帧本就假定屏幕干净）；②把开机面板接上，在全新会话里紧随欢迎页写一行 `role: info`（失败则整块不出现）。
- 验证（真机 tmux）：只发 `2J` 时可见屏 0 处日志，但 `capture-pane -S -`（历史+屏）里仍有 2 行——它们退到 scrollback，往上滚照样看得见（上一轮只查可见屏，误判成「已清掉」）。改为 `\x1b[2J\x1b[3J\x1b[H`（清屏 + 清 scrollback + 回原点）后，可见屏与历史双双 0 行。代价：启动时也会抹掉终端里更早的输出（shell 提示符等），要保留可退回只清屏。
- 验证（真机 tmux）：面板分节 `[Context]/[Commands]/[Plugins]/[Theme]` 出现，`[Plugins]` 列出本次实际加载的行（含 model-channel-manager、tavily-web、四个 preset、cordis 宿主行等）。337 测试通过（+1：start() 必须先清屏，断言 2J+3J+H）。
- 遗留选项（已告知用户）：想让那两行**显示在 TUI 里**而不是隐藏，需要 console 防护更早安装——即把 `@arcaneorion/dsh-tui` 挪到 bundles 列表更前面，或让这两个插件改用带开关的日志。

## 第九轮（意图纠偏）

- 用户指出三处我理解偏了：①状态行色块要**回到上一版**（提饱和那版太扎眼）；②他说的「色块」是**输入栏本身**，不是状态行；③权限应当**在状态栏下面持久显示**，而我做成了临时 notice——「之前没对齐意图你就开工了」。
- ①色板回退到 `#2f6fbf/#2f9e4f/#1f7f8f/#9a6a1f/#a83a45/#44566e/#5a6672` + 浅字 `#eaf2fb`（pi 主题同步）。
- ②输入栏先做了整块底色（新增 `editorBg`），用户看实机截图后判定「色块很奇怪」——三行高的深色大板压在壁纸上像贴胶布，边框线反而看不见。改为**去掉色块、只留上下两道线条**，并把线条从通用 `border`（`#2a3a52`，几乎看不见）换成更实的 `editorBorder`（`#6b9bd8`）。四档强度对照图给用户选，取中间偏亮那档。
- ③权限行持久化：`createFooterInfo` 增加 `permission`（预设名 + 沙箱 + 审批，按会话 seq 缓存，避免每帧折叠事件）；`DefaultFooter` 在状态行下面多渲染一行 `⏸ 权限 <预设>（Shift+Tab 循环）`，危险档转 `⚠` + warning 色；切换成功不再插 notice（那行本身就是回执）。
- 验证方法上踩了坑并纠正：tmux 的 `capture-pane` 显示输入块只有几个字符宽，我据此怀疑过 padding 算法；实测 app 写出的三行都是 80 列且带底色，最后用 **xterm.js headless（参考实现）** 仲裁——三行 `bg=2240585`（=#223049）在第 0/2/40/79 列全都有，确认是 tmux 的渲染/捕获差异，不是代码问题。这条经验记下来：终端渲染问题优先用 xterm.js headless 复核，别只信 tmux。
- 336 项测试通过（+3：输入栏整块底色、持久权限行、权限读取缓存）；check / audit 通过；预览存档 `docs/bottom-area.png`。

## 第八轮

- 用户反馈两件事：①状态行色块再明显一些；②「似乎没有权限管理」，想要 Claude Code 那样 Shift+Tab 控权限。
- 权限管理先求证：`sandboxPolicy` 只有读方法（`resolve`/`overrideOf`），模式来自会话日志的 `sandbox/mode` 事件；真正管切换的是 `@deepseek-ai/dsh-permission-presets` 的 `ctx.permissionPresets`（`catalog()` / `current(session)` / `set(session,name)` / `resolve(name)`），预设 = 沙箱模式 + 审批策略的组合。**dsh-base 本来就挂了这一行**（三档预设与官方 web 一致）——服务一直在，缺的只是 TUI 入口。我一开始在 bundle 里又加了一行，发现是重复 id 后撤掉。
- 实现：Shift+Tab 循环权限预设（`\x1b[Z`、kitty CSI-u、modifyOtherKeys 三种序列 pi-tui 都认）、`/permission` 选择器、`/permission <name>` 直切；`kernel.runtime.permission` 提供 available/catalog/current/resolve/set/cycle，服务缺失时入口隐藏而不是报错。切换写的是会话事件，底栏权限段与后续工具调用自动跟随。
- 色块更明显：段色板提饱和（蓝 `#2563eb`、绿 `#1f9d55`、红 `#dc2626`、青 `#0d7f8f`、琥珀 `#b45309`、灰 `#64748b`、浅字 `#f1f5f9`），pi 主题同步。
- 验证（真机 tmux）：Shift+Tab 依次 `workspace-write → danger-full-access → read-only → workspace-write` 环绕，底栏权限段与通知同步；`/permission` 选择器三档带 ✓；140 列底栏含 CPU/MEM/时间。333 项测试通过（+2：权限访问器与环绕、Shift+Tab 绑定）；check / audit 通过。

## 第七轮

- 用户给出 Claude Code 状态行截图，要求「输入栏下面的 UI 仿照它」。**先把图真正读进来**（用图片工具读附件，而不是凭印象），确认设计要素：一行**连续色块**、每段饱和底色 + 浅色文字、段间无缝、每段左右各一空格内边距、**末段铺满整行**；段内容为 路径 · 分支 · CPU · MEM · 时间。
- 底栏重写为色块状态行（`DefaultFooter`）：单行，段顺序 模型 · think · 用量 · 沙箱 · 路径 · 分支 · 状态提示 · CPU · MEM · 时间；主题新增段色板（`segText/segBlue/segTeal/segGreen/segAmber/segRed/segSlate/segGray`，蓝与 pi 两套）。取数层新增 `path`（`~` 缩写）、`cpu`（loadavg/ncpu）、`mem`、`clock`（`MM/DD 周X HH:MM`），每秒最多采一次。
- 分配算法经三轮实测修正：①窄屏时末段若是告警色（yolo 红）会把整行拖成一条红条 → 填充改用中性色；②按优先级丢弃时未截断的路径段挡住"放得下"判断，把用量段挤掉 → 改为「只丢比路径更不重要的段」；③丢弃顺序改为 会话号 → 时间 → 内存 → CPU → think → 状态提示 → 分支，用量/权限/模型永不为路径让位。
- 验证：331 测试通过（底栏相关 +4 改写/新增）；真机 tmux 140 列底栏为 `round-modelacope-model | think:max | 0/1.0M (0.0%) | workspace-write | ~/AI/AI-DSH/plugin/DSH-TUI | ⎇ main | CPU23% | MEM65% | 10/01 周四 17:54`，六种段底色与浅色前景均出现在原始流里；120/96/60 列三种宽度的渲染预览（HTML→Chromium 截图）存档为 `docs/footer-statusline.png`。

## 第六轮

- 用户报告 `/resume`「有反应，就是有点久」。**先量再改**：tmux 实测选择器出现耗时冷 1065ms / 热 860ms；加 `DSH_TUI_DEBUG_SESSIONS=1` 探针（写临时文件，不污染 TUI）得到分解——`listSessions()` 扫全库 563 个会话 ~250ms，`readTitleSnapshots()` 为 45 个候选逐个加载完整事件日志折叠标题 ~620ms。
- 顺带查清列表显示裸 session id 的原因：那些会话日志里没有 `session/title` 事件（`foldSessionTitle` 返回 undefined），不是代码 bug；同时确认 `readTitleSnapshots` 的 `value.title` 是**快照对象**（含 title/updatedAt），内核的 `titleMap.get(id)?.title` 读法正确。
- 修复三处：①读取期间用 `registry.setStatus` 在底栏显示「正在读取会话目录…」，结束即撤（不再有 0.9s 的"死屏"）；②会话列表加 20s 短 TTL 缓存（键含 cwd 与 all），重复打开实测 **66ms**；③消掉静默路径——`resumeSession` 返回 false（例如选了当前会话）时原来什么都不显示，现在回执「已是当前会话，无需恢复」，恢复过程中底栏显示「正在恢复会话…」。
- 328 项测试通过（+3：状态挂/撤、静默回执、缓存命中与键分离）；check / audit 通过。

## 第五轮

- 用户报告：输入之后欢迎页（鲸鱼）消失，往上滚也找不回来。**先取证再改**——读 pi-tui 渲染管线：内容**增长**走 append 路径（`"\r\n".repeat(scroll)` → 终端真滚动 → 顶部行进 scrollback）；组件被**原地改写/移除**走 `\x1b[2K` 擦行重写（不进历史）；改动落在视口之上（`firstChanged < prevViewportTop`）才 fullRender。
- 用 tmux（`nix shell nixpkgs#tmux`）+ `capture-pane -S -` 复现：折叠前历史缓冲鲸鱼 1 行，推入一条 notice 行触发折叠后 **0 行**——被原地擦除，从未进 scrollback。（我此前口头说的「往上滚还在」是错的，已纠正。）
- 根因：欢迎页放在 header 槽，且 `hasConversation()` 一为真就折叠成两行——12 行 → 3 行的「行数变少 + 首行改动」正好命中擦除/差分重写路径。
- 修复：欢迎页改成**流内容**——`banner.js` 抽出纯函数 `renderWelcomeBox()` 与 `welcomeRow()`（动态字段一次性快照，滚进历史后不再变，避免 fullRender）；`index.js` 注册 `welcome` 行渲染器，只在全新空会话把这一行放进 `view.rows[0]`，不再 `setHeader`。`createBanner` 保留为 header 适配器（演示脚本与第三方用）。
- 验证（tmux，全程无模型请求）：推入一行后鲸鱼 1→1（不再被擦）；内容涨到 66 行时可见屏 0 命中、`-S -` 历史 1 命中——鲸鱼完整躺在 scrollback 里。
- 325 项测试通过（+1：欢迎页是快照式流内容行）；check / audit 通过。

## 第四轮

- 用户反馈：配色还是蓝色为主，或提供 `/theme` 选择。两者都做：**默认改回蓝色（Tokyo Night 风味，深蓝底 + 蓝 accent）**，并加 `/theme` 多主题热切换。
- theme.js 从单张 token 表改成**注册表 + 热切**：`createTheme()` 返回的对象持有可替换的 `current` token 表，`fg/bg` 每次调用都读它，因此 markdown/editor/selectList（闭包同一组 fg）也自动跟随。`/theme` 切换只需 `setTokens` + 清各级缓存（chat 的帧缓存与行缓存、working、footer、右栏），不用重建组件、不改签名。
- markdown 映射改用语义 token（link/bullet/codeFg/codeBorder）——每套主题给各自的值：蓝主题链接是蓝、pi 主题是 cyan，映射里不写死色相。
- `/theme` 命令：弹选择器或 `/theme <id>` 直切，选择写入 `~/.dsh-tui/config.json`（prefs 新增 `theme` 字段，非法值丢弃），下次启动恢复。
- 324 项测试通过（+8：热切/注册表/prefs 往返/app.setTheme/换主题后重绘用新 token）。实机 PTY 验证：无 prefs 启动 34 处蓝 accent、pi accent 0 处；`/theme pi` 后活视口用 pi token 重绘（pi muted/border/dim/accent 均出现）且落盘 `{"theme":"pi"}`。

## 第三轮

- 用户反馈：去掉「❯ 你」这类文字角色标签（幼稚），用户输入 / 思考 / 工具调用改用**图层**区分；视觉对齐本机 pi（输入框、布局、配色），参考 `@earendil-works/pi-coding-agent` dist 与用户调的 `~/.pi/agent/themes/pi-theme.json`；文件编辑参考 Claude Code 在右侧划区域显示 diff。
- 色板逐值取自 pi-theme.json（墨蓝底 + 暖黄 accent + cyan/cream）。用户消息 = 纯 `userMessageBg` 底色块、零标签（pi `UserMessageComponent`）；助手正文无底色无 `● DeepSeek` 行；思考 = thinkingText 斜体块；工具卡 = pi `ToolExecutionComponent` 三态底色块（pending/success/error），不再有「运行中/完成」文字。输入框去掉 `❯` 提示符，回归 pi-tui Editor 原生单线框。
- 文件编辑右栏（`src/edit-pane.js`）：用 pi-tui 的 **nonCapturing overlay** 实现——只合成活视口，scrollback 保持干净（与 Claude Code 一致）；左列窄化渲染、右栏按 36% 宽度合成、`<96` 列自动收起。窗口聚焦最后一次改动的行。`/pane auto|on|off` 控制；Edit/Write 运行时出现、回合结束保留最后状态。左栏工具卡不再复述 diff 全文，只给 `+N −M` 摘要。
- preset 创造模式：对齐 Web 表面——`/preset` 选择器在 roster 带 cordis 时提供「✦ 创造模式」入口，`/preset create` 切空白会话到 cordis 预设并预填引导输入（Agent 在 cordis 预设里自带 tool-cordis + plugin-manager，起草 bundle 后安装）。
- **修了一个潜伏 bug**：tui profile 的 cordis 预设一直 broken（`tool-cordis: waiting for cordisInspect`）——dsh-tui bundle 带了 cordis 预设却没带它依赖的宿主服务。主 patch 补两行 `cordis-host-runner` + `cordis-inspect-providers`（与官方 web 表面同构），cordis 预设与创造模式才真正可用。
- tavily-web：用户指出 TUI 没法用 tavily（只在 web profile 装过）。`dsh plugin --profile tui add @arcaneorion/dsh-tavily-web` 装进 tui profile；实机 `/tools` 显示 26→27 个工具、`[tavily-web] registered tavily_search / web_fetch (key pool: 8 ref(s))`。
- 316 项测试通过（原 304 + 右栏 12）；check / audit 通过。真实 PTY 验证：`❯ 你`/`● DeepSeek` 已消失、tavily_search 已注册、`/preset cordis` 切换成功、`/pane on` 右栏渲染、双 Ctrl+C 干净退出。本轮无模型计费请求。

## 第二轮

- 第一版已提交 f8ce820。
- 查阅 Claude Code 官方 interactive-mode、common-workflows、sessions；Tavily 额度不足改为直接读取官方文档。
- Ctrl+T 根因确认：应用监听先于底层 release 过滤；现忽略 release 与 toggle repeat，并覆盖按下/长按/松开/再次按下测试。
- 恢复鲸鱼欢迎页、蓝色强调和暖色边框；用户底色 + ❯，助手 ● DeepSeek；输入区仅保留提示符和边界。
- /resume 使用持久目录与标题，支持当前/所有工作区搜索；候选恢复成功且旧会话保存后才切换，刷新底栏和文件补全绑定。
- 304 项测试通过。正在验证真实持久会话切换。
- 真实持久会话恢复已成功：列表显示标题，选择后用户历史、模型路由和 5.9k 用量恢复；无效 ID 失败后旧会话仍可用。
- 最终 npm test 304 项通过，check / audit / diff --check 通过；验证进程已正常退出。
- 第二轮预览与截图保存在 docs/benchmark-v2，说明与官方参考在 docs/DESIGN-V2.md。第二轮作为独立本地提交保存。

## 开始

- 已读取 frontend-design 与 planning-with-files 技能。
- 用户授权主设计师决定第一版；交付后再根据偏好调整。
- 已建立设计方向、阶段计划与首轮审查基线。

## 视觉基础与交互基础

- 新增字符网格布局辅助函数、工作台编辑器和可滚动全文面板。
- 换为青绿强调与低饱和暖色状态，缩小 banner；用户消息与工具结果使用纵向引导线。
- 底栏按优先级保留上下文用量与权限，模型名称和路径按窗口宽度退让。
- 修正行缓存失效路径、底栏宽度/分支缓存及模型窗口失效。
- registry 改为具备所有权的注册栈，支持乱序卸载；思考全文加入显示状态。
- 多字符搜索输入、弹窗优先处理 Esc、每个弹窗支持独立 AbortSignal。

## 原生能力连接

- kernel.runtime 读取 deriveMessages、requestHeader.tools、inbox 与子 Agent 目录。
- /inject 与 /steer 调用原生 Agent.inject / Agent.steer；输入队列可撤回。
- @ 路径使用原生 scoped fileReferences，支持引号和目录；缺服务时降级旧补全。
- 新增 /workbench、/context、/tools、/inspect、/agents、/queue、/thinking。
- 首轮回归发现 5 个失败断言：4 个绑定旧配色/banner，1 个要求新模型沿用旧 effort；更新到语义契约。
- 两次大补丁因旧文本不匹配未应用；改为小块精确补丁。

## 交付验证

- 296 项测试通过，0 失败，0 跳过（逐文件执行，避免受沙箱 Node 子进程行为影响）。
- npm run check、npm run audit、git diff --check 通过。
- pnpm 离线 lockfile-only 检查完成；无需下载新依赖。
- 真实 DSH 隔离 profile：已验证 26 工具目录、inject 无唤醒、队列查看/撤回、Agent 空目录与正常退出。
- 设计 HTML 已由实际组件导出，并由 Chromium 截图检查。
- 文档已改为第一版真实行为；AUDIT 中保留历史记录并标明本轮修正。
- 最终版截图保存为 docs/benchmark-v1/preview.png；对照页优先展示第一版，基线保留在同页。
- 真实 DSH 与演示 PTY 均已正常退出；改动保持在工作区，未提交或发布。
