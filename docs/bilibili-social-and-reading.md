# B站阅读与互动

当前工作区版本为 1.14.0，媒体调用迁到通用 MCP 接口，参数、时间戳、帧和备份结果由本插件校验；已有绑定和旧宿主调用保留兼容。1.13.0 增加的收藏夹搜索、精简编号核对、可撤销排序和持久请求暂停，见[收藏夹查询、排序与请求暂停](bilibili-favorites.md)。1.11.0 起活动轨迹迁入独立 SQLite，列表先取摘要、详情按需读取。1.10.0 增加了投币、一键三连和带图评论；1.9.0 起统一对外名称为“B站小管家”，包 ID `bilibili-explorer`、账号字段、数据库、Skill 标识及原工具保持兼容。浏览、互动、收藏管理和 QQ 分享共用这一安装入口。视频补读默认接入同实例的 Watch；已有媒体绑定继续优先，未安装或未授权时明确返回缺失能力。配置与恢复方式见插件 `MEDIA.md`。

插件市场的“站内互动”集中配置小号点赞、投币、收藏、三连、私信及额度。新增开关默认关闭，不改变现有实例设置。`messageMode=draft` 允许主人私聊调用私信读写工具，`auto` 另外开启指定联系人的自动回复。评论仍使用“评论与回复”设置。取消点赞也计入点赞操作额度，各类动作分别计时，自动评论沿用评论间隔。

## 投币、三连与图片评论

`coin_video(bvid,coins,operationId)` 指定投 1 或 2 枚，使用小号。插件先核对已投数量，按枚数占用 `dailyCoinLimit`，同时检查 `coinEnabled`。`triple_video(bvid,operationId)` 调用平台三连接口，收藏到默认收藏夹；需要 `tripleEnabled`、`coinEnabled` 和 `likeEnabled` 同时开启，一次预留 1 次点赞、最多 2 枚硬币、1 次收藏的额度。结果分别保留点赞、投币、收藏及返回的投币数量；任一项未完成时标为 `partial`，不把接口返回成功当作三项全部成功，也不自动补发整次三连。额度对结果不明和部分完成保守保留，不自动退还。

`favorite_video` 继续收藏到明确授权的小号收藏夹；大号收藏分类、复制、移动、移除与撤销流程保持原入口。自主浏览可独立选择 `actions.coin`；`actions.triple=true` 与单独的 like、coin、favoriteFolderId 互斥。自主投币须再开启 `autoCoin`，自主三连还需开启 `autoLike`；两者都以实际内容笔记和阅读范围为前提。

`draft_comment.images` 接受实际取得、且用户要求公开发送的 QQ 或 B站图床 HTTPS 图片链接，最多 9 张，每张最多 10 MiB，支持 JPEG、PNG、GIF。拟稿只保存链接；`post_comment` 才上传，并把返回的地址、尺寸、大小放进评论。原生表情仍可同时使用。上传中途失败保留已经上传的结果，使用原草稿继续；不会悄悄去掉图片只发文字。评论提交结果不明时不重发。当前不接收任意本地文件路径，也没有自动搜索 QQ 表情包库；用户提供的图片表情包可以作为配图发送。

图片上传使用新版宿主的通用 multipart 请求能力，兼容浏览器登录与 Cookie 登录。宿主只负责受限下载、表单传输、取消和登录身份检查；上传地址、图片限制、响应校验及评论流程由插件负责。源图片下载不携带 B站 Cookie，来源域名仍须在插件声明中，拒绝重定向和内网来源。旧宿主不支持 multipart 时上传会失败，需要一起更新。

## 浏览经历保存在哪里

原有 `bilibili-history` 数据库的 `contents` 保存 BV、分 P 和实际取得的资料范围，`evidence` 保存字幕等证据，`notes` 保存理解与判断，`interactions` 保存评论正文、根评论、直接回复对象及提交状态。Markdown 笔记位于插件数据空间的 `files/notes/<BV>-p<分P>.md`。点赞、收藏和私信另有按 B站账号保存的状态记录；收藏整理使用自身的视频记录和恢复日志。

