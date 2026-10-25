# B站小管家：视频阅读与备份

1.9.0 起，字幕不足时默认调用同一实例的 Watch 补充语音或画面。安装并启用 Watch 0.3.0 或更新版本，在任务工具权限中允许 `watch_media`；无需填写动态生成的 MCP 服务 ID。未启用、未授权、来源不可访问或缺少转写模型时会保留明确的缺失说明。已有转写、画面及备份绑定优先沿用；在媒体设置中移除某项会保存为禁用，不会在下次打开时重新启用。

小管家继续负责按 BV/分P恢复进度、选择补读范围、保存笔记和决定互动；Watch 负责读取音视频。后台阅读使用独立任务范围，不借用某个 QQ 私聊的阅读回执。相同请求沿用回执，字幕分页会读到末尾，抽样画面保留实际时间；同一任务范围内的后续补看可复用下载文件。

`/bilianalyze BV号 [分P序号]` 先读取平台字幕；字幕缺失或模型判断不完整时调用可选转写工具；需要核对界面、图表或动作时调用可选画面工具。字幕足够时不重复转写，缺画面时也不会强制先转写音频。

每次最多处理三段，单段约五分钟，时间边界保留重叠。再次发送同一命令会继续；异步媒体任务也通过同一命令查询结果。自主浏览选择了具体补读问题后，后台会按轮次续跑同一任务，完成后再判断分享和评论。已有资料、每段笔记和任务编号按实例及聊天保存在宿主中；自主浏览的阅读笔记单独保存为公开笔记。完成后用 `/bilisummary BV号 [分P序号] [页码]` 查看当前聊天的分析；加 `new` 可以开始新分析。长内容分层合并，不把完整字幕塞入一次模型请求。

总结标明字幕、转写或抽样画面来源，并保留缺失区间。画面分析需要当前聊天使用的模型开启图片能力。模型提出需要核对的短片段时，优先在该片段抽帧；每批最多十二帧，本地服务结合场景切换和均匀采样，去掉内容完全相同的图片。仍不足的信息保留为待核对。当前不提供逐帧动作识别，也不把语音转写当作音乐或环境声识别。

收藏规划会参考当前聊天已完成的第一 P 总结，并注明其范围。已有收藏规划保持冻结；分析后执行 `/biliscan new`、`/biliplan` 才会生成采用新总结的方案。

## 选择媒体工具

字幕读取不需要额外模型。转写、画面默认使用 Watch，备份仍需单独配置；缺少能力时会保留不完整总结。OpenBot 不自动安装 Python、MCP、FFmpeg 或模型，也不会自动切换云端转写。

也可以复用当前实例已有的 MCP。工具必须获得当前会话或后台任务的授权。插件参数 `mediaServices` 分别绑定 `transcribe` 和 `frames`；自定义绑定覆盖对应的 Watch 默认值，设为 `null` 禁用该项。下例是旧媒体服务的兼容绑定，仍可使用。不同服务的参数名通过映射适配，结果须满足下面的时间戳协议。

```json
{
  "transcribe": {
    "serverId": "替换为实例中的MCP服务ID",
    "toolName": "media_start",
    "arguments": {"kind":"transcribe","url":"$url","start":"$start","end":"$end","request_id":"$requestId"},
    "poll": {"toolName":"media_status","arguments":{"job_id":"$jobId"}}
  },
  "frames": {
    "serverId": "替换为实例中的MCP服务ID",
    "toolName": "media_start",
    "arguments": {"kind":"frames","url":"$url","start":"$start","end":"$end","request_id":"$requestId","max_frames":"$maxFrames"},
    "poll": {"toolName":"media_status","arguments":{"job_id":"$jobId"}}
  }
}
```

把该对象填入插件市场中对应实例的“转写、画面与备份工具”参数。若服务同步返回结果，可以不配置 `poll`。绑定的 MCP 应负责媒体读取或分析，不要绑定发消息、安装软件等其他操作。

## 可选本地服务

本插件附带 `media-mcp/server.py` 参考服务，支持本地 faster-whisper 转写和 FFmpeg 抽帧。它通过 stdio 提供 MCP，使用串行队列和落盘的任务结果。支持 B 站、YouTube 视频；默认不读取浏览器 Cookie。备份可显式配置用户管理的 Netscape Cookie 文件，不自动提取外部浏览器登录态。无法访问的视频保留失败记录。

用户决定启用后，在单独虚拟环境安装 `media-mcp/requirements.txt`，自行安装 FFmpeg 并加入该服务的 PATH；也可通过 `OPENBOT_FFMPEG` 指定可执行文件，但 yt-dlp 的片段下载仍需能找到 FFmpeg。不要运行来源不明的安装脚本。

本地模型由用户选择并下载。例如通过 Hugging Face CLI 下载 `Systran/faster-whisper-large-v3` 至自己选择的目录，再将 `OPENBOT_ASR_MODEL_DIR` 指向包含 `model.bin` 的目录。代码使用 `local_files_only=True`，不会触发模型自动下载。也可选择其他兼容 faster-whisper 的模型目录。

在实例的 MCP 设置中添加 stdio 服务：命令是该虚拟环境的 Python，参数是 `server.py` 的绝对路径。环境变量：

