# OpenBot 插件

## 搜索

网页搜索、网页阅读和以图搜图，分别配置服务，由 Bot 按任务选择工具。网页支持 AnySearch、Tavily、Exa、Brave，图片搜索支持 Google Cloud Vision。

[安装与配置](plugins/search/README.md)。

## 梗百科

查询网络梗、缩写和自定义黑话，提供本地 6668 条词库、图片卡片、自动查词和增量更新。

原作者：[in1t1a1](https://github.com/in1t1a1/astrbot_plugin_memewiki)。[安装与使用](plugins/memewiki/README.md)，[下载 0.1.0](https://github.com/wdmywm3/openbot-plugins/releases/tag/memewiki-v0.1.0)。需要支持 50 MiB 插件包和新版市场目录的 OpenBot。

## B站小管家

根据兴趣浏览 B 站，阅读视频、保存笔记，并把适合当前聊天的内容分享给群友。支持扫描收藏夹、生成分类方案，预览后再整理收藏。

可分别管理大号和小号，按需启用点赞、收藏、评论、回复和私信。视频阅读可配合 Watch，结合字幕和画面继续分析或回答追问。

## bPhone

让 Bot 使用已绑定的安卓手机或模拟器，查资料、浏览内容、使用应用、玩游戏，或完成主人交办的任务。可以查看活动进度，并继续上次中断的任务。

按需使用与闲时自行活动分别设置，可选择允许使用的应用、兴趣方向和活动频率。一个实例可以绑定多台设备。

## Watch 视频阅读

阅读聊天视频附件、HTTP/HTTPS 视频直链、yt-dlp 支持的平台页面与配置目录内的本地视频，总结内容、梳理教程步骤，并按时间点回答问题。平台页面优先通过内置浏览器在线取帧、读取字幕并按需采集片段音频。画面通过图片交给模型，不要求原生视频输入；有字幕时优先读取原语言字幕，无字幕时可配置语音转写。

默认优先获取1080p画面，通过编号分镜图和对应字幕了解内容，再按分镜编号或时间点高清补看。自动采样会按画面变化与字幕密度分配，并选择清晰帧；代码、小字或按钮仍可从原视频裁剪核对。

分镜设计与部分算法参考或改编自 [SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)，感谢原作者以 MIT 许可开源。详情见 [Watch 鸣谢与许可](plugins/watch/THIRD_PARTY_NOTICES.md)。

## 内容监控

订阅 B 站 UP 主和 RSS／Atom 订阅源，定时检查新内容并推送到指定群聊或私聊。支持多个订阅和自定义推送模板，也可以随时查看监控状态或立即检查。

## 骰娘

群聊跑团工具，支持通用掷骰、暗骰、CoC 7 版检定与对抗检定。可管理角色卡，进行理智、技能成长和 D20 优势／劣势检定，抽取疯狂症状并查看掷骰统计。

使用 `/dicehelp` 查看命令和骰式示例。

## 每日签到

按群聊或私聊记录每日签到、连续天数和积分，提供当前聊天的积分排行。可设置签到积分范围、时区和排行榜人数。

使用 `/checkin` 签到，使用 `/checkinrank` 查看排行。

## 群聊总结

总结当前群聊的近期消息，整理主要话题、结论和待办。可以直接使用 `/groupsummary`，也可以指定关注点，例如 `/groupsummary 今天讨论的活动安排`。

## 随机工具箱

提供抛硬币、生成范围内的随机整数、从多个选项中抽取一个，以及随机抽取群成员等功能，适合日常选择、抽签和群聊互动。

## 表情素材库

管理导入、聊天收集或 QQ 收藏的素材，按角色与聊天选择可用表情。固定用法与版本化可用状态分开，冷却状态带截止时间，发送前重新检查可用性；QQ 收藏同步仅用于支持该接口的实例。

## 记忆 Plus

正文保存在宿主统一记忆中，插件负责自动召回、整理和复查。定时整理与索引维护分开；整理按固定来源上界分批继续，暂停后可恢复。相同候选合并证据，平台通知和任务报告保留各自含义。私聊事项可明确设置单次、周期或有新证据时复查，无新进展保持安静。

记忆 Plus 2.1.2 和表情插件 2.2.1 需要 OpenBot 0.1.84 或更新版本；安装前检查所需功能，旧宿主应更新后再启用。B站小管家 1.15.0 与 bPhone 2.4.0 也已接入统一记忆，建议配套更新宿主。

## 开发验证与候选包

测试使用 Node.js 24。独立检出插件仓库后，先运行 `npm ci --prefix plugins/memory --ignore-scripts` 和 `npm ci --prefix plugins/meme-library --ignore-scripts` 安装锁定依赖，再运行 `npm test`。这个入口不读取 OpenBot 源码，包含记忆策略的独立测试和表情图片引擎测试；GitHub Actions 使用同样的环境执行。

`npm run test:integration` 执行全部七个记忆宿主测试、表情／词库／搜索／视频宿主测试、配置页面和 Python 集成；`npm run test:all` 执行独立测试和完整集成。开发时用 `OPENBOT_HOST_ROOT` 指定宿主源码，`WATCH_TEST_PYTHON` 与 `MEMEWIKI_TEST_PYTHON` 指定测试环境；默认使用本仓库已有的 `.venv-watch-full` 和 `.venv-verify`。集成环境或依赖缺失会明确失败，不静默略过。`npm run test:memory` 保留为七个记忆宿主测试的单独入口，CI 的独立记忆入口为 `npm run test:memory:unit`。

`npm run prepare:candidates -- <新目录>` 为当前工作区生成 12 个本地安装目录、ZIP 和内容摘要，`npm run prepare:candidates -- <目录> --verify` 重验。它们是未发布候选；正式发布仍用真实提交运行 `npm run catalog -- <提交SHA>`，不可用工作区摘要伪造远端提交。