1.10.0 在同一数据库新增 `activities`，按每次浏览、阅读或公开互动保存时间、视频、分 P、正文、配图及结果。一次操作从待核对变为成功时更新同一条记录，不重复追加。阅读保留资料来源与覆盖范围，浏览初筛不会写成已看完视频。记录摘要同步到插件现有的“操作记录”，可以搜索视频编号或正文；完整正文和配图地址可通过 `activity` 查询。主人私聊可按 bvid、kind、status 筛选，使用 cursor 翻页；默认查小号自主浏览与公开互动，`public:false` 查当前聊天发起的阅读，`account:main` 查大号阅读。查询不需要重新登录 B站。

实例、账号以及公开/聊天范围分别保留。私信正文不会写入公开浏览经历。旧笔记、评论与状态记录原样保留，不凭空补造旧活动的时间线；新流程产生的活动才进入统一列表。宿主“操作记录”按条持久保存，旧记录不会因为超过 500 条被环形覆盖。

1.11.0 把上面的 activities 从普通记录集合迁到同名轨迹库：按时间、账号、视频和动作建立索引，正文无损压缩和去重。迁移分批复制、读回校验，再移除普通集合中的旧行；中断可以继续。activity 的列表返回摘要，eventId 使用列表的 key 来读取完整正文和配图。旧笔记和 interactions 集合不因这一存储调整删除。宿主旧状态接口也已改存每个插件自己的 state.sqlite，接口名和原键保持兼容。

## 工具与自动流程

`draft_comment` 取得视频元数据、已有公开视频笔记和指定评论串，再生成草稿；`post_comment` 发布该草稿。`like_video`、`like_comment` 设置明确的点赞状态。`emotes` 列当前小号可用评论表情，`draft_comment.emotes` 只接受目录中的 token。私信工具目前发送纯文本，不支持原生私信贴纸。

`inbox` 列站内私信联系人；`messages` 按 UID 读取。平台按序号从新向旧返回：`after` 是排除的下界，`before` 是排除的上界；有更多结果时保持 after 不变，用 nextBefore 继续向旧翻页，完成整次读取后才推进 next 水位。`send_message` 向指定 UID 发信，`interaction_status` 查询点赞或私信的提交状态。以上工具仅在主人私聊开放，后台任务直接调用插件内部流程，不绕过该工具权限。

自动私信只处理设置中的联系人，不扫描陌生联系人。每分钟轮到一名联系人；首次启用只记录当前水位，不补回复旧消息。新增消息分页读完后按顺序处理，每轮最多读取三页；中断后保留翻页进度。单次积压超过 200 条会停止并保留旧水位，交由主人从收件箱核对。撤回和暂不支持的消息类型不触发回复；超过一天的消息不再自动回复。模型只读取该账号与当前联系人的记录，不读取 QQ 私聊或其他站内联系人。

自动浏览先从推荐、搜索和笔记中筛选候选；有具体内容问题时输出 `inspect:{bvid,part,question}`。插件保存补读任务，续跑字幕、必要的转写与画面分析，完成后再决定是否分享或进入评论队列。已有资料和完成的分析会复用。自动评论、回复读取公开笔记、取得资料的范围及实际评论上下文，保持原有开关、每日额度、话题上限和提交后核对流程。

## 恢复与隔离

1.8.0 的连续私信按同一联系人合并，最多八条、合计八千字，相邻消息间隔不超过一分钟；已有己方回复会截断批次。模型输入、正文和批次成员在重试前固定，新到消息留到下一批。开启 `autoMention` 后，评论区 @ 通知与普通回复共用源评论 ID 去重；首次开启只建立水位，实际发言前再次核对原评论、作者和所属楼层。

自动评论可请求一轮 `inspect:{question,ranges?}` 补读，在结果回来前保留队列项。补读最多三个区间、合计十五分钟；之后仍资料不足就不发言。线程上下文包含读到的父评论链，不把同一作者在其他楼层的发言拼成同一对话。

