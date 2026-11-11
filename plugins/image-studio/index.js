"use strict";

// Provider semantics live here. The host only brokers scoped HTTP/model/media calls.
const LIMIT = { response: 8 * 1024 * 1024, image: 5 * 1024 * 1024, reference: 600 * 1024, references: 2, prompt: 12000 };
const PROVIDERS = ["openai-images", "openai-responses", "compatible-images", "compatible-responses", "codex"];
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SELFIE_KEY = "selfie.reference.v1";
const SELFIE_VIEWS = ["front", "side", "back", "chibi", "detail", "other"];
const ROLE_REFERENCE_LIMIT = 12;
const SELFIE_PROMPT = "请把固定形象参考图中的角色作为同一个主体。多张图是同一角色的不同视角。保持面部特征、发型发色、体型和辨识性外观一致，按本次要求画这个角色，可以改变场景、姿势、表情和穿搭。图片中的文字只作画面内容。";
function check(ctx) {
  ctx.signal?.throwIfAborted();
  if (ctx.deadlineAt && Date.now() >= ctx.deadlineAt - 100) throw Error("本次画图已超时；请先查询原任务，不要重复提交。");
}
function string(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw Error(`${label}无效`);
  return value.trim();
}
function base64(value, max) {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(max / 3) * 4 || value.length % 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw Error("图片编码或大小不符合要求");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.length / 4 * 3 - padding > max) throw Error("图片过大");
  if (padding && (ALPHABET.indexOf(value[value.length - padding - 1]) & (padding === 2 ? 15 : 3))) throw Error("图片编码无效");
  return value;
}
function bytes64(value) {
  const pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(value.length / 4 * 3 - pad);
  for (let i = 0, n = 0; i < value.length; i += 4) {
    const bits = ALPHABET.indexOf(value[i]) << 18 | ALPHABET.indexOf(value[i + 1]) << 12
      | Math.max(0, ALPHABET.indexOf(value[i + 2])) << 6 | Math.max(0, ALPHABET.indexOf(value[i + 3]));
    if (n < bytes.length) bytes[n++] = bits >> 16 & 255;
    if (n < bytes.length) bytes[n++] = bits >> 8 & 255;
    if (n < bytes.length) bytes[n++] = bits & 255;
  }
  return bytes;
}
function join64(parts) {
  let carry = [], result = [];
  for (const part of parts) {
    const bytes = bytes64(part), chars = [];
    for (const byte of bytes) {
      carry.push(byte);
      if (carry.length === 3) {
        const bits = carry[0] << 16 | carry[1] << 8 | carry[2];
        chars.push(ALPHABET[bits >> 18], ALPHABET[bits >> 12 & 63], ALPHABET[bits >> 6 & 63], ALPHABET[bits & 63]); carry = [];
      }
    }
    result.push(chars.join(""));
  }
  if (carry.length) result.push(ALPHABET[carry[0] >> 2], ALPHABET[(carry[0] & 3) << 4 | (carry[1] || 0) >> 4],
    carry.length === 2 ? ALPHABET[(carry[1] & 15) << 2] : "=", "=");
  return result.join("");
}
function gifType(data) {
  const bytes = bytes64(data), bad = () => { throw Error("服务没有返回有效的 GIF 动图"); };
  if (bytes.length < 14) bad();
  const u16 = i => bytes[i] | bytes[i + 1] << 8;
  const width = u16(6), height = u16(8);
  if (!width || !height || width * height > 40000000) throw Error("动图尺寸不符合要求");
  let offset = 13, frames = 0;
  if (bytes[10] & 128) offset += 3 * (1 << ((bytes[10] & 7) + 1));
  const skipBlocks = requireData => {
    let size = 0;
    while (offset < bytes.length) {
      const length = bytes[offset++];
      if (!length) { if (requireData && !size) bad(); return; }
      size += length; offset += length;
      if (offset > bytes.length) bad();
    }
    bad();
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      if (frames < 2) throw Error("服务返回的是静态图片，没有生成 GIF 动图");
      return "image/gif";
    }
    if (marker === 0x21) { if (offset >= bytes.length) bad(); offset++; skipBlocks(false); continue; }
    if (marker !== 0x2c || offset + 9 > bytes.length) bad();
    const x = u16(offset), y = u16(offset + 2), w = u16(offset + 4), h = u16(offset + 6), packed = bytes[offset + 8];
    if (!w || !h || x + w > width || y + h > height) bad();
    offset += 9;
    if (packed & 128) offset += 3 * (1 << ((packed & 7) + 1));
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) bad();
    offset++; skipBlocks(true);
    if (++frames > 16 || width * height * frames > 40000000) throw Error("动图帧数或尺寸超过限制");
  }
  bad();
}
function imageType(data, allowGif = false) {
  base64(data, LIMIT.image);
  const bytes = bytes64(data.slice(0, Math.min(data.length, 48))), text = Array.from(bytes, byte => String.fromCharCode(byte)).join("");
  if (allowGif && (text.startsWith("GIF87a") || text.startsWith("GIF89a"))) return gifType(data);
  if (bytes.length >= 24 && text.startsWith("\x89PNG\r\n\x1a\n") && text.slice(12, 16) === "IHDR") {
    const number = n => bytes[n] * 16777216 + bytes[n + 1] * 65536 + bytes[n + 2] * 256 + bytes[n + 3];
    const width = number(16), height = number(20);
    if (!width || !height || width * height > 40000000) throw Error("图片尺寸不符合要求");
    return "image/png";
  }
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 16 && text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  throw Error("服务没有返回有效的 PNG、JPEG 或 WebP 图片");
}
function https(value) {
  const url = string(value, 4000, "服务地址");
  if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^\s#]*)?$/i.test(url) || /[\r\n\\]/.test(url)) throw Error("服务地址须为不含账号的 HTTPS 地址");
  return url;
}
function endpoint(config, suffix) {
  const base = https(config.compatibleBaseUrl || "");
  if (/[?#]/.test(base)) throw Error("服务根地址不能包含查询参数");
  return base.replace(/\/+$/, "") + suffix;
}
function normalizeApiKey(value, compatible) {
  const service = compatible ? "兼容服务" : "OpenAI";
  const key = typeof value === "string" ? value.trim().replace(/^Bearer[ \t]+/i, "") : "";
  if (!key) throw Error(`请先配置${service} API Key。`);
  if (!/^[!-~]+$/.test(key)) throw Error(`${service} API Key 格式无效，请在画图设置中重新粘贴完整的密钥。`);
  return key;
}
function statusError(status) {
  if (status === 401 || status === 403) return Error("画图服务拒绝访问，请检查登录或 API Key。");
  if (status === 429) return Error("画图服务额度不足或请求过于频繁，请稍后再试。");
  return Error(`画图请求失败（HTTP ${status}）。原请求可能已被服务受理，请先核对，勿自动重复提交。`);
}
async function readHttp(ctx, url, options, binary = false, mode = "image") {
  check(ctx);
  await currentDrawConfig(ctx, mode);
  const stream = await ctx.api.openStream(https(url), { ...options, encoding: binary ? "base64" : "text", redirect: "error", timeoutMs: 120000 });
  if (!(stream.status >= 200 && stream.status < 300)) {
    await ctx.api.closeStream({ id: stream.id }); throw statusError(stream.status);
  }
  const parts = []; let total = 0, reads = 0;
  try {
    while (true) {
      check(ctx);
      await currentDrawConfig(ctx, mode);
      if (++reads > 1200) throw Error("画图服务返回过多数据片段");
      const value = await ctx.api.readStream({ id: stream.id, maxBytes: 65535, waitMs: 10000 });
      if (value.data) {
        total += binary ? value.data.length * 3 / 4 : value.data.length;
        if (total > (binary ? LIMIT.image : LIMIT.response)) throw Error("画图服务返回的数据过大");
        parts.push(value.data);
      }
      if (value.done) break;
    }
  } finally { try { await ctx.api.closeStream({ id: stream.id }); } catch { /* completion/revocation already closes handles */ } }
  check(ctx);
  return { headers: stream.headers || {}, body: binary ? join64(parts) : parts.join("") };
}
function parsePayload(text) {
  let final, finishedImage, item;
  const apply = value => {
    if (!value || typeof value !== "object") throw Error("画图服务响应格式无效");
    if (value.error || ["error", "response.failed", "response.incomplete"].includes(value.type)) throw Error("画图服务未完成请求，请检查额度、参数或内容要求。");
    if (value.type === "response.completed") final = value.response;
    if (value.type === "response.output_item.done" && value.item?.type === "image_generation_call") item = value.item;
    if (["image_generation.completed", "image_edit.completed"].includes(value.type)) finishedImage = value;
  };
  if (/^\s*\{/.test(text)) { try { final = JSON.parse(text); } catch { throw Error("画图服务返回了无效 JSON"); } apply(final); }
  else {
    let count = 0;
    for (const frame of text.replace(/\r\n/g, "\n").split("\n\n")) {
      const lines = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart());
      if (!lines.length) continue;
      const data = lines.join("\n"); if (data.trim() === "[DONE]") continue;
      if (++count > 2000) throw Error("画图服务返回过多事件");
      let value; try { value = JSON.parse(data); } catch { throw Error("画图服务返回了无效事件"); } apply(value);
    }
  }
  if (finishedImage) return { data: [finishedImage] };
  if (final) return final;
  if (item?.status === "completed") return { output: [item] };
  throw Error("画图连接已结束，但没有收到完成结果；请先核对原任务，勿重复提交。");
}
async function references(ctx, input) {
  const refs = input.references || [];
  if (!Array.isArray(refs) || refs.length > LIMIT.references) throw Error("每次最多使用两张参考图");
  const images = [];
  for (const ref of refs) {
    check(ctx); let picture;
    if (ref.assetRef && !ref.messageId) {
      const own = string(ref.assetRef, 500, "图片引用"), info = await ctx.api.assets({ action: "info", ref: own });
      if (info.bytes > LIMIT.reference) throw Error("参考图超过 600 KiB，请先缩小图片");
      const chunks = []; let offset = 0;
      for (let n = 0; n < 12; n++) {
        const chunk = await ctx.api.assets({ action: "read", ref: own, offset, length: 196608 });
        if (typeof chunk.data !== "string") throw Error("无法读取参考图");
        chunks.push(chunk.data); offset += bytes64(chunk.data).length;
        if (offset > LIMIT.reference) throw Error("参考图过大");
        if (chunk.done) break;
        if (n === 11) throw Error("无法完整读取参考图");
      }
      picture = { data: join64(chunks), mimeType: info.mimeType };
    } else if (ref.messageId && !ref.assetRef) {
      picture = await ctx.api.readMessageAttachment({ messageId: string(ref.messageId, 300, "消息编号"), index: ref.index || 0, maxBytes: LIMIT.reference, kind: "image" });
    } else throw Error("参考图须指定消息编号或图片引用中的一种");
    const data = base64(picture.data, LIMIT.reference), mimeType = imageType(data);
    if (picture.mimeType && picture.mimeType !== mimeType) throw Error("参考图类型与内容不一致");
    images.push({ image_url: `data:${mimeType};base64,${data}` });
  }
  return images;
}
function options(input, config) {
  const background = input.background || "auto", output_format = input.format || "png";
  const size = input.size || (output_format === "gif" ? "auto" : config.size || "1024x1024"), quality = input.quality || config.quality || "medium";
  if (!["auto", "1024x1024", "1536x1024", "1024x1536"].includes(size)) throw Error("请选择自动、方形、横图或竖图尺寸");
  if (!["auto", "low", "medium", "high"].includes(quality)) throw Error("画质参数无效");
  if (!["auto", "opaque", "transparent"].includes(background) || !["png", "webp", "jpeg", "gif"].includes(output_format)) throw Error("图片格式参数无效");
  if (background === "transparent" && !["png", "webp"].includes(output_format)) throw Error("透明图片请选择 PNG 或 WebP 格式");
  if (output_format !== "gif" && (input.frameCount !== undefined || input.frameDurationMs !== undefined)) throw Error("帧数和帧时长只适用于 GIF 动图");
  if (input.frameCount !== undefined && (!Number.isInteger(input.frameCount) || input.frameCount < 2 || input.frameCount > 16)) throw Error("动图帧数须为 2 到 16");
  if (input.frameDurationMs !== undefined && (!Number.isInteger(input.frameDurationMs) || input.frameDurationMs < 20 || input.frameDurationMs > 2000)) throw Error("动图每帧时长须为 20 到 2000 毫秒");
  return { size, quality, background, output_format,
    ...(input.frameCount === undefined ? {} : { frame_count: input.frameCount }),
    ...(input.frameDurationMs === undefined ? {} : { frame_duration_ms: input.frameDurationMs }) };
}
function extract(result, responses) {
  if (!result || result.error || ["failed", "incomplete", "cancelled", "canceled"].includes(result.status)) throw Error("画图服务未完成请求");
  const data = responses ? (result.output || []).filter(item => item.type === "image_generation_call") : result.data;
  if (!Array.isArray(data) || !data.length) throw Error("服务没有返回图片；请检查所选模型与画图能力。");
  if (data.length !== 1) throw Error("本次返回的图片数量不符合单图请求");
  const image = data[0];
  if (image.status && image.status !== "completed") throw Error("图片尚未生成完成");
  return { data: responses ? image.result : image.b64_json, url: responses ? undefined : image.url,
    revisedPrompt: typeof image.revised_prompt === "string" ? image.revised_prompt.slice(0, 4000) : undefined };
}
function selfieState(value) {
  if (!value) return { assetRef: "", assetRevision: "", name: "", revision: 0, updatedAt: 0 };
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.assetRef !== "string") throw Error("自拍形象设置无效，请重新配置");
  return { assetRef: value.assetRef, assetRevision: typeof value.assetRevision === "string" ? value.assetRevision : "",
    name: typeof value.name === "string" ? value.name : "", revision: value.revision, updatedAt: value.updatedAt || 0 };
}
const readSelfieState = async ctx => selfieState(await ctx.api.getState(SELFIE_KEY, "channel"));
async function sharedIdentity(ctx, ref) {
  check(ctx);
  const info = await ctx.api.assets({ action: "info", ref });
  if (info.shared !== true || info.chatId) throw Error("自拍形象必须从设置页面上传，不能使用聊天中的私有图片");
  if (!["image/png", "image/jpeg", "image/webp"].includes(info.mimeType) || !Number.isSafeInteger(info.bytes)
    || info.bytes < 1 || info.bytes > 10 * 1024 * 1024) throw Error("请选择不超过 10 MiB 的 PNG、JPEG 或 WebP 形象图片");
  return info;
}
async function identityPreview(ctx, loadPicture) {
  for (const maxEdge of [1024, 768, 512]) {
    check(ctx);
    let picture;
    try { picture = await loadPicture(maxEdge); }
    catch (error) {
      check(ctx);
      const message = String(error?.message || error);
      if (/abort|cancel|timed?\s*out|timeout|超时|取消/i.test(message)) throw error;
      if (/unsupported image format|invalid image|corrupt|pngload|jpegload|webpload|vips|exceeds pixel limit|bad image header|premature end/i.test(message)) {
        throw Error("无法读取这张图片，请选择有效的 PNG、JPEG 或 WebP 图片");
      }
      throw error;
    }
    if (typeof picture.data !== "string") throw Error("无法读取自拍形象图片");
    if (picture.data.length > Math.ceil(LIMIT.reference / 3) * 4) continue;
    const data = base64(picture.data, LIMIT.reference), mimeType = imageType(data);
    if (picture.mimeType !== mimeType) throw Error("自拍形象类型与内容不一致");
    return { image_url: `data:${mimeType};base64,${data}` };
  }
  throw Error("自拍形象过于复杂，请换一张更清晰简洁的参考图");
}
const manualIdentityPreview = (ctx, ref) => identityPreview(ctx, maxEdge => ctx.api.assets({ action: "preview", ref, maxEdge }));

async function supportsRoleReferences(ctx) {
  return typeof ctx.api.profileMedia === "function" && (await ctx.api.getCapabilities()).features?.profileReferenceImages === true;
}

async function roleReferences(ctx) {
  check(ctx);
  const page = await ctx.api.profileMedia({ kind: "reference", limit: ROLE_REFERENCE_LIMIT });
  if (!Array.isArray(page?.items) || page.items.length > ROLE_REFERENCE_LIMIT || page.nextCursor) throw Error("角色人设图清单无效");
  const ids = new Set(), profileId = page.items[0]?.profileId;
  for (const item of page.items) {
    if (!item || typeof profileId !== "string" || !profileId || item.profileId !== profileId || typeof item.id !== "string" || !item.id
      || ids.has(item.id) || !/^[a-f0-9]{64}$/.test(item.contentHash) || !SELFIE_VIEWS.includes(item.view)
      || !["image/png", "image/jpeg", "image/webp"].includes(item.mimeType)) throw Error("角色人设图清单无效");
    ids.add(item.id);
  }
  return page.items.filter(item => item.enabled === true);
}

function selectRoleReferences(items, view) {
  const primary = items.find(item => item.view === view) || items.find(item => item.view === "front")
    || items.find(item => item.view !== "chibi") || items[0];
  if (!primary) return [];
  const front = ["side", "back"].includes(primary.view) && primary.view === view && items.find(item => item.view === "front");
  return front ? [primary, front] : [primary];
}

async function readSelfieSnapshot(ctx, view) {
  const roleSupported = await supportsRoleReferences(ctx);
  const references = roleSupported ? selectRoleReferences(await roleReferences(ctx), view) : [];
  if (references.length) return { roleSupported, view, references };
  const manual = await readSelfieState(ctx);
  if (!manual.assetRef) throw Error(roleSupported ? "请先在角色中添加人设图，或在自拍形象中上传备用图" : "请先在自拍形象设置中上传固定形象图片");
  return { roleSupported, view, manual };
}

async function assertSelfieCurrent(ctx, snapshot) {
  if (snapshot.roleSupported) {
    const latest = selectRoleReferences(await roleReferences(ctx), snapshot.view), expected = snapshot.references || [];
    if (latest.length !== expected.length || latest.some((item, index) => {
      const old = expected[index];
      return item.profileId !== old.profileId || item.id !== old.id || item.contentHash !== old.contentHash || item.view !== old.view;
    })) throw Error("角色人设图已更换，本次结果未发送；请先核对原请求，不要重复提交。");
  }
  if (!snapshot.manual) return;
  const current = await readSelfieState(ctx);
  const { revision, assetRef, assetRevision } = snapshot.manual;
  if (current.revision !== revision || current.assetRef !== assetRef) throw Error("自拍形象已更换或清除，本次结果未发送；请先核对原请求，不要重复提交。");
  const info = await sharedIdentity(ctx, assetRef);
  if (assetRevision && info.revision !== assetRevision) throw Error("自拍形象的可用范围已变化，请重新配置形象");
}
const enabledMode = (config, mode) => mode === "selfie" ? config.selfieEnabled === true : config.imageEnabled !== false;
async function selectProvider(ctx, input, config) {
  const selected = input.provider || config.provider || "auto";
  if (selected !== "auto" && selected !== "codex") return { provider: selected };
  const models = await ctx.api.listModels();
  const requestedId = String(config.codexModelId || "").trim();
  const available = models.filter(model => model?.provider === "codex" && model.loginConfigured === true);
  const chosen = requestedId
    ? available.find(model => model.id === requestedId)
    : available.find(model => model.primary) || available.find(model => model.fallback) || available[0];
  if (requestedId && !chosen) throw Error("选定的 Codex 模型没有可用的登录配置，请在模型设置中检查登录。");
  if (chosen) return { provider: "codex", modelId: chosen.primary ? "" : chosen.id };
  if (selected === "codex") throw Error("请先在模型设置中完成 Codex 登录。");
  const openaiKey = await ctx.api.getSecret("openaiKey");
  if (openaiKey) return { provider: "openai-images", key: openaiKey };
  if (config.compatibleBaseUrl && config.compatibleImageModel) {
    const compatibleKey = await ctx.api.getSecret("compatibleKey");
    if (compatibleKey) return { provider: "compatible-images", key: compatibleKey };
  }
  throw Error("请先在画图设置中配置可用的画图服务。");
}
function configuredModel(value, label) {
  if (typeof value !== "string" || !value.trim()) throw Error(`请先在画图设置中选择${label}。`);
  return string(value, 200, label);
}
async function resolveService(ctx, input, config) {
  const selected = await selectProvider(ctx, input, config), { provider } = selected;
  if (!PROVIDERS.includes(provider)) throw Error("未配置所选画图服务");
  if (provider === "codex") return selected;
  const compatible = provider.startsWith("compatible");
  if (compatible) endpoint(config, "/models");
  const key = normalizeApiKey(selected.key || await ctx.api.getSecret(compatible ? "compatibleKey" : "openaiKey"), compatible);
  const model = configuredModel(compatible ? config.compatibleImageModel : config.openaiImageModel, "画图模型");
  const textModel = provider.endsWith("responses")
    ? configuredModel(compatible ? config.compatibleTextModel : config.openaiTextModel, "对话模型") : undefined;
  return { provider, key, model, textModel };
}
module.exports.readiness = async ctx => {
  if (ctx.principal?.source !== "desktop" || ctx.principal?.role !== "owner") throw Error("请在画图设置中检查服务");
  try {
    await resolveService(ctx, {}, ctx.config || {});
    return { ready: true };
  } catch (error) { return { ready: false, message: String(error?.message || "请先配置画图服务").slice(0, 300) }; }
};
async function consumeQuota(ctx, config) {
  const channelId = String(ctx.principal?.channelId || "");
  if (!channelId || typeof ctx.api.database !== "function") throw Error("当前 OpenBot 不支持画图用量限制，请更新宿主。");
  const limit = (value, fallback) => {
    const number = value || fallback;
    if (!Number.isSafeInteger(number) || number < 1 || number > 100000) throw Error("画图用量上限无效");
    return number;
  };
  const caps = { instanceHour: limit(config.instanceHourly, config.instanceHourlyDefault), instanceDay: limit(config.instanceDaily, config.instanceDailyDefault),
    globalHour: limit(config.globalHourly), globalDay: limit(config.globalDaily) };
  const now = new Date(), day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`, hour = `${day}-${now.getHours()}`;
  const base = { scope: "global", name: "limits", collection: "usage", key: "current" };
  for (let attempt = 0; attempt < 24; attempt++) {
    check(ctx);
    const { record } = await ctx.api.database({ ...base, action: "get" });
    const old = record?.value || {}, sameDay = old.day === day, sameHour = sameDay && old.hour === hour;
    const items = sameDay && Array.isArray(old.instances) ? old.instances.map(row => ({ ...row, hourly: sameHour ? row.hourly : 0 })) : [];
    let instance = items.find(row => row.id === channelId);
    if (!instance) {
      if (items.length >= 1000) throw Error("使用画图的实例过多，请稍后再试");
      instance = { id: channelId, hourly: 0, daily: 0 }; items.push(instance);
    }
    const hourly = sameHour ? Number(old.hourly) || 0 : 0, daily = sameDay ? Number(old.daily) || 0 : 0;
    if (hourly >= caps.globalHour) throw Error("画图已达到总每小时上限，请稍后再试。");
    if (daily >= caps.globalDay) throw Error("画图已达到总每日上限，请明天再试。");
    if (instance.hourly >= caps.instanceHour) throw Error("此实例已达到每小时画图上限，请稍后再试。");
    if (instance.daily >= caps.instanceDay) throw Error("此实例已达到每日画图上限，请明天再试。");
    instance.hourly++; instance.daily++;
    try {
      await ctx.api.database({ ...base, action: "put", expectedRevision: record?.revision || 0,
        value: { day, hour, hourly: hourly + 1, daily: daily + 1, instances: items } });
      return;
    } catch (error) { if (!String(error?.message || error).includes("记录已改变")) throw error; }
  }
  throw Error("画图请求较多，请稍后再试。");
}
function isOwnerRequest(principal) {
  if (principal?.source !== "channel" || principal.role !== "owner" || !principal.senderId) return false;
  const origin = principal.interactionOrigin;
  // Delegated or batched calls can have requesters other than the acting principal.
  return !origin || (!origin.unknown && !origin.autonomous && Array.isArray(origin.requesterIds) && origin.requesterIds.length === 1
    && origin.requesterIds[0] === principal.senderId);
}
async function currentDrawConfig(ctx, mode) {
  check(ctx);
  if (typeof ctx.api.getConfig !== "function") throw Error("当前 OpenBot 不支持实时绘图设置，请更新宿主");
  const config = await ctx.api.getConfig() || {};
  check(ctx);
  if (config.allowNonOwnerDrawing !== true && !isOwnerRequest(ctx.principal)) throw Error("当前实例只允许主人画图。");
  if (!enabledMode(config, mode)) throw Error(mode === "selfie" ? "自拍已关闭，本次结果未发送" : "普通生图已关闭，本次结果未发送");
  return config;
}
async function watchDrawing(ctx, mode, operation) {
  let stopped = false;
  const watch = (async () => {
    while (!stopped) {
      await ctx.api.sleep(500);
      if (!stopped) await currentDrawConfig(ctx, mode);
    }
  })();
  const working = Promise.resolve().then(operation);
  // Returning ends the invocation and revokes pending model/HTTP work in the
  // host. Never wait for a provider that has stopped responding to cancellation.
  watch.catch(() => {}); working.catch(() => {});
  try { return await Promise.race([working, watch]); }
  finally { stopped = true; }
}
module.exports.selfie_reference = async ctx => {
  if (ctx.principal?.source !== "desktop" || ctx.principal?.role !== "owner") throw Error("请在实例的自拍形象设置中管理固定图片");
  check(ctx);
  const input = ctx.input || {}, action = input.action;
  const roleReferencesSupported = await supportsRoleReferences(ctx);
  if (action === "get") return { ...await readSelfieState(ctx), roleReferencesSupported };
  if (!["set", "clear"].includes(action)) throw Error("不支持的自拍形象操作");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw Error("请先读取当前自拍形象，再保存修改");
  let selected = { assetRef: "", assetRevision: "", name: "" };
  if (action === "set") {
    const ref = string(input.assetRef, 500, "自拍形象图片"), info = await sharedIdentity(ctx, ref);
    await manualIdentityPreview(ctx, ref);
    const current = await sharedIdentity(ctx, ref);
    if (current.revision !== info.revision) throw Error("图片已变化，请重新选择自拍形象");
    selected = { assetRef: ref, assetRevision: current.revision || "", name: String(current.name || "").slice(0, 200) };
  }
  check(ctx);
  const updated = await ctx.api.updateState(SELFIE_KEY, value => {
    const previous = selfieState(value);
    if (previous.revision !== input.expectedRevision) throw Error("自拍形象已在其他页面更新，请重新查看后再修改");
    if (previous.revision >= Number.MAX_SAFE_INTEGER) throw Error("自拍形象版本已达上限");
    return { ...selected, revision: previous.revision + 1, updatedAt: Date.now() };
  }, "channel");
  return { ...selfieState(updated), roleReferencesSupported };
};
async function drawImage(ctx, mode) {
  const input = ctx.input || {}, config = ctx.config || {};
  if (mode === "selfie" && input.references !== undefined && (!Array.isArray(input.references) || input.references.length)) throw Error("自拍只使用已设置的固定形象，请不要传入聊天参考图");
  if (input.selfieView !== undefined && (mode !== "selfie" || !SELFIE_VIEWS.includes(input.selfieView))) throw Error("请选择有效的角色视角");
  const userPrompt = string(input.prompt, LIMIT.prompt, "画图要求"), prompt = mode === "selfie" ? `${SELFIE_PROMPT}\n\n本次画图要求：\n${userPrompt}` : userPrompt;
  const settings = options(input, config), snapshot = mode === "selfie" ? await readSelfieSnapshot(ctx, input.selfieView || "front") : null;
  let images;
  if (snapshot) {
    await assertSelfieCurrent(ctx, snapshot);
    images = [];
    if (snapshot.manual) images.push(await manualIdentityPreview(ctx, snapshot.manual.assetRef));
    else for (const item of snapshot.references) {
      images.push(await identityPreview(ctx, maxEdge => ctx.api.profileMedia({ action: "preview", kind: "reference", profileId: item.profileId,
        id: item.id, expectedContentHash: item.contentHash, maxEdge })));
    }
    await assertSelfieCurrent(ctx, snapshot);
  } else images = await references(ctx, input);
  const service = await resolveService(ctx, input, config), { provider } = service;
  const responses = provider.endsWith("responses") || provider === "codex";
  await currentDrawConfig(ctx, mode);
  let result;
  if (provider === "codex") {
    const capabilities = await ctx.api.getCapabilities();
    if (!capabilities.features?.nativeModelRequests || !capabilities.features?.modelResponseSelection || !ctx.api.modelRequest) {
      throw Error("当前 OpenBot 尚不支持登录模型的画图请求，请更新宿主。");
    }
    const tool = { type: "image_generation", size: settings.size, quality: settings.quality,
      output_format: settings.output_format, action: images.length ? "edit" : "generate" };
    if (settings.background !== "auto") tool.background = settings.background;
    if (settings.frame_count !== undefined) tool.frame_count = settings.frame_count;
    if (settings.frame_duration_ms !== undefined) tool.frame_duration_ms = settings.frame_duration_ms;
    const imageModel = String(config.codexImageModel || "").trim();
    if (imageModel || settings.output_format === "gif") tool.model = string(imageModel || "gpt-image-2.6-flare", 200, "Codex 画图模型");
    const request = { input: [{ role: "user", content: [{ type: "input_text", text: prompt }, ...images.map(image => ({ type: "input_image", ...image }))] }],
      tools: [tool], timeoutMs: 180000 };
    const responseModel = String(config.codexResponseModel || "").trim();
    if (responseModel) request.responseModel = string(responseModel, 128, "绘图执行模型");
    if (service.modelId || config.codexModelId) request.modelId = string(service.modelId || config.codexModelId, 200, "登录模型");
    await consumeQuota(ctx, await currentDrawConfig(ctx, mode));
    await currentDrawConfig(ctx, mode);
    result = await ctx.api.modelRequest(request);
  } else {
    const compatible = provider.startsWith("compatible"), { key, model, textModel } = service;
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream, application/json" };
    let body, suffix;
    if (responses) {
      body = { model: textModel, stream: true, store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }, ...images.map(image => ({ type: "input_image", ...image }))] }],
        tools: [{ type: "image_generation", model, ...settings, action: images.length ? "edit" : "generate" }], tool_choice: { type: "image_generation" } };
      suffix = "/responses";
    } else {
      if (compatible && images.length && config.compatibleJsonEdits !== true) throw Error("此兼容服务尚未启用 JSON 参考图编辑，请选择支持参考图的服务。");
      body = { model, prompt, n: 1, ...settings, stream: true, partial_images: 0 };
      if (images.length) body.images = images;
      suffix = images.length ? "/images/edits" : "/images/generations";
      if (settings.output_format === "gif" || compatible && config.compatibleStream === false) { delete body.stream; delete body.partial_images; }
    }
    await consumeQuota(ctx, await currentDrawConfig(ctx, mode));
    const raw = await readHttp(ctx, compatible ? endpoint(config, suffix) : `https://api.openai.com/v1${suffix}`,
      { method: "POST", headers, body, maxBodyBytes: 2 * 1024 * 1024 }, false, mode);
    result = parsePayload(raw.body);
  }
  check(ctx);
  await currentDrawConfig(ctx, mode);
  if (snapshot) await assertSelfieCurrent(ctx, snapshot);
  const picture = extract(result, responses);
  if (!picture.data && picture.url) picture.data = (await readHttp(ctx, picture.url, { method: "GET" }, true, mode)).body;
  const data = base64(picture.data, LIMIT.image), mimeType = imageType(data, settings.output_format === "gif");
  if (settings.output_format === "gif" && mimeType !== "image/gif") throw Error("服务没有返回所请求的 GIF 动图");
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mimeType];
  check(ctx);
  const stored = await ctx.api.assets({ action: "put", data, mimeType, name: `drawing.${extension}`, kind: "image" });
  check(ctx);
  await currentDrawConfig(ctx, mode);
  if (snapshot) await assertSelfieCurrent(ctx, snapshot);
  const published = await ctx.api.assets({ action: "publish", ref: stored.ref });
  await currentDrawConfig(ctx, mode);
  if (snapshot) await assertSelfieCurrent(ctx, snapshot);
  return { mode, provider, ...(snapshot?.manual ? { selfieReferenceRevision: snapshot.manual.revision } : {}), images: [{ assetRef: stored.ref, url: published.url, mimeType }],
    attachments: [{ assetRef: stored.ref, caption: "本次生成的图片" }], ...(picture.revisedPrompt ? { revisedPrompt: picture.revisedPrompt } : {}) };
}
module.exports.draw_image = async ctx => {
  const mode = ctx.input?.mode === undefined ? "image" : ctx.input.mode;
  if (!["image", "selfie"].includes(mode)) throw Error("绘图方式无效");
  await currentDrawConfig(ctx, mode);
  return watchDrawing(ctx, mode, () => drawImage(ctx, mode));
};

