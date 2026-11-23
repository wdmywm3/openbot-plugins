"use strict";

async function binding(ctx) {
  const p = ctx.principal || {};
  if (p.source !== "channel" || p.role !== "owner" || p.messageType !== "private" || !p.senderId
    || !["onebot:private:" + p.senderId, "qqbot:private:" + p.senderId].includes(p.chatId)) {
    throw Error("请在实例主人的私聊中使用电脑操作。");
  }
  const current = (await ctx.api.getCapabilities()).conversationBinding;
  if (!current?.privateOwner || !current.account) throw Error("当前私聊或发送账号已变化。");
  return current.account;
}

async function step(ctx, operation) {
  const account = await binding(ctx);
  const turn = ctx.requestId || ctx.principal.primaryMessageId || ctx.principal.messageId;
  if (!turn) throw Error("电脑操作需要可核验的当前请求。");
  const input = ctx.input || {};
  if (operation === "open_app" || input.foreground === true) {
    const config = await ctx.api.getConfig();
    if (config.allowForeground !== true) throw Error("此操作需要在电脑操作插件设置中允许打开应用或激活窗口。");
  }
  const owner = JSON.stringify([ctx.plugin.scopeNamespace, account, ctx.principal.senderId, turn]);
  const response = await ctx.api.callTool({ pluginId: "computer-use", pluginServer: "desktop", name: "desktop_step",
    arguments: { owner, operation, input }, timeoutMs: 25000 });
  if (await binding(ctx) !== account) throw Error("发送账号已变化，请重新观察。");
  const text = response.content?.find(part => part.type === "text")?.text || "";
  if (response.isError) throw Error(text.slice(0, 1500) || "桌面驱动调用失败。");
  const result = JSON.parse(text);
  const image = response.content?.find(part => part.type === "image");
  if (operation !== "screenshot" && !(operation === "view" && input.image)) return result;
  if (typeof image?.data !== "string" || !image.data || image.data.length > 4 * 1024 * 1024 || image.mimeType !== "image/png") throw Error("本次没有取得可用的窗口截图。");
  const stored = await ctx.api.assets({ action: "put", data: image.data, mimeType: image.mimeType, name: "window.png", kind: "image" });
  if (operation === "screenshot") {
    if (await binding(ctx) !== account) throw Error("发送账号已变化，请重新截图。");
    const published = await ctx.api.assets({ action: "publish", ref: stored.ref });
    result.url = published.url;
  }
  result.attachments = [{ assetRef: stored.ref, caption: "本次选定的窗口" }];
  return result;
}

for (const name of ["windows", "open_app", "view", "act", "screenshot", "finish"]) {
  module.exports[name] = ctx => step(ctx, name);
}