评论、点赞和私信共用账号级持久化写入租约，通过宿主 `updateState` 原子取得；同时到达的后台与手动操作不会各自绕过额度。请求先保存待发送状态，再调用平台。提交结果不明保留为待核对，不自动重发。重试沿用原 operationId 或 draftId；更换目标或正文必须使用新的业务请求，不能以换编号重试结果不明的发送。不同账号的任务、额度与联系人记录隔离。

字幕证据按完整 JSON 的 UTF-8 字节分块，每条数据库记录小于 120 KiB；模型分段预算包含 JSON 转义及问题文本。字幕原文、时间戳和来源保持原样，分页缓存和中断恢复均不以截断正文缩减记录。

## 按问题阅读与独立动作

字幕覆盖取非空文字的实际时间区间，不再把任意字幕标记为全片。没有字幕时尝试登录账号可读的平台逐句文字，再按缺口转写或查看画面；平台摘要、大纲不算逐句文字，没有结束时间也不推算覆盖长度。WBI 签名在插件内生成，不新增宿主业务接口。

`analyze`/`summary` 的 `question` 与可选 `ranges` 使用独立进度。长视频先通过有界片段索引定位，证据足以回答可提前结束；总结注明分析区间。局部回答追加到补读记录，已有全片分析仍保留。无问题的原分析流程兼容旧进度。

发现阶段可返回 `actions:{like,favoriteFolderId,comment,share}`，选择一个实际取得链接的候选后分别执行。自动点赞还需 `likeEnabled` 与 `autoLike` 同时开启；自动收藏只写 `browseFavoriteFolders` 中的小号已有收藏夹，受 `dailyFavoriteLimit` 约束。两者需公开视频内容笔记和实际资料范围，重复遇见同视频不会重复提交。`browse_folders` 与 `favorite_video` 是主人私聊工具，不操作大号收藏。未提供 actions 的旧模型结果继续沿用原分享流程。

## 两个插件的经验记录

B站小管家 1.8.0 与 bPhone 2.2.0 共用构建时内联的经验辅助代码，各自保存数据，不互读目录。`lessons` 保存主题、认识、适用条件、不确定性及最多三条来源引文；B站引文来自已保存笔记，手机引文来自活动报告，均明确记录来源种类，不冒充原视频或读屏逐字证据。引文需与本次实际记录匹配，每轮最多三条经验；没有收获无需生成。

任务开始前按主题词及来源关联检索相关经验，保存在本次任务输入中；中断恢复不会临时换成另一批资料。`learning` 提供 query/get/history/questions，`revise_learning` 仅限主人私聊。修订先核对 expectedRevision，同一事务保存旧版本与新版本；撤回的认识不再召回，也不自动恢复。`questions` 保存可继续的问题，读后明确回答才转为 resolved。

bPhone 在宿主授予闲时机会后，从同设备最近二十项公开活动和最多八个相关问题中选择下一步，也可以休息。私人记录只保存在原私聊；有中断任务时仍先恢复原执行检查点。设备操作和分享保留原有队列、权限与发送流程。

## 验证与接口参考

1.10.0 新增 `tests/bilibili-actions.cjs`，覆盖投币按枚数限额、重复调用与结果不明不重发、三连部分完成、收藏记录、图文评论两种登录模式、上传失败停止评论，以及公开/私聊和账号记录隔离。所有发送使用模拟接口，本轮没有花费真实账号硬币或发布真实评论。宿主的 `check-plugin-multipart.cjs` 与浏览器测试检查文件大小、来源权限、登录隔离、取消和重定向限制。发布前仍需真实账号验收。

