"use strict";

const START_FIELDS = new Set(["source", "source_type", "message_id", "attachment_index", "start_seconds", "end_seconds", "frame_count", "sampling", "timestamps", "crop", "request_id"]);
const MEDIA = /\.(mp4|mkv|webm|mov|avi|m4v|flv|wmv|mpg|mpeg|ts|m2ts|ogv|3gp|3g2)$/i;
const remote = source => typeof source === "string" && /^https?:\/\//i.test(source);
const video = item => item?.type === "video" || /^video\//i.test(item?.mimeType || item?.mediaType || "")
  || item?.type === "file" && MEDIA.test(item.name || item.fileName || "");

async function call(ctx, name, args) {
  ctx.signal?.throwIfAborted();
  const response = await ctx.api.callTool({ pluginId: "watch", pluginServer: "watch", name, arguments: args, timeoutMs: 120000 });
  if (response?.isError) throw new Error((response.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").slice(0, 600) || "Watch 读取失败");
  let value = response?.structuredContent;
  if (!value) {
    try { value = JSON.parse((response?.content || []).find(x => x.type === "text")?.text || "null"); } catch { /* below */ }
  }
  if (!value || typeof value !== "object") throw new Error("Watch 返回了无效结果");
  return value;
}

async function message(ctx, id) {
  const matches = item => String(item?.id || "") === id || String(item?.providerMessageId || "") === id;
  if (matches(ctx.message)) return ctx.message;
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    ctx.signal?.throwIfAborted();
    const history = await ctx.api.readHistory({ limit: 100, ...(cursor ? { cursor } : {}) });
    const found = (history.items || []).find(matches);
    if (found) return found;
    const next = history.nextCursor;
    if (!next || seen.has(next)) break;
    seen.add(next); cursor = next;
  }
  throw new Error("当前聊天中找不到指定的视频消息，请提供消息编号、视频链接或附件");
}

async function importAttachment(ctx, input, selected, index, namespace) {
  const attachment = await ctx.api.readMessageAttachment({ messageId: selected.id, index, maxBytes: 6 * 1024 * 1024 });
  const original = selected.media.filter(m => ["image", "file", "audio", "video"].includes(m.type))[index];
  if (!video(original) || !["file", "video"].includes(attachment.type) || !Number.isInteger(attachment.size) || attachment.size <= 0
    || typeof attachment.data !== "string" || !attachment.data || attachment.data.length > 8 * 1024 * 1024)
    throw new Error("读取到的附件不是可用视频");
  let name = String(original.name || original.fileName || "video.mp4").split(/[\\/]/).at(-1);
  if (!MEDIA.test(name)) name = "video.mp4";
  const begin = await call(ctx, "watch_ingest", { action: "begin", namespace, name, size: attachment.size,
    source_id: `${selected.id}:${index}`, ...(input.request_id ? { request_id: input.request_id } : {}) });
  if (begin.result) return begin.result.source;
  let offset = begin.offset;
  if (!Number.isInteger(offset) || offset < 0 || offset > attachment.size || offset < attachment.size && offset % 3)
    throw new Error("附件导入进度无效");
  while (offset < attachment.size) {
    const block = attachment.data.slice(offset / 3 * 4, offset / 3 * 4 + 48000);
    const result = await call(ctx, "watch_ingest", { action: "append", namespace, upload_id: begin.upload_id, offset, base64: block });
    if (!Number.isInteger(result.offset) || result.offset <= offset || result.offset > attachment.size) throw new Error("附件导入未前进");
    offset = result.offset;
  }
  return (await call(ctx, "watch_ingest", { action: "finish", namespace, upload_id: begin.upload_id })).source;
}

module.exports.watch_start = async ctx => {
  const input = ctx.input || {};
  if (Object.keys(input).some(key => !START_FIELDS.has(key)) || Boolean(input.source) === Boolean(input.message_id))
    throw new Error("请提供视频来源或消息编号，二者选择一个");
  if (!input.message_id && input.attachment_index !== undefined) throw new Error("附件序号需要与消息编号一起使用");
  const namespace = ctx.plugin?.scopeNamespace;
  if (typeof namespace !== "string" || !/^[a-f0-9]{64}$/.test(namespace)) throw new Error("当前宿主没有提供视频读取范围，请更新宿主");
  const { message_id, attachment_index, ...request } = input;
  if (message_id) {
    if (typeof message_id !== "string" || !message_id.trim() || message_id.length > 200) throw new Error("视频消息编号无效");
    const selected = await message(ctx, message_id);
    const media = (selected.media || []).filter(m => ["image", "file", "audio", "video"].includes(m.type));
    const index = attachment_index ?? media.findIndex(video);
    if (!Number.isInteger(index) || index < 0 || index >= media.length || !video(media[index])) throw new Error("这条消息没有指定的视频附件");
    const item = media[index];
    const url = [item.url, item.originalUrl].find(remote);
    if ((item.assetRef || !url) && (!item.size || item.size <= 6 * 1024 * 1024)) {
      request.source = await importAttachment(ctx, input, selected, index, namespace);
    } else if (url) {
      request.source = url; request.source_type = "direct";
    } else {
      throw new Error("宿主暂未开放这个大小的本地附件读取，请提供视频直链或配置本地视频目录");
    }
  } else if (typeof request.source === "string" && !remote(request.source) && !/^(import|watch):/.test(request.source)) {
    const roots = ctx.config?.localVideoRoots || [];
    const result = await call(ctx, "watch_ingest", { action: "local", namespace, source: request.source, roots,
      ...(input.request_id ? { request_id: input.request_id } : {}) });
    request.source = result.source;
  }
  return call(ctx, "watch_start", request);
};
