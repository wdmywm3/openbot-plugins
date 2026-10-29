# 搜索

在插件市场导入或安装“搜索”，授权后选择使用它的实例。

- 网页搜索支持 AnySearch、Tavily、Exa、Brave。AnySearch 不填 Key 可使用匿名服务。
- 以图搜图独立配置：在 Google Cloud 项目启用 Cloud Vision API，创建允许调用它的 API Key，在插件设置中选择 Google Cloud Vision 并保存 Key。
- 直接提问或发送、引用图片询问出处。Bot 自行选择网页搜索、以图搜图及网页阅读。
- 安装时导入旧版网页搜索配置和加密凭据；后续在插件设置中管理。

图片搜索使用消息中的原图，最大 6 MiB。匹配图片、相似图片和相关网页分别返回；网页可能是转载，结果不自动等同于原创出处。服务费用按各提供方规则计费，大模型费用另计。

需要支持 `readMessageAttachment`、`maxBodyBytes` 和插件配置迁移的 OpenBot。宿主只提供通用的附件、网络、凭据及工具接口；搜索服务实现全部在此插件中。

验证：在插件仓库执行 `npm run test:search`。Google 接口文档：https://docs.cloud.google.com/vision/docs/detecting-web
