# OpenBot Plugins

OpenBot 的独立插件仓库。插件列表由 `catalog.json` 提供，下载固定到 Git 提交，并逐文件校验 SHA-256。插件在 OpenBot 数据目录中安装，可以离线运行；配置与探索状态由各实例保存。

## 安装

在支持 GitHub 插件目录和后台 `runAgent` 的 OpenBot 中打开：实例配置 → 插件 → 插件市场。安装后添加到当前实例，设置配置并保存。权限或版本变化后，需要在实例中应用新版。

| 插件 | 功能 |
| --- | --- |
| `bilibili-explorer` | 按兴趣搜索、阅读、筛选视频，主动分享到绑定的 QQ 会话 |
| `content-monitor` | B 站 UP、直播及 RSS 内容监控 |
| `dice-maiden` | 骰娘、检定与角色卡 |
| `daily-checkin` | 签到 |
| `random-toolbox` | 随机工具 |
| `meme-library` | 表情素材 |
| `group-digest` | 群聊总结 |

## B站主动探索

填写目标会话（例如 `onebot:group:123456`）和兴趣；会话应已经出现在该实例的 QQ 聊天列表中。默认每小时探索，23:00–08:00 免打扰，每天最多推荐三次。角色需要启用联网搜索和网页读取。没有目标和兴趣时不会启动探索，也不会发消息。

默认使用 OpenBot 已有搜索工具。也可把“探索工具”改为角色已授权的 B 站 MCP 完整工具名称数组，选择搜索、视频信息、字幕等读取工具。插件不会安装 MCP 或保存 B 站 Cookie。任务沿用目标会话的模型与角色，每轮有工具次数和时间上限。

命令：`/explore` 立即探索，`/explorestatus` 查看状态，`/explorelike 主题`、`/exploreavoid 主题` 记录反馈；这些命令只允许实例主人使用。立即探索仍遵守免打扰、分享额度和去重。

探索结果可以为空。只有标题和简介时会要求模型说明阅读范围；候选链接必须出现在工具结果中才允许分享。推送前持久化候选，发送结果不明时不自动重发。重启后继续按已保存的时间运行，不补发积压任务。插件通过 QQ @ 提醒指定用户，不在 B 站评论或私信。

## 开发与发布

插件入口为单个 JS 文件，导出 `handle(ctx)` 或 `poll(ctx)`，通过 `ctx.api` 使用宿主能力，不直接运行 Node/Python。`plugin.json` 声明权限、命令和配置。

`ctx.api.runAgent({chatId, prompt, tools, maxToolCalls, timeoutMs})` 返回 `{text, toolCalls, observedUrls, usage}`，不会自动投递。`observedUrls` 是本轮工具返回的链接。宿主检查实例、会话、角色工具权限及插件启用状态。插件可用 `getState/setState` 保存实例状态，用 `push` 投递。按会话变化的数据应把会话 ID 纳入状态键；跨实例共享状态需要额外的 `state:global` 权限。

运行 `npm test`。修改插件时提升其版本，先提交插件文件，再运行 `npm run catalog` 生成指向该提交的目录，提交目录并推送。不要在目录里填分支名或未经校验的下载地址。插件代码的版本和权限变更都应在发布说明中写清。

现有六个插件从 OpenBot 项目迁移；主动探索为原生实现。实机模型与 QQ 推送验收仍需使用你自己的测试实例。