| 变量 | 用途 |
| --- | --- |
| `OPENBOT_MEDIA_WORK` | 每个实例独立的工作目录，保存任务回执和分析资料 |
| `OPENBOT_ASR_MODEL_DIR` | 用户下载好的模型目录；只抽帧时不需要 |
| `OPENBOT_ASR_DEVICE` | `cpu` 或 `cuda`，默认 `cpu` |
| `OPENBOT_ASR_COMPUTE` | 默认 `int8`；根据硬件选择其他支持的精度 |
| `OPENBOT_FFMPEG` | 可选 FFmpeg 可执行文件路径 |
| `OPENBOT_FFPROBE` | 可选 ffprobe 可执行文件路径 |

Windows GPU 环境可在同一虚拟环境安装 `nvidia-cublas-cu12`、`nvidia-cudnn-cu12`，使用 `launch.py --config <设置文件绝对路径>` 启动。设置文件是 JSON 对象，允许上表中除 `OPENBOT_MEDIA_WORK` 外的变量；例如选择 `cuda` 和 `int8_float16`。启动器会加入虚拟环境内的 NVIDIA DLL 目录和 FFmpeg 目录，并默认使用宿主提供的实例 MCP 数据目录保存任务。模型权重和运行库可以共享，任务目录仍按实例隔离。

发现并授权 `media_start`、`media_status` 后，使用上面的绑定配置。GPU 模式还需要与 CTranslate2 匹配的运行库。音视频临时文件在处理后清理，结果保留在工作目录；停用服务后可自行清理旧结果。服务重启时会把未完成任务标记为失败，避免不知情地重跑。

外部 MCP 的网络请求不经过宿主的网站队列。本参考服务单线程处理，yt-dlp 设置随机请求间隔、关闭自动重试；其他服务需要自行配置访问频率。

## 通用接口

其他插件声明 `media` 权限后也可调用 `ctx.api.media({kind,url,start,end,requestId,jobId?})`，使用同样的 `mediaServices` 配置。工具结果是 MCP `structuredContent` 或 JSON 文本，支持：

```json
{"status":"queued","jobId":"稳定任务编号"}
```

```json
{"status":"completed","segments":[{"start":300,"end":305,"text":"这一段讲话"}],"language":"zh"}
```

画面可以返回 `observations:[{start,end,text}]`，或 `frames:[{timestamp,mimeType,data}]`，其中 data 是图片 base64；最多十二张、总编码不超过 16 MB。所有时间都是原视频的绝对秒数，不能把截取片段重新从零计时。失败返回 `status:failed,error`；未配置能力返回 `status:unavailable,reason`。只返回本地文件路径的 MCP 需要增加适配，不能直接当成视频内容。

本地服务离线测试：`python -B -m unittest discover -s tests -p test_media_mcp.py -v`。插件流程测试：`npm test`。这些测试不下载模型、不访问真实视频，也不代表已通过 GPU 或真实 B 站转写验收。


## 收藏视频备份

插件设置中的“自动备份收藏视频到本地”默认关闭。开启前为 `mediaServices` 增加以下 `backup` 映射，服务必须是更新后的本地媒体 MCP（也可适配其他实现）：

```json
{
  "backup": {
    "serverId": "替换为实例中的MCP服务ID",
    "toolName": "media_start",
    "arguments": {"kind":"backup","url":"$url","start":0,"end":1,"request_id":"$requestId","namespace":"$namespace"},
    "poll": {"toolName":"media_status","arguments":{"job_id":"$jobId"}}
  }
}
```

`namespace` 由宿主按实例和插件生成，不能从聊天输入提供。此处 start/end 只保留统一工具签名；backup 下载整个指定分P，不按一秒截取。后台使用实例主人私聊的工具权限；请在该会话启用插件及媒体工具。停用开关会停止发起新备份，已经交给 MCP 的下载由 MCP 完成。

服务配置支持以下变量，也可以写入 launch.py 使用的本地 JSON 设置：

| 变量 | 默认值与用途 |
| --- | --- |
| OPENBOT_BACKUP_DIR | 服务工作目录下 backups；可选择其他本地目录 |
| OPENBOT_BACKUP_MAX_FILE_MB | 2048；一个视频下载目录的大小上限 |
| OPENBOT_BACKUP_MAX_TOTAL_GB | 20；每个实例及插件备份目录的总量上限 |
| OPENBOT_MEDIA_COOKIE_FILE | 可选；用户管理的 Netscape Cookie 文件路径 |

备份最多选择 1080p，并合并音视频轨，保留来源、标题、实际时长、文件大小与 SHA-256。下载前及过程中检查容量，至少保留 1 GiB 可用空间；不会自动清理旧备份来腾空间。完成结果为 `{"status":"completed","backup":{"path":"绝对路径","bytes":123,"sha256":"64位十六进制"}}`，缺少回执不能作为已备份。

按 BV 和分P去重。任务重启不盲目重放；显式 retry 生成新的请求，仍优先复用经过校验的备份。损坏的原文件保留，新尝试使用另一个目录。取消收藏和卸载插件均不删除本地备份。开启备份时，移除前须确认全部分P的文件仍存在且校验一致。

默认转写模型、模型参数保持不变，备份不依赖 ASR。外部 MCP 不经过宿主网站队列，本地实现使用单任务队列、随机 3–7 秒请求等待、单片段并发和零自动重试；遇到限制应暂停，不更换身份或加速重试。
