# @arcaneorion/dsh-tui

一个从零写的 **DeepSeek Harness 终端前门**。

渲染地基是 [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)（MIT，与 pi agent 零耦合的通用终端 UI 库），内核是 dsh 自身的 `ctx.agents` / 会话事件 / 审批与提问服务。

## 设计主张

**每个界面区域都是一个「可整体替换的单一实现点」，不是写死的常量。**

这条是它存在的理由。想给所有消息加外框、想把底部输入框固定在屏幕下方、想换掉整个状态栏——都应该是注册一个实现，而不是去 patch 组件原型。

```js
registry.setMessageRenderer('assistant', ({ row, theme }) => myFramedComponent(row, theme))
registry.setFooter(myStatusBar)
registry.setEditor((tui, theme) => myVimEditor(tui, theme))
```

对比两种做法的代价：

| | 写死 / patch 原型 | 本项目的注册表 |
|---|---|---|
| 给所有消息加外框 | 包裹 8 个组件的 `render`，配一大堆 fail-closed 回滚 | `setMessageRenderer('*', …)` 一行 |
| 换输入框 | 依赖内部导出，版本一升就崩 | `setEditor(factory)` |
| 卸载恢复 | 手工还原原型 | disposer 自动还原 |

## 分层

```
src/kernel.js       内核桥：建/恢复 agent、订阅事件、中断、flush   ← 唯一碰 @deepseek-ai/*
src/projection.js   投影：dsh 事件 → 视图模型（行）
src/registry.js     实现点：7 个可替换区域 + 消息渲染器注册表
src/messages.js     默认消息渲染器（注册式，非写死）
src/app.js          pi-tui 外壳：组装、输入、动画、退出还原
src/theme.js        颜色 token 表 → pi-tui 三套 theme 形状
src/host.js         启动身份判定（非 TTY 静默降级）
src/startup.js      命令行 → dshTuiStartup 服务
src/index.js        入口：判定 → 装配 → 退出路径
```

**内核边界**：只有 `kernel.js` 与 `startup.js` 允许 import `@deepseek-ai/*`。dsh 还在 `0.x`，升级时改动只落在这两个文件里。

## 三条投影铁律

1. **回放与实时走同一条路**——`applySessionEvent` 同时服务两者，所以 resume / rewind 看到的一定和实时一致。
2. **过程态与提交态分开**——`agent/assistant-stream` 的帧只用于渲染正在生成的文本；一旦 `assistant/message` 提交，就丢弃流式缓冲、以提交态为准。流式事件永远不是真相。
3. **未知事件类型静默忽略**——第三方插件追加的事件不能让界面停止更新。

## 滚动模型

pi-tui 只把「底部一个屏高」维持为活视口，其余行推进终端原生 scrollback。所以历史滚动、选择、复制、搜索**全部由终端原生提供**，本项目不需要写虚拟列表。

## 开发

```sh
pnpm install     # pi-tui + 内核包（devDependencies，供 link: 安装时解析）
pnpm test        # 76 个用例，全部无需 TTY
pnpm check       # 语法检查
```

测试全部**无需 TTY**：pi-tui 的组件是 `render(width) → string[]` 的纯函数，所以宽度约束、缓存、错误边界、实现点可替换性都能钉死。真实终端里的观感仍需人验。

### 为什么内核包是 devDependencies

`kernel.js` 直接 `import '@deepseek-ai/dsh-agent'` 等。这些包**也是** peerDependencies（声明运行时契约）——但只写 peer 会踩一个坑：

profile 用 `link:` 安装本插件时，`node_modules/@arcaneorion/dsh-tui` 是软链，Node 会把它解析成**真实路径**，模块解析因此从插件源码目录往上走，**走不到 `~/.dsh/profiles/node_modules/` 那个共享仓库**，于是 `ERR_MODULE_NOT_FOUND`。

把同样的版本同时写进 devDependencies，`pnpm install` 就会把它们装进本目录，`link:` 安装也能解析。

## 状态

**已可运行**：profile `tui` 已建立，`dsh --profile tui --dump-config` 组合通过，`dsh tui` 在非 TTY 下会给出明确诊断（0 条 `failed to import` / `pending`）。

**尚未验证**：真实交互式终端里的表现（挂载、打字、流式、退出还原）。这一步需要人来跑：

```sh
dsh tui
```
