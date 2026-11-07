# 画图服务与参数

此文件是 Codex imagegen 的 Image API 参考在 OpenBot 画图插件中的对应说明。模型只调用 `draw_image`；不要写脚本、请求原始 API、读取凭据或调用当前 Codex 会话的工具。

| 服务设置 | 连接与用途 | 参考图 |
| --- | --- | --- |
| 自动选择 | 优先复用当前聊天已绑定的 OpenBot Codex 登录；否则使用已配置的 API Key | 取决于最终服务 |
| Codex 登录 | 复用 OpenBot 已登录模型的连接；图片默认由服务选模型，GIF 默认请求 `gpt-image-2.6-flare` | 使用 Responses `input_image` |
| OpenAI 图片 | 使用配置的 OpenAI API Key 和 Images 接口；默认图片模型 `gpt-image-2.6-flare`，也可配置 `gpt-image-2.6-sunburst` | 使用编辑接口 |
| OpenAI 对话绘图 | 使用 OpenAI API Key 和 Responses 的 `image_generation` | 使用 Responses `input_image` |
| 兼容服务 | 按插件设置的 HTTPS 根地址、模型和协议调用 | 仅在对应服务确实支持时使用 |

`size`、`quality`、`format` 是 `draw_image` 的工具参数；可用值以工具定义为准。`background` 控制输出透明度，不是提示词里的视觉背景。透明图片需 PNG 或 WebP，并需要服务本身支持。GPT Image 2 的透明背景属于预览能力；若当前账号或连接拒绝，不要把纯色背景说成透明图片。

GPT Image 2.6 的 GIF 可通过 Images 或 Responses 请求，需账号具有 GIF 预览权限；`frameCount` 可设 2–16 帧，`frameDurationMs` 可设每帧 20–2000 毫秒，留空由服务决定。Images 的动图请求不使用流式生成；Responses 可以流式返回任务事件，但不请求部分图片。Codex 登录路线采用相同的模型和参数，是否被当前账号和服务端接受需实际验证，不能自动换成 API Key 路线。

`provider` 只在用户明确指定服务时传入。一个服务拒绝请求、登录失效、额度不足或返回内容不合要求时，报告本次结果；换服务或重试是新的生成请求。插件不会把登录凭据、API Key、原图 Base64 或结果 Base64 暴露给模型。

自拍固定图由实例设置页管理；它不是普通聊天参考图。聊天参考图最多两张、单张最多 600 KiB；较大的图片需要用户提供缩小版本。工具每次只生成一张图片。结果通过 OpenBot 媒体引用保存并返回 URL。
