# 进度记录

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