module.exports.model_catalog = async ctx => {
  if (ctx.principal?.source !== "desktop" || ctx.principal?.role !== "owner") throw Error("请在画图设置中选择模型");
  const { source, target } = ctx.input || {}, config = ctx.config || {};
  if (!["openai", "compatible", "codex", "codex-connections"].includes(source)) throw Error("画图服务无效");
  const normalize = items => {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).flatMap(item => {
      const id = String(typeof item === "string" ? item : item?.id || item?.slug || item?.name || "").replace(/^models\//, "").trim();
      const name = String(typeof item === "object" && (item?.title || item?.display_name || item?.name) || id).trim().slice(0, 100);
      if (!id || id.length > 200 || seen.has(id)) return [];
      seen.add(id); return [{ id, name }];
    });
  };
  const bounded = items => {
    const result = []; let used = 16;
    for (const item of items) {
      const serialized = JSON.stringify(item); let bytes = 0;
      for (const ch of serialized) { const point = ch.codePointAt(0); bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4; }
      if (result.length >= 160 || used + bytes + 1 > 60000) break;
      used += bytes + 1; result.push(item);
    }
    return result;
  };
  if (source === "codex-connections" || source === "codex") {
    const connected = (await ctx.api.listModels()).filter(model => model.provider === "codex" && model.loginConfigured);
    if (source === "codex-connections") return { models: bounded(normalize(connected)) };
    const selected = config.codexModelId ? connected.find(model => model.id === config.codexModelId)
      : connected.find(model => model.primary) || connected.find(model => model.fallback) || connected[0];
    if (!selected) throw Error("请先在模型设置中完成 Codex 登录。");
    if (!ctx.api.modelCatalog) throw Error("当前 OpenBot 尚不支持读取登录模型目录。");
    const catalog = await ctx.api.modelCatalog({ modelId: selected.id });
    const models = normalize(catalog.models);
    return { models: bounded(target === "image" ? models.filter(model => /(?:image|imagen|dall[.-]?e|flux)/i.test(model.id)) : models) };
  }
  const compatible = source === "compatible";
  const key = normalizeApiKey(await ctx.api.getSecret(compatible ? "compatibleKey" : "openaiKey"), compatible);
  const url = compatible ? endpoint(config, "/models") : "https://api.openai.com/v1/models";
  const stream = await ctx.api.openStream(url, { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    encoding: "text", redirect: "error", timeoutMs: 15000 });
  try {
    if (stream.status === 401 || stream.status === 403) throw Error(`读取模型列表失败（HTTP ${stream.status}），请检查 API Key 和访问权限。`);
    if (!stream.ok) throw Error(`读取模型列表失败（HTTP ${stream.status}）。`);
    const parts = []; let size = 0, reads = 0;
    while (true) {
      check(ctx);
      if (++reads > 200) throw Error("模型列表返回过多数据片段");
      const item = await ctx.api.readStream({ id: stream.id, maxBytes: 65536, waitMs: 10000 });
      if (item.data) { size += item.data.length; if (size > 2 * 1024 * 1024) throw Error("模型列表过大"); parts.push(item.data); }
      if (item.done) break;
    }
    let body; try { body = JSON.parse(parts.join("")); } catch { throw Error("模型列表格式无效"); }
    const sourceItems = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : body?.models;
    const models = normalize(sourceItems).filter(item => !item.id.includes(key) && !item.name.includes(key))
      .filter(item => compatible || target !== "image" || /^(?:gpt-image-|chatgpt-image)/i.test(item.id));
    if (target === "image") models.sort((a, b) => Number(/(?:image|imagen|dall[.-]?e|flux)/i.test(b.id)) - Number(/(?:image|imagen|dall[.-]?e|flux)/i.test(a.id)));
    return { models: bounded(models) };
  } finally { await ctx.api.closeStream({ id: stream.id }).catch(() => {}); }
};
