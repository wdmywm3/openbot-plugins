"use strict";
const { admit } = require("./unified-material-policy.cjs");
const { factProjection } = require("./lib/features/channels/channel-memory-write.cjs");

const stickerMarker = /\[(?:动画表情|表情包|商城表情|贴纸)\]/u;
const mediaMarker = /\[(?:图片|动画表情|表情包|商城表情|贴纸|表情|image|sticker)\]/giu;
const { DAY, OBSERVATION_WINDOW: WINDOW, occasions } = require("./lib/features/channels/channel-member-memory-proof.cjs");
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
const mediaOnly = quote => typeof quote === "string" && !quote.replace(mediaMarker, "").trim();
function expression(value) {
  return typeof value === "string" && value.length >= 2 && value.length <= 32 && label(value) === value && !/[\[\]]/u.test(value);
}
function record(scope, subject, signal, messages) {
  const sticker = signal.startsWith("sticker:"), value = signal.slice(signal.indexOf(":") + 1);
  if (!sticker && (!signal.startsWith("expression:") || !expression(value))) return;
  const sources = [], times = [], titles = new Map(), captions = new Map();
  let image, title = "";
  for (const item of messages) {
    if (!human(item) || item.chatId !== scope.chatId || String(item.sender.id) !== subject || sources.some(s => s.id === item.id)) continue;
    if (sticker) {
      const attachment = (item.attachments || []).find(a => stickerId(a, item) === value);
      if (!attachment) continue;
      title ||= label(attachment.description);
      if (item.observedLabel) titles.set(item.observedLabel, (titles.get(item.observedLabel) || 0) + 1);
      const caption = item.content.replace(mediaMarker, "").trim();
      if (caption.length >= 2 && caption.length <= 20 && label(caption) && !/[\[\]「」“”@]/u.test(caption)) {
        if (!captions.has(caption)) captions.set(caption, []);
        captions.get(caption).push({ at: item.createdAt });
      }
      if (attachment.previewAvailable || !image) image = { chatId: scope.chatId, id: item.id, version: item.version, index: attachment.index };
    } else if (!item.content.includes(value)) continue;
    times.push({ at: item.createdAt });
    sources.push({ chatId: scope.chatId, id: item.id, version: item.version, quote: sticker ? item.content.slice(0, 100) : value });
  }
  if (occasions(times).length < 3) return;
  title ||= [...titles].find(([, count]) => count >= 2)?.[0] || "";
  const caption = [...captions].find(([, refs]) => occasions(refs).length >= 2)?.[0];
  const content = sticker ? "常用" + (title ? "「" + title + "」这张表情" : "这张表情") + (caption ? "，常和「" + caption + "」一起发" : "") + "。"
    : "常用「" + value + "」这个表达。";
  const fact = factProjection({ subjectId: subject, facet: sticker ? "常用表情" : "惯用表达", value, assertion: "observed" }, content);
  return { content, category: "profile", kind: "fact", tier: "working", status: "active", subjectRefs: [subject], sources,
    attributes: { fact, ...(image ? { sourceImages: [image] } : {}),
      profile: { section: sticker ? "habits" : "communication", basis: "observed_use", usage: sticker ? "sticker" : "expression" },
      retention: { version: 1, basis: "stable", reason: "理解这位成员在本聊天中反复使用的表达方式。", protected: false, observedAt: Math.max(...times.map(r => r.at)) } } };
}
function addRecord(record, history, operations, before, writable) {
  const matches = history.filter(old => old.subjectRefs?.includes(record.subjectRefs[0]) && old.attributes?.profile?.usage === record.attributes.profile.usage
    && (old.attributes?.fact?.value ? old.attributes.fact.value === record.attributes.fact.value : old.sources?.some(s => record.sources.some(r => r.id === s.id))));
  if (matches.some(old => !writable(old))) return;
  const old = matches.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!old) { operations.push({ action: "create", record }); before.push(null); return; }
  if (record.attributes.retention.observedAt < (old.attributes?.retention?.observedAt || 0)
    || old.content === record.content && record.sources.every(s => old.sources?.some(r => r.id === s.id && r.version === s.version))) return;
  // Keep current proof bounded and readable. Earlier sends remain in the revision history.
  operations.push({ action: "revise", id: old.id, expectedRevision: old.revision, changeType: "edit", patch: {
    content: record.content, sources: record.sources, status: "active",
    attributes: { ...old.attributes, ...record.attributes, profile: { ...old.attributes.profile, ...record.attributes.profile } } } });
  before.push({ id: old.id, revision: old.revision });
}
module.exports = { DAY, WINDOW, human, stickerId, label, expression, occasions, record, mediaOnly, addRecord };
