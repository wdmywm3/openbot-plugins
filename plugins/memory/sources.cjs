"use strict";
const { sourceVersion } = require("./lib/features/channels/channel-memory-write.cjs");
const syncing = new Map();
function allowedSource(source) {
  if (source.deleted) return true;
  if (source.event?.kind === "notify" && source.event?.subtype === "poke") return false;
  if (source.routeBlocked && source.routeBlocked !== "blacklisted" || ["failed", "error", "canceled", "unknown", "uncertain", "pending"].includes(source.networkStatus)) return false;
  const tool = source.provenance?.tool;
  return source.provenance?.pluginId !== "memory" && !["memory", "qqHistory", "read_channel_history", "channel_task_activity"].includes(tool)
    && !String(tool || "").startsWith("plugin__memory__");
}
async function synchronize(ctx, storage, scope, { pages = 3, readBudget = 48 } = {}) {
  const key = JSON.stringify([storage.root, scope.chatId]); if (syncing.has(key)) return syncing.get(key);
  const job = (async () => {
    let cursor = storage.db.prepare("SELECT cursor FROM source_cursors WHERE chat_id=?").get(scope.chatId)?.cursor || 0, count = 0, more = false, reads = 0;
    for (let n = 0; n < pages; n++) {
      ctx.signal.throwIfAborted();
      const page = await ctx.api.sources({ action: "changes", chatId: scope.chatId, after: cursor, limit: 50 });
      for (const summary of page.items) {
        const buffered = storage.db.prepare("SELECT seq,value_json FROM source_buffers WHERE chat_id=? AND source_id=?").get(scope.chatId, summary.id);
        let source = buffered?.seq === summary.seq ? JSON.parse(buffered.value_json) : summary;
        if (!allowedSource(source)) source = { ...source, deleted: true, content: "", hasMore: false };
        while (source.hasMore) {
          if (reads++ >= readBudget) {
            storage.db.prepare("INSERT OR REPLACE INTO source_buffers VALUES(?,?,?,?)").run(scope.chatId, source.id, source.seq, JSON.stringify(source));
            return { cursor, count, more: true };
          }
          const next = await ctx.api.sources({ action: "read", chatId: scope.chatId, id: source.id, version: source.version, upper: source.seq,
            offset: source.content.length, limit: 32000 });
          if (!next.item) throw Error("资料版本已变化，请重试");
          source = { ...source, content: source.content + next.item.content, hasMore: next.item.hasMore };
          if (source.content.length > 8 * 1024 * 1024) throw Error("资料过长，请分页整理");
        }
        const previous = storage.getEvent(scope.channelId, scope.chatId, source.id);
        if (!previous || sourceVersion(previous) !== sourceVersion(source) || !!previous.deleted !== !!source.deleted) {
          storage.memoryRepository.invalidateSource(scope, source.id, source);
          if (source.deleted || previous && previous.content !== source.content) storage.dreamRepository.removeDerived(scope, [source.id]);
        }
        if (!previous || previous.version !== source.version || sourceVersion(previous) !== sourceVersion(source) || !!previous.deleted !== !!source.deleted) storage.dreamRepository.recordMaterial(scope, source);
        cursor = source.seq; count++;
        storage.db.prepare("DELETE FROM source_buffers WHERE chat_id=? AND source_id=?").run(scope.chatId, source.id);
        storage.db.prepare("INSERT INTO source_cursors VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET cursor=excluded.cursor").run(scope.chatId, cursor);
      }
      more = page.nextCursor !== null; if (!more) break;
    }
    return { cursor, count, more };
  })().finally(() => syncing.delete(key)); syncing.set(key, job); return job;
}
async function validateEntries(ctx, storage, scope, entries) {
  const checked = new Map(), valid = [];
  for (const entry of entries) {
    let usable = true;
    for (const id of entry.sourceIds || []) {
      if (!checked.has(id)) {
        const live = (await ctx.api.sources({ action: "read", chatId: scope.chatId, id, limit: 1 })).item;
        const old = storage.getEvent(scope.channelId, scope.chatId, id);
        const okay = !!live && !live.deleted && allowedSource(live) && old?.version === live.version;
        checked.set(id, okay);
        if (!okay) { storage.memoryRepository.invalidateSource(scope, id, live || { deleted: true, content: "" }); storage.dreamRepository.removeDerived(scope, [id]); }
      }
      if (!checked.get(id)) { usable = false; break; }
    }
    if (usable) valid.push(entry);
  }
  return valid;
}
module.exports = { synchronize, validateEntries };
