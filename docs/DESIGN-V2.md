# 第二轮：欢迎页、对话身份与会话恢复

## 反馈与设计调整

第一版保存在本地提交 `f8ce820`。这一轮直接回应用户反馈：删除“写下你要做的事”、丰富首次进入画面、明确用户与模型的区分、增加 `/resume`，并修复 Ctrl+T。

欢迎页恢复原来的鲸鱼，配合蓝色与暖色边框。宽终端中左边是标识，右边是会话恢复、模型和文件入口，底部呈现模型、预设与目录。开始对话后收成简洁标题，避免持续占据阅读空间。输入区只保留边界、`❯` 和用户的文字。

用户消息使用 `❯ 你` 与深色背景，助手使用 `● DeepSeek` 和无底色正文。角色、形状和背景同时区分双方，不仅依赖颜色。工具保留紧凑纵向分组与完整详情入口。

## Claude Code 参考依据

查阅日期：2026-09-30 至 2026-10-01。Tavily 搜索遇到账号额度限制，改为直接读取官方页面。

- [Interactive mode](https://code.claude.com/docs/en/interactive-mode)：快捷键、详细 transcript、保持输入状态的交互原则。
- [Manage sessions](https://code.claude.com/docs/en/sessions)：会话内 `/resume`、会话选择器、目录范围与恢复历史。
- [Common workflows](https://code.claude.com/docs/en/common-workflows#resume-previous-conversations)：通过 CLI 参数或运行中的会话恢复工作。

视觉布局结合 Claude Code 的启动面板与本项目原有鲸鱼，不复制 Claude 品牌。保留本项目的 Ctrl+T 思考切换；Claude Code 当前文档把 Ctrl+T 用作任务清单，本项目不将这两个功能混淆。

## Ctrl+T 根因与修复

pi-tui 的应用级 input listener 比 focused component 的释放事件过滤先执行。Kitty 协议按下 `CSI 116;5u`、重复 `CSI 116;5:2u`、松开 `CSI 116;5:3u` 都会被 `matchesKey(Ctrl+T)` 匹配。原先按下展开、松开又折叠，看起来像需要一直按住。

现在应用层忽略释放事件，切换快捷键也忽略重复事件。测试覆盖按下、重复、松开、第二次按下及传统 Ctrl+T 字节。传统终端不提供重复/松开标记，因此只能按收到的独立 Ctrl+T 字节切换，不用时间猜测用户输入。

## 会话恢复契约

`/resume` 从 DSH 的 `sessionQuery.listSessions()` 读取持久会话，使用批量标题读取。默认当前工作区，可切换所有工作区，支持搜索标题、ID 和路径。子 Agent 与已驻留会话不作为主会话候选。

切换顺序：检查当前任务与队列 → 准备目标 kernel → 严格保存当前会话 → 切换投影和界面绑定 → 释放旧 kernel。准备或保存失败时保留旧会话。切换期间提交的草稿保留在编辑器。

恢复后模型与预设取自目标会话；命令、上下文、原生文件补全跟随新 Agent。底栏重新绑定事件读取器、用量和工作目录缓存，避免相同 seq 的两个会话复用旧数据。

## 验证材料

- [第二版实际组件预览](benchmark-v2/index.html)
- [性能与宽度原始数据](benchmark-v2/metrics.json)
- `test/revision-two.test.mjs`：按键、角色、输入区、目录、恢复顺序与失败保留测试。
- 第一版预览保留在 `benchmark-v1/`；第二版以 `f8ce820` 为比较基线。

预览使用固定虚构会话。真实恢复验证使用隔离 DSH_HOME 和不存在的模型渠道，产生本地可回放历史，不发送外部模型请求。

实际 PTY 验证：创建带用户文字的会话并退出 → 新建会话 → `/resume` 显示持久标题 → 选择后历史文字重新出现，模型路由与约 5.9k 上下文用量恢复。不存在的会话 ID 会报错并保留当前会话。
