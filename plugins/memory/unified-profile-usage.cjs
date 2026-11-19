"use strict";
const { get, put } = require("./unified-state.cjs");
const { admit } = require("./unified-material-policy.cjs");
const { factProjection } = require("./lib/features/channels/channel-memory-write.cjs");

const key = scope => `plus:profile-usage:${scope.chatId}`;
const stickerMarker = /\[(?:动画表情|表情包|商城表情|贴纸)\]/u;
const mediaMarker = /\[(?:图片|动画表情|表情包|商城表情|贴纸|表情|image|sticker)\]/giu;
const MIN_SPAN = 30 * 60000, WINDOW = 30 * 86400000, MAX_PATTERNS = 128, MAX_REFS = 6;
const human = item => item && item.direction === "in" && !item.sender?.isBot && item.sender?.id && !item.forwarded
  && admit(item) && !/\[(?:合并转发|转发消息)\]/u.test(item.content);
function stickerId(attachment, source) {
  if (attachment.type !== "image" || attachment.sticker === false) return "";
  if (attachment.sticker !== true && !(stickerMarker.test(source.content) && source.attachments.filter(a => a.type === "image").length === 1)) return "";
  const digest = /^([a-f0-9]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(attachment.name || "");
  return digest ? `file:${digest[1].toLowerCase()}` : String(attachment.mediaKey || "").slice(0, 240);
}
function label(value) {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/^\[|\]$/gu, "");
  return text && text.length <= 40 && !/[\u0000-\u001f<>]|https?:\/\/|[a-f0-9]{24}|(?:api.?key|password|token)\s*[:=]|(?:sk|sess)-[\w-]{16}|\d{6,}/iu.test(text)
    && !/^(?:一张|同一张)?(?:图片|动画表情|表情包?|商城表情|贴纸|image|sticker)$/iu.test(text) ? text : "";
}
function save(storage, scope, entries) { if (entries) put(storage, key(scope), entries); }

