"use strict";
const { open, hash } = require("./storage.cjs");
const { normalizeDreamSettings } = require("./lib/features/channels/channel-dream-settings.cjs");
function current(ctx) {
  const chatId = String(ctx.message?.chatId || ctx.input?.chatId || "");
  if (ctx.message?.chatId && ctx.input?.chatId && ctx.input.chatId !== ctx.message.chatId) throw Error("只能操作当前聊天");
  return { storage: open(ctx.dataRoot), scope: { channelId: ctx.principal.channelId || ctx.plugin.namespace, chatId } };
}
const get = (storage, key, fallback = null) => {
  const row = storage.db.prepare("SELECT value_json FROM plugin_meta WHERE key=?").get(key);
  return row ? JSON.parse(row.value_json) : fallback;
};
const put = (storage, key, value) => { storage.db.prepare("INSERT OR REPLACE INTO plugin_meta VALUES(?,?)").run(key, JSON.stringify(value)); return value; };
function defaults(storage, scope) {
  const saved = get(storage, `plus:defaults:${scope.channelId}`); if (saved) return normalizeDreamSettings(saved);
  const old = storage.db.prepare("SELECT * FROM channel_dream_meta WHERE key=?").get(`settings:${scope.channelId}`);
  return normalizeDreamSettings(old ? JSON.parse(old.value_json || old.value || "{}") : {});
}
function state(storage, scope) {
  let value = get(storage, `plus:state:${scope.chatId}`);
  if (!value) {
    const row = storage.db.prepare("SELECT value_json FROM channel_dream_state WHERE channel_id=? AND chat_id=?").get(scope.channelId, scope.chatId);
    const old = row ? JSON.parse(row.value_json) : {};
    value = { cursor: 0, settingsOverride: old.settingsOverride || null, style: old.style || null, styleLocked: !!old.styleLocked,
      lastRun: old.lastRun || 0, nextRun: 0, job: null };
  }
  return { ...value, settings: normalizeDreamSettings(value.settingsOverride || {}, defaults(storage, scope)) };
}
function save(storage, scope, patch) {
  const { settings, ...value } = { ...state(storage, scope), ...patch };
  return put(storage, `plus:state:${scope.chatId}`, value);
}
async function readMemory(ctx, scope, id, { revision, historical = false, complete = true } = {}) {
  let item = (await ctx.api.memory({ action: "read", chatId: scope.chatId, id, ...(revision ? { revision } : {}), mode: historical ? "history" : "current", limit: 32000 })).item;
  if (!item || !complete) return item;
  let content = item.content, offset = item.nextOffset;
  while (offset !== null && offset !== undefined) {
    ctx.signal.throwIfAborted();
    const page = (await ctx.api.memory({ action: "read", chatId: scope.chatId, id, revision: item.revision, offset, limit: 32000 })).item;
    if (!page) throw Error("记忆续读期间已不可访问"); content += page.content; offset = page.nextOffset;
  }
  if (!historical && !revision) {
    const current = (await ctx.api.memory({ action: "read", chatId: scope.chatId, id, limit: 1 })).item;
    if (!current || current.revision !== item.revision) throw Error("记忆续读期间已变化");
  }
  return { ...item, content, nextOffset: null };
}
async function catalog(ctx, scope, options = {}) {
  const items = []; let continuation = {};
  do {
    ctx.signal.throwIfAborted();
    const page = await ctx.api.memory({ action: "search", chatId: scope.chatId, mode: options.historical ? "history" : "current", limit: 100, ...continuation });
    items.push(...page.items); continuation = page.nextOffset === null ? null : { offset: page.nextOffset, snapshot: page.snapshot, at: page.at };
  } while (continuation);
  return items;
}
module.exports = { current, get, put, state, save, defaults, readMemory, catalog, hash };
