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
