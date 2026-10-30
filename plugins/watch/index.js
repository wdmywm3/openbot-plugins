"use strict";

const START_FIELDS = new Set(["source", "source_type", "message_id", "attachment_index", "start_seconds", "end_seconds", "frame_count", "sampling", "timestamps", "crop", "request_id", "mode", "tab_id", "media_id", "audio", "detail"]);
const MEDIA = /\.(mp4|mkv|webm|mov|avi|m4v|flv|wmv|mpg|mpeg|ts|m2ts|ogv|3gp|3g2|mp3|m4a|wav|ogg|opus|flac|aac|aiff|aif)$/i;
const remote = source => typeof source === "string" && /^https?:\/\//i.test(source);
const permissionFailure = error => /授权|审核|权限|撤销|不属于|未声明|禁止|permission|revoked|denied/i.test(String(error.message || ""));
const video = item => ["video", "audio"].includes(item?.type) || /^(video|audio)\//i.test(item?.mimeType || item?.mediaType || "")
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
  if (!video(original) || !["file", "video", "audio"].includes(attachment.type) || !Number.isInteger(attachment.size) || attachment.size <= 0
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

async function upload(ctx, namespace, kind, sourceId, media, requestId) {
  if (!Number.isInteger(media.size) || media.size <= 0 || typeof media.data !== "string") throw new Error("页面媒体结果无效");
  const begin = await call(ctx, "watch_ingest", { action: "begin", namespace, kind, name: kind === "image" ? "frame.jpg" : "audio.webm",
    source_id: sourceId.slice(0, 300), size: media.size, ...(requestId ? { request_id: requestId } : {}) });
  if (begin.result) return begin.result.asset_id;
  let offset = begin.offset;
  if (!Number.isInteger(offset) || offset < 0 || offset > media.size || offset < media.size && offset % 3) throw new Error("页面媒体导入进度无效");
  while (offset < media.size) {
    const result = await call(ctx, "watch_ingest", { action: "append", namespace, upload_id: begin.upload_id, offset,
      base64: media.data.slice(offset / 3 * 4, offset / 3 * 4 + 48000) });
    if (!Number.isInteger(result.offset) || result.offset <= offset || result.offset > media.size) throw new Error("页面媒体导入未前进");
    offset = result.offset;
  }
  return (await call(ctx, "watch_ingest", { action: "finish", namespace, upload_id: begin.upload_id })).asset_id;
}

async function browserStart(ctx, request, options, namespace) {
  if (!ctx.api.browserMedia) throw new Error("在线读取需要 OpenBot 0.1.78 或更新版本");
  // Validate plugin-owned parameters before opening a page; duration is refined below.
  await call(ctx, "watch_browser", { action: "plan", namespace, request, duration: 7200 });
  const opened = options.tab_id ? { tabId: options.tab_id } : await ctx.api.browserMedia({ action: "open", url: request.source });
  let listed, candidates;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { listed = await ctx.api.browserMedia({ action: "inspect", tabId: opened.tabId }); }
    catch (error) {
      ctx.signal?.throwIfAborted();
      if (options.media_id || attempt >= 9 || error.code !== "BROWSER_MEDIA_STALE") throw error;
      if (ctx.api.sleep) await ctx.api.sleep(500); continue;
    }
    candidates = (listed.media || []).filter(m => ["video", "audio"].includes(m.kind) && m.duration > 0 && m.readyState >= 2);
    if (candidates.length) break;
    if (attempt < 9 && ctx.api.sleep) await ctx.api.sleep(500);
  }
  if (!candidates.length) throw new Error("页面尚未出现可读取的视频，请先在内置浏览器打开播放器或完成登录");
  if (!remote(listed.url)) throw new Error("播放器没有有效的页面来源");
  if (options.tab_id) {
    const expected = await call(ctx, "watch_browser", { action: "plan", namespace, request, duration: 7200 });
    const actual = await call(ctx, "watch_browser", { action: "plan", namespace, request: { ...request, source: listed.url }, duration: 7200 });
    if (expected.request.source !== actual.request.source) throw new Error("页面已变化，地址与本次视频来源不一致");
  }
  request.source = listed.url;
  // The host may refresh media IDs when inspecting; an explicitly selected stale ID is not silently replaced.
  const visible = candidates.filter(m => m.visible).sort((a, b) => b.width * b.height - a.width * a.height);
  const pool = visible.length ? visible : candidates, playing = pool.filter(m => m.paused === false);
  let selected = options.media_id ? candidates.find(m => m.id === options.media_id)
    : playing.length === 1 ? playing[0] : pool.length === 1 ? pool[0]
    : pool[0].width * pool[0].height > 0 && pool[0].width * pool[0].height >= 2 * pool[1].width * pool[1].height ? pool[0] : null;
  if (!selected && !options.media_id) {
    const error = new Error(`页面有多个播放器，请按问题选择后带上 tab_id 和 media_id：${JSON.stringify({ tab_id: opened.tabId, media: pool.slice(0, 6).map(m => ({ media_id: m.id, duration: m.duration, width: m.width, height: m.height })) })}`);
    error.code = "WATCH_MEDIA_SELECTION"; throw error;
  }
  if (!selected) throw new Error("指定播放器已变化，请重新读取页面并选择播放器");
  const target = { tabId: opened.tabId, mediaId: selected.id };
  const planned = await call(ctx, "watch_browser", { action: "plan", namespace, request, duration: selected.duration });
  const captions = await ctx.api.browserMedia({ action: "captions", ...target, start: planned.start, end: planned.end });
  // A quiet focus interval is not a missing caption track. Older hosts return
  // only range-filtered cues, so inspect bounded ranges if they advertise tracks.
  let trackAvailable = Boolean(captions.track_available || captions.segments?.length);
  if (!trackAvailable && selected.tracks?.some(t => ["captions", "subtitles"].includes(t.kind))) {
    for (let start = 0; start < selected.duration && !trackAvailable; start += 600) {
      ctx.signal?.throwIfAborted();
      const track = await ctx.api.browserMedia({ action: "captions", ...target, start, end: Math.min(start + 600, selected.duration) });
      trackAvailable = Boolean(track.track_available || track.segments?.length);
    }
  }
  captions.track_available = trackAvailable;
  const frames = [], audio = [], warnings = [];
  const visual = selected.kind === "video" && (request.detail !== "transcript" || request.timestamps?.length);
  for (const seconds of visual ? planned.points : []) {
    ctx.signal?.throwIfAborted();
    let frame;
    try { frame = await ctx.api.browserMedia({ action: "frame", ...target, seconds }); }
    catch (error) { ctx.signal?.throwIfAborted(); if (permissionFailure(error) || error.code === "BROWSER_MEDIA_STALE") throw error;
      warnings.push(`${seconds} 秒画面读取失败：${String(error.message || "").slice(0, 150)}`); continue; }
    if (!Number.isFinite(frame.timestamp) || frame.timestamp < planned.start - 0.1 || frame.timestamp >= planned.end) {
      warnings.push(`没有取得 ${seconds} 秒附近、位于本次范围内的画面`); continue;
    }
    frames.push({ asset_id: await upload(ctx, namespace, "image", `${opened.tabId}:frame:${seconds}`, frame, request.request_id),
      requested: seconds, timestamp: frame.timestamp, view: frame.view });
  }
  if (visual && !frames.length) warnings.push("播放器未返回所选区间内的画面");
  if (!trackAvailable && options.audio !== "off") {
    const info = await call(ctx, "watch_info", {});
    const available = info.asr?.can_prepare || info.asr?.model_available && info.asr?.runtime_available && info.asr?.backend !== "none";
    if (!available && options.audio === "required") warnings.push("本地转写尚未启用或依赖不完整，无法满足所请求的语音读取");
    if (available) {
      for (let start = planned.start; start < planned.end - 0.2;) {
        ctx.signal?.throwIfAborted();
        let clip;
        try { clip = await ctx.api.browserMedia({ action: "audio", ...target, start, seconds: Math.min(20, planned.end - start) }); }
        catch (error) { ctx.signal?.throwIfAborted(); if (options.audio === "required" || permissionFailure(error)) throw error;
          warnings.push(`部分页面音频不可用：${String(error.message || "").slice(0, 150)}`); break; }
        if (!(clip.end > clip.start) || clip.start < start - 0.3 || clip.start > start + 0.5) throw new Error("页面音频时间不一致");
        audio.push({ asset_id: await upload(ctx, namespace, "audio", `${opened.tabId}:audio:${start}`, clip, request.request_id),
          start: clip.start, end: clip.end, leadSeconds: clip.leadSeconds });
        start = clip.end;
      }
    } else warnings.push("没有可用字幕，且本地转写未启用或依赖不完整");
  }
  return call(ctx, "watch_browser", { action: "finish", namespace, request,
    info: { duration: selected.duration, kind: selected.kind, title: listed.title, tab_id: opened.tabId, media_id: selected.id, frames, audio, captions, warnings } });
}

