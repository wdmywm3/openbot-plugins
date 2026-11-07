# 画图

一个 `draw_image` 工具和专用 Skill，支持 OpenAI Image API、Responses 的 `image_generation`、相应兼容服务，以及 OpenBot 中已配置登录的 Codex 连接。OpenAI 图片服务默认使用 GPT Image 2.6 Flare，也可配置 Sunburst；普通生图与角色自拍分别开关，默认开启普通生图、关闭自拍。选择 GPT Image 时另有可选的 `gpt-image` 指南；技能出现在目录中不等于自动加载正文。提示词原则和范例改编自 Codex imagegen，包含在插件中。

普通生图使用 `mode:image`（默认），保留文字绘图和聊天参考图改图。开启“自拍”后，画自己的形象使用 `mode:selfie`。支持人设图的 OpenBot 会提供当前聊天所用角色的人设图，默认优先正面，可用 `selfieView` 选择侧面、背面、Q 版或细节。侧面和背面可同时参考正面。没有可用人设图时，沿用实例在“自拍形象”页签上传的图片。

人设图随角色包保存，在“角色 → 人设图”维护。备用图属于当前实例，在“自拍形象”页上传，支持不超过 10 MiB 的 PNG、JPEG、WebP。宿主在后台缩放参考图。多个设置页面同时修改备用图时会要求重新查看当前选择。

自拍需要有效的角色或备用参考图及支持参考图的服务。生成途中更换角色、换掉本次参考的图片或清除备用图后，结果会停止发送。关闭当前方式会停止等待中的生成，已经提交的请求仍可能产生服务商费用。

在插件详情的“设置”中配置画图服务、模型和 API Key，无需先创建实例。新配置默认选择 OpenAI 图片；选定接入方式后只显示对应服务，直接图片接口不显示对话模型。旧配置的自动选择仍兼容。至少配置一个可用的服务后才能开启插件；这里检查配置是否齐全，真实连接及模型权限仍须实际请求验证。OpenAI 与兼容服务的 API Key 分开加密保存。兼容根地址包含版本路径，例如 `https://example.org/v1`；仅支持声明的 OpenAI Images 或 Responses 协议，不自动转换其他供应商的专用字段。兼容图片服务的 JSON 编辑必须确认支持后单独开启。Codex 请求失败不会自动切换到可能收费的 API Key 服务。

“用量”页默认总并发 2、每实例并发 1，最多排队 20 个任务、等待 300 秒；单实例每小时 10 次、每天 50 次，全部实例合计每小时 20 次、每天 100 次。每个实例可覆盖自己的并发、每小时及每日上限，填写 0 使用插件默认值。上限按本机自然小时和自然日统计，插件只在提交服务请求前计数；排队、校验失败或超额拒绝不会调用服务。已提交的失败或取消请求仍计数，不自动重试。停用、取消或排队超时会撤销等待中的任务；已提交的服务请求可能已经产生费用。

Codex 登录使用宿主 `modelRequest`，不读取漫剧工作台、Codex 桌面或 CLI 的数据目录。默认复用实例已登录模型的连接和当前模型名，不再固定为 `gpt-5.5`；需要指定其他 Responses 执行模型时才填写“绘图执行模型”。留空登录模型时自动从当前聊天主模型、后备模型或实例其他已登录模型中选择。需要宿主提供 `nativeModelRequests`、`modelResponseSelection`、`model:request` 和 `model:select`。账号或端点拒绝 `image_generation` 时明确报错。真实出图需在已登录的 OpenBot 实例中验收；本地夹具覆盖请求形状和连接复用。

配置服务后，设置页会读取服务返回的模型目录，可选择或手动输入模型名称。Codex 的目录可能只列出对话模型，不会将它们冒充画图模型；手动填写的画图模型仍由服务端决定是否接受或采用。2026-11-06 使用官方 Codex CLI 预览版及 ChatGPT 登录的 GIF 实测被服务端拒绝，该路线的 2.6 模型选择和动图需要等待服务支持或在实际账号重新验收。

默认 1024×1024、medium；工具可选横图、竖图、画质和透明背景。普通改图最多两张参考图、单张 600 KiB，来自当前聊天附件或有权限的插件媒体；自拍使用固定图的缩略参考，图片结果最多 5 MiB。OpenAI Images 编辑使用官方 JSON `images: [{image_url}]`，Responses 用 `input_image`。参考图绝不在不支持的服务上静默丢弃。

GIF 动图使用 `format:gif`，默认自动尺寸，可指定 2–16 帧及每帧 20–2000 毫秒。OpenAI 的 Images 和 Responses 接口可使用 GPT Image 2.6 请求 GIF，须有相应的 GIF 预览权限；兼容服务须自行支持对应参数。Images 动图请求不启用流式生成，Responses 可流式返回任务事件但不请求部分图片。Codex 登录路线也会请求 GPT Image 2.6，是否被当前账号和服务端接受需实际验证，不会自动转到 API Key 服务。结果保持 GIF 原始字节。

网络通过宿主有界流读取：单次响应最多 8 MiB、连接最多 120 秒，登录模型请求最多 180 秒。工具采用宿主已有任务协议查询与取消，取消关闭流并撤销接口权限；不能撤回服务商已经受理的收费。网络错误、超时或服务失败不自动重试、不切换供应商。图片下载不携带生成请求的 Authorization。

结果先检查 Base64、大小、图片签名和 PNG 尺寸，再保存为当前实例的媒体引用并发布到当前聊天。返回值不包含 API Key、原始参考图或图像 Base64。

0.3.1 另要求宿主提供 conditionalGlobalSettings；0.3.0 要求宿主提供 `pluginGlobalSettings`、`globalPluginDatabase`、`pluginAdmissionQueue` 以及原有的画图模型接口；请使用本次配套宿主源码或包含这些接口的更新版本。旧版每实例保存的服务凭据不会自动合并，请在全局设置中重新配置；原实例的设置与固定形象保留。

本地测试：`node tests/image-studio.cjs`、`node tests/image-studio-selfie.cjs`、`node tests/image-studio-catalog.cjs`；真实宿主集成：`node tests/image-studio-host.cjs ../openbot`、`node tests/image-studio-selfie-host.cjs ../openbot`。覆盖安装、隔离 Worker、流、参考图、媒体、形象版本和取消。测试使用本地响应夹具，不消耗远端额度。正式账号画图另需有凭据的验收。

未发布的新包可通过 `npm run prepare:candidates -- <新目录>` 打包，并在配套宿主中导入；正式市场条目必须在真实提交后由 `npm run catalog -- <提交SHA>` 生成，不写虚假的远端提交。插件版本号与 OpenBot 宿主版本号分别管理。

协议参考：[OpenAI Image API 编辑](https://developers.openai.com/api/reference/resources/images/methods/edit)、[Responses 绘图](https://developers.openai.com/api/docs/guides/tools-image-generation)。
