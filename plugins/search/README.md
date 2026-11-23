# 搜索

在「插件 → 搜索 → 默认配置」选择服务商并保存 API Key。实例可分别为网页搜索和以图搜图选择「跟随插件默认」或「自定义」。自定义使用本实例的凭据。

- 网页搜索支持 AnySearch、Tavily、Exa、Brave 和 OpenAI 原生搜索。OpenAI 选项复用当前聊天的 Codex 或 Responses 主模型连接，所选模型和服务端需支持 web_search。AnySearch 不填 Key 可使用匿名服务。
- 以图搜图独立配置：在 Google Cloud 项目启用 Cloud Vision API，创建允许调用它的 API Key，在插件设置中选择 Google Cloud Vision 并保存 Key。
- 直接提问或发送、引用图片询问出处。Bot 自行选择网页搜索、以图搜图及网页阅读。
- 按名称找图时可以读取图库、打开作品页、获取参考图并查看预览，再把选中的图片交给画图工具。
- 旧实例已设置的服务商和凭据保留在该实例。

图片搜索使用消息中的原图。插件按 Google Vision 的 10 MB JSON 请求上限预留参数和 base64 编码空间，同时遵守宿主公布的附件容量。匹配图片、相似图片和相关网页分别返回；网页可能是转载，结果不自动等同于原创出处。服务费用按各提供方规则计费，大模型费用另计。

OpenAI 原生搜索需要宿主模型接口支持 `web_search`。参考图通过宿主的流式读取与媒体接口交给当前聊天的画图工具。

验证：在插件仓库执行 `npm run test:search`。Google 接口文档：https://docs.cloud.google.com/vision/docs/detecting-web