module.exports.watch_start = async ctx => {
  const input = ctx.input || {};
  if (Object.keys(input).some(key => !START_FIELDS.has(key)) || Boolean(input.source) === Boolean(input.message_id))
    throw new Error("请提供视频来源或消息编号，二者选择一个");
  if (!input.message_id && input.attachment_index !== undefined) throw new Error("附件序号需要与消息编号一起使用");
  const namespace = ctx.plugin?.scopeNamespace;
  if (typeof namespace !== "string" || !/^[a-f0-9]{64}$/.test(namespace)) throw new Error("当前宿主没有提供视频读取范围，请更新宿主");
  const { message_id, attachment_index, mode = "auto", tab_id, media_id, audio = "auto", ...request } = input;
  if (!["auto", "browser", "download"].includes(mode) || !["auto", "off", "required"].includes(audio)) throw new Error("视频读取方式无效");
  if (input.audio !== undefined) request.audio = audio;
  let options = { mode, tab_id, media_id, audio };
  if (/^watch:[a-f0-9]{32}$/.test(request.source || "")) {
    const prior = await call(ctx, "watch_browser", { action: "source", namespace, job_id: request.source.slice(6) });
    if (prior.browser) {
      request.source = prior.source;
      request.start_seconds ??= prior.start_seconds; request.end_seconds ??= prior.end_seconds;
      options = { ...options, mode: "browser", tab_id: prior.tab_id, media_id: prior.media_id };
    }
  }
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
  const page = remote(request.source) && request.source_type !== "direct" && !MEDIA.test(request.source.split(/[?#]/)[0]);
  if (options.mode === "browser" || options.mode === "auto" && page && ctx.api.browserMedia) {
    try { return await browserStart(ctx, request, options, namespace); }
    catch (error) {
      ctx.signal?.throwIfAborted();
      // Permission denial, changed pages, and explicit browser requests never fall through.
      const denied = permissionFailure(error);
      if (options.mode === "browser" || denied || ["BROWSER_MEDIA_STALE", "WATCH_MEDIA_SELECTION"].includes(error.code) || /页面已变化|播放器已变化/.test(error.message || "")) throw error;
      const result = await call(ctx, "watch_start", request);
      return { ...result, notice: "内置浏览器未取得完整资料，已转为下载读取", browser_reason: String(error.message || "").slice(0, 250) };
    }
  }
  return call(ctx, "watch_start", request);
};

module.exports.watch_zoom = async ctx => {
  const input = ctx.input || {}, namespace = ctx.plugin?.scopeNamespace;
  if (Object.keys(input).some(k => !["job_id", "cell_id", "frame_count", "crop", "request_id"].includes(k))) throw new Error("补看参数无效");
  const prior = await call(ctx, "watch_browser", { action: "source", namespace, job_id: input.job_id, cell_id: input.cell_id });
  if (!prior.browser) return call(ctx, "watch_zoom", input);
  return module.exports.watch_start({ ...ctx, input: { source: prior.source, mode: "browser", tab_id: prior.tab_id, media_id: prior.media_id,
    start_seconds: prior.start_seconds, end_seconds: prior.end_seconds, frame_count: input.frame_count || 6,
    ...(input.crop ? { crop: input.crop } : {}), ...(input.request_id ? { request_id: input.request_id } : {}) } });
};
