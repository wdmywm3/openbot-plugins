---
name: tool-workshop
description: 按用户任务编写、试运行并保存 JavaScript 小工具，或复用当前私聊已经保存的工具。
---

使用工具工坊提供的 manage 和 run。先 manage list 查找已有工具；有合适工具时 read 查看 saved 的参数规则，run 使用 saved.revision。每个工具只保存在创建它的主人私聊中。

编写新工具时，先明确输入、输出和预期行为。manage draft 传 id、revision:0、title、description、inputSchema、code。修改前 read 并传当前 revision，不能用过期版本覆盖或假设版本连续。源码格式为 `module.exports.run = async ctx => { return ...; };`。输入来自 ctx.input；结果必须能 JSON 序列化。默认没有文件、网络、模型或凭据接口，不能使用 require、import、eval、Function、process、Buffer、fetch 或定时器。只用普通 JavaScript；不要读取其他应用的数据。

参数规则支持 object、array、string、number、integer、boolean、null、简单 enum、数值与长度限制。每层 object 都要写 properties 和 additionalProperties:false；array 写 items。不要使用 $ref、pattern、oneOf 等其他规则。代码最多 48 KiB，参数规则最多 12 KiB，每次输入最多 60 KiB、最终结果最多 256 KiB；一次执行最长 180 秒。普通工具默认 3 秒，声明 modelRequest 后默认 180 秒；模型调用本身建议最多 120 秒，为结果保存留时间。长任务需拆分，不能以死循环等待。

使用 manage test，传相同 id/revision 和有代表性的 input，尽量带 expectedJson 核对输出，例如 `expectedJson:"{\"text\":\"a b\"}"`；字符串、数值、数组也用相应 JSON 文本。覆盖正常输入、边界与用户关心的例外。passed:false 要修正草稿后重测；抛错也不能声称通过。当前草稿通过后 manage save，随后 run 即可复用，无须安装新插件。新草稿不会替换已保存版本，只有再次 save 才会替换。试运行成功只说明本次输入的执行结果，需要根据任务选足够有用的样例。

能力开关默认关闭。用户要求调用外部 API 且设置已开启时，草稿声明 capabilities:["request"]，代码通过 `await ctx.api.request(url, options)` 访问已授权网络范围；响应包含 status、ok、headers、body。原生模型请求声明 modelRequest；媒体保存与发布声明 assets。仅请求本任务需要的能力；没有相应开关时说明配置，不偷偷改用其他路径。

`ctx.api.modelRequest({modelId?,input,tools,timeoutMs?})` 通过宿主已配置模型调用，凭据不会交给源码。省略 modelId 使用实例主模型；不能猜账号或端点。输入最多 2 MiB，中间结果最多 8 MiB。`ctx.api.assets` 保存图片并返回当前聊天引用，`publish` 返回可发送地址。不要把大图 Base64 放进最终返回值、源码或工具参数；直接在同一次执行中保存。模型选择、图片语义、参数兼容、状态和结果校验由所写工具负责。不要把凭据硬编码进源码、参数或输出，不读取宿主模型凭据。独立 API Key 服务若未接入宿主模型，工坊没有其凭据读取接口。

test 和 run 都会真实执行源码，联网请求可能产生外部影响；只执行用户授权的任务。超时或取消后可能已经发生外部操作，先核对再决定能否重试，不因运行状态短暂未完成重复提交。同一操作重试复用插件调用 requestKey；只有真正的新操作使用新键。

最小示例：参数规则 `{"type":"object","properties":{"text":{"type":"string","maxLength":2000}},"required":["text"],"additionalProperties":false}`，源码 `module.exports.run = ctx => ({ text: ctx.input.text.trim().replace(/\s+/g, ' ') });`。用含多处空白与空字符串的输入试运行，核对输出后保存。

用户要求自己写一个画图工具时，可按下面协议编写源码，声明 capabilities:["modelRequest","assets"]，并定义必填 prompt 字符串参数。此示例不会自动创建或保存工具；仍须 draft、真实试运行、检查图片结果，再 save。不要把已安装的 draw_image 工具包装后声称新写了绘图实现。

```js
module.exports.run = async ctx => {
  const response = await ctx.api.modelRequest({
    input: [{ role: 'user', content: [{ type: 'input_text', text: ctx.input.prompt }] }],
    tools: [{ type: 'image_generation', output_format: 'png', size: '1024x1024', quality: 'medium' }],
    timeoutMs: 120000
  });
  const images = (response.output || []).filter(item => item.type === 'image_generation_call');
  if (images.length !== 1 || images[0].status !== 'completed') throw Error('没有收到完成的图片');
  const data = images[0].result;
  if (typeof data !== 'string' || data.length > 6990508 || !data.startsWith('iVBORw0KGgo')
      || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw Error('图片编码、类型或大小无效');
  const stored = await ctx.api.assets({ action: 'put', data, mimeType: 'image/png', kind: 'image', name: 'drawing.png' });
  const published = await ctx.api.assets({ action: 'publish', ref: stored.ref });
  return { assetRef: stored.ref, url: published.url };
};
```

这个工具使用当前宿主支持的模型原生能力，不能保证任意已登录账号都有画图额度。遇到不支持、超时或取消时先核对原请求，不自动改用付费服务或再次画图。