async function collect(ctx, storage, scope, materials, suggestions = [], after = 0) {
  const entries = new Map(get(storage, key(scope), []).map(entry => [entry.key, entry]));
  const touched = new Set(), cache = new Map(), records = [];
  function observe(message, type, value, title, index) {
    const subject = String(message.sender.id), k = JSON.stringify([subject, type, value]);
    const old = entries.get(k), ref = { id: message.id, version: message.version, at: message.createdAt, seq: message.seq, index, title };
    if (!ref.id || !ref.version || !Number.isFinite(ref.at) || !(ref.at > 0) || !Number.isSafeInteger(ref.seq) || ref.seq <= after) return;
    const cutoff = Math.max(ref.at, old?.refs.at(-1)?.at || 0) - WINDOW;
    if (ref.at < cutoff) return;
    const refs = (old?.refs || []).filter(r => r.seq > after && r.id !== ref.id && r.at >= cutoff);
    refs.push(ref); refs.sort((a, b) => a.at - b.at);
    entries.delete(k);
    entries.set(k, { key: k, subject, type, value, published: old?.published === true,
      refs: refs.length <= MAX_REFS ? refs : [refs[0], ...refs.slice(1 - MAX_REFS)] });
    touched.add(k);
  }
  async function read(ref) {
    const cached = cache.get(ref.id);
    if (cached?.version === ref.version) return cached;
    ctx.signal.throwIfAborted();
    const page = await ctx.api.sources({ action: "read", chatId: scope.chatId, id: ref.id, version: ref.version, limit: 4000 });
    ctx.signal.throwIfAborted();
    const item = page?.item;
    if (!page?.revoked && human(item) && item.id === ref.id && item.version === ref.version) { cache.set(ref.id, item); return item; }
  }
  let lookups = 0;
  for (const item of materials) {
    if (!human(item) || item.chatId && item.chatId !== scope.chatId) continue;
    const proposed = suggestions.filter(hint => hint?.messageId === item.id);
    for (const hint of proposed) {
      const phrase = hint.expression;
      if (hint.type === "expression" && typeof phrase === "string" && phrase.trim() === phrase && phrase.length >= 2 && phrase.length <= 32
        && label(phrase) && !/[\[\]]/u.test(phrase) && item.content.includes(phrase)) observe(item, "expression", phrase, phrase);
    }
    let source = item;
    if (!Array.isArray(item.attachments)) {
      if (!ctx.api.sources || !(stickerMarker.test(item.content) || proposed.some(hint => hint.type === "sticker")) || lookups >= 48) continue;
      lookups++; source = await read(item);
    }
    if (!source?.attachments) continue;
    for (const attachment of source.attachments) {
      const id = stickerId(attachment, source);
      if (!id) continue;
      const hint = proposed.find(value => value.type === "sticker" && value.index === attachment.index);
      observe(item, "sticker", id, label(attachment.description) || label(hint?.label), attachment.index);
    }
  }
  for (const k of touched) {
    const entry = entries.get(k);
    if (entry.published || entry.refs.length < 3 || records.length >= 8
      || entry.refs.at(-1).at - entry.refs[0].at < MIN_SPAN || !ctx.api.sources) continue;
    const sources = [], valid = [], titles = new Map(), captions = new Map();
    let image, title = "";
    for (const ref of entry.refs) {
      const item = await read(ref);
      if (!item || String(item.sender.id) !== entry.subject) continue;
      if (entry.type === "sticker") {
        const attachment = (item.attachments || []).find(a => a.index === ref.index && stickerId(a, item) === entry.value);
        if (!attachment) continue;
        title ||= label(attachment.description);
        if (ref.title) titles.set(ref.title, (titles.get(ref.title) || 0) + 1);
        const caption = item.content.replace(mediaMarker, "").trim();
        if (caption.length >= 2 && caption.length <= 20 && label(caption) && !/[\[\]「」“”@]/u.test(caption)) {
          const first = captions.get(caption);
          captions.set(caption, { first: first?.first ?? ref.at, last: ref.at });
        }
        if (attachment.previewAvailable || !image) image = { chatId: scope.chatId, id: ref.id, version: ref.version, index: ref.index };
      } else if (!item.content.includes(entry.value)) continue;
      sources.push({ chatId: scope.chatId, id: ref.id, version: ref.version, quote: entry.type === "sticker" ? item.content.slice(0, 100) : entry.value });
      valid.push(ref);
    }
    entry.refs = valid;
    if (valid.length < 3 || valid.at(-1).at - valid[0].at < MIN_SPAN) continue;
    const sticker = entry.type === "sticker";
    title ||= [...titles].find(([, count]) => count >= 2)?.[0] || "";
    const caption = [...captions].find(([, times]) => times.last - times.first >= MIN_SPAN)?.[0];
    const content = sticker ? `常用${title ? "「" + title + "」这张表情" : "这张表情"}${caption ? "，常和「" + caption + "」一起发" : ""}。`
      : `常用「${entry.value}」这个表达。`;
    const fact = factProjection({ subjectId: entry.subject, facet: sticker ? "常用表情" : "惯用表达", value: entry.value, assertion: "observed" }, content);
    records.push({ content, category: "profile", kind: "fact", tier: "working", status: "active", subjectRefs: [entry.subject], sources,
      attributes: { fact, ...(image ? { sourceImages: [image] } : {}),
        profile: { section: sticker ? "habits" : "communication", basis: "observed_use", usage: entry.type },
        retention: { version: 1, basis: "stable", reason: "理解这位成员在本聊天中反复使用的表达方式。", protected: false, observedAt: valid.at(-1).at } } });
    entry.published = true;
  }
  return { records, entries: touched.size ? [...entries.values()].slice(-MAX_PATTERNS) : undefined };
}
module.exports = { collect, save, stickerId, mediaOnly: quote => typeof quote === "string" && !quote.replace(mediaMarker, "").trim() };