接口参数对照了[投币与三连说明](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/video/action.md)、[图片上传说明](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/dynamic/publish.md)及[带图评论实现](https://github.com/inorilzy/bilibili-api/blob/main/bilibili_api/comment.py)。插件自行实现请求与记录，没有引入参考项目的运行依赖。

`node tests/bilibili-social.cjs` 使用受控接口与模型返回，覆盖真实导出的手动工具和自动 poll 路径：拟稿/发送、点赞、表情、结果不明不重发、并发配额、账号切换、多人私信隔离、反向分页、首次水位、模型恢复以及发现→字幕/画面→笔记→自动评论。`tests/butler.cjs` 另外检查 folderRules 声明及非法输入。测试不访问 B站，不发送真实评论、点赞或私信；发布前仍需按项目流程完成对应真实账号与模型验收。

接口核对参考了 [dsh-bili-pond 固定版本](https://github.com/YOYOLnFu/dsh-bili-pond/tree/46a377fae4140c77f2850126926192f3f9949555) 和项目已记录的 AstrBot B站实现；私信序号上下界另对照 [私信接口资料](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/message/private_msg.md)，评论表情目录对照 [表情接口资料](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/emoji/list.md)。只采用接口语义，没有引入这些项目的运行依赖、账号状态或模型配置。

逐句文字降级与 WBI 路径参考 [dsh-bili-humanism reader](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism/blob/22cbb1d8d44a95d325bf4fcf916792b773cf1e17/lib/reader.mjs)，通知合并参考 [AstrBot B站插件固定版本](https://github.com/chenluQwQ/astrbot_plugin_bilibili_ai_bot/blob/8ba359e5c3b9e4909475690bafa739ab5c114244/core/reply.py)。新实现保留 OpenBot 现有存储与账号隔离，不引入外部项目运行依赖。

`npm test` 加入经验引文/修订/撤回、事务冲突、公开与私人隔离、WBI 标准向量、字幕区间、局部阅读、独立动作、评论补读、@ 去重和私信批次恢复测试。`npm run sync:shared` 更新两个插件的内联辅助代码，测试会校验同步。正式目录仍指向已发布版本；真实账号接口、真实模型的阅读效果及设备体验需在发布前验收。

## 直播与弹幕调研（2026-10-26）

这一部分是可行性结论，尚未加入插件工具。

视频弹幕可以指定出现时刻。`/x/v2/dm/post` 接受分 P 对应的 `cid` 和毫秒单位的 `progress`，例如第2P的02:15对应 `135000`。发送时直接登记这个视频时间点，不必等待播放器播到那里；若用户要求未来某个现实时间才发送，则另外需要定时任务。实施时先读取视频分 P、时长并验证范围，再用账号登录态及 WBI 签名提交，保存 BV、分 P、cid、毫秒位置、正文和返回的弹幕编号。依据：[视频弹幕接口](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/danmaku/action.md)。

直播间发弹幕也可实现。`https://api.live.bilibili.com/msg/send` 使用真实房间号、正文、时间戳及账号登录态；平台还提供当前账号在房间内可用的弹幕配置。直播弹幕是发给当前直播间，不能像视频弹幕一样指定录像播放时间。需要查看正在讨论什么时，可接入带认证和心跳的直播信息流，维护每个房间的短期上下文及己方发送记录；重连去重、禁言、频率限制与发送结果不明都由插件处理。依据：[直播弹幕](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/live/danmaku.md)、[直播信息流](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/live/message_stream.md)。

看直播画面和声音需要增加媒体流程。房间接口可以取得 HLS/FLV 播放源，Streamlink 的 B站适配器已有读取 HLS 的实现；当前 OpenBot 的 Watch 在 `tools/media.py` 中明确拒绝 `is_live` 等直播状态。建议在媒体插件增加有时长和容量上限的直播片段采集，沿用转写、抽帧和视觉理解；B站小管家负责选择房间、决定何时观察或发言。记录同时保存现实时间、房间号、采样区间和实际收获。长连接弹幕与视频流采集需要可持续运行的插件组件，不能塞进一次有限时长的 JS 工具执行。依据：[房间播放信息](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/live/info.md)、[Streamlink B站实现](https://github.com/streamlink/streamlink/blob/master/src/streamlink/plugins/bilibili.py)。

开发顺序建议先做视频定点弹幕，再做直播间读取和手动发弹幕，最后接持续观看与自主互动。每一步都可以复用本轮的活动记录和按账号防重流程；本轮只核对代码与接口资料，没有进入真实直播间发送消息。
