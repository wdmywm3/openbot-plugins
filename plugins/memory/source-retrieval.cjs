"use strict";
const { get, put, hash } = require("./unified-state.cjs");
const COLLECTION = "chat-sources-v1";
const cursorKey = scope => `plus:source-index:${scope.chatId}`;
const readable = item => item && !item.deleted && !item.routeBlocked && !item.memoryExcluded && item.direction === "in"
  && !["notice", "request", "meta_event"].includes(item.event?.type);
function receipts(storage) {
  storage.db.exec("CREATE TABLE IF NOT EXISTS source_embedding_receipts(chat_id TEXT,id TEXT,version TEXT,model TEXT,ids_json TEXT,retry_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chat_id,id))");
}
async function index(ctx, storage, scope, { limit = 16 } = {}) {
  if (!ctx.api.sources || !ctx.api.embeddings || !ctx.api.vectorIndex) return { pending: false };
  receipts(storage);
  const model = await ctx.api.embeddings({ action: "status", ...(ctx.config.retrievalModelId ? { modelId: ctx.config.retrievalModelId } : {}) });
  if (!model.ready) return { pending: true };
  const saved = get(storage, cursorKey(scope), {}), after = saved.model === model.version ? saved.after || 0 : 0;
  const page = await ctx.api.sources({ action: "changes", chatId: scope.chatId, after, limit });
  if (!Array.isArray(page.items)) throw Error("资料变更列表无效");
  const retry = storage.db.prepare("SELECT id FROM source_embedding_receipts WHERE chat_id=? AND retry_at>0 AND retry_at<=? ORDER BY retry_at LIMIT 4").all(scope.chatId, Date.now());
  const sweepKey = `plus:source-sweep:${scope.chatId}`, sweepAfter = get(storage, sweepKey, "");
  const sweep = storage.db.prepare("SELECT id FROM source_embedding_receipts WHERE chat_id=? AND id>? ORDER BY id LIMIT 4").all(scope.chatId, sweepAfter);
  const ids = [...new Set([...page.items.map(item => item.id), ...retry.map(item => item.id), ...sweep.map(item => item.id)])];
  const synchronized = [], completed = [];
  for (const id of ids) {
    ctx.signal.throwIfAborted();
    const item = (await ctx.api.sources({ action: "read", chatId: scope.chatId, id, limit: 32000 })).item;
    const old = storage.db.prepare("SELECT * FROM source_embedding_receipts WHERE chat_id=? AND id=?").get(scope.chatId, id);
    if (readable(item) && old?.version === item.version && old.model === model.version && !old.retry_at) continue;
    const records = [], revision = parseInt(hash(item?.version || `removed:${id}`).slice(0, 12), 16);
    let retryAt = 0;
    if (readable(item)) {
      const metadata = { sourceId: id, sourceVersion: item.version, senderId: String(item.sender?.id || ""), at: item.createdAt || 0 };
      if (item.content?.trim()) records.push({ id: `${id}:text`, revision, text: item.content, metadata });
      for (const image of model.modalities?.includes("image") ? (item.attachments || []).filter(value => value.type === "image") : []) {
        try {
          const asset = await ctx.api.assets({ action: "fromMessage", chatId: scope.chatId, messageId: id, sourceVersion: item.version, index: image.index, kind: "image" });
          records.push({ id: `${id}:image:${image.index}`, revision, text: model.modalities.includes("joint") ? String(item.content || "").slice(0, 768) : "",
            assetRef: asset.ref, metadata: { ...metadata, imageIndex: image.index } });
        } catch { ctx.signal.throwIfAborted(); retryAt = Date.now() + 300000; }
      }
    }
    const live = new Set(records.map(record => record.id));
    for (const stale of JSON.parse(old?.ids_json || "[]")) if (!live.has(stale)) records.push({ id: stale, revision, text: "", metadata: { unavailable: true } });
    synchronized.push(...records);
    completed.push([scope.chatId, id, item?.version || "", model.version, JSON.stringify([...live]), retryAt]);
  }
  // Submit one bounded page together so the host can batch short messages too.
  // Commit receipts/cursors only after every corresponding index write succeeds.
  if (synchronized.length) await ctx.api.vectorIndex({ action: "sync", collection: COLLECTION, chatId: scope.chatId, modelId: model.id, records: synchronized, complete: false });
  for (const values of completed) storage.db.prepare("INSERT OR REPLACE INTO source_embedding_receipts VALUES(?,?,?,?,?,?)").run(...values);
  put(storage, cursorKey(scope), { after: page.items.at(-1)?.seq || Math.max(after, page.upper || 0), model: model.version });
  put(storage, sweepKey, sweep.length === 4 ? sweep.at(-1).id : "");
  return { pending: page.nextCursor != null, indexed: ids.length };
}
async function search(ctx, scope, query, options = {}) {
  if (!ctx.api.vectorIndex || !ctx.api.embeddings || !ctx.api.sources) return { records: [] };
  try {
    const model = await ctx.api.embeddings({ action: "status", ...(ctx.config.retrievalModelId ? { modelId: ctx.config.retrievalModelId } : {}) });
    if (options.imageOnly && !model.modalities?.includes("image")) return { records: [] };
    const hits = await ctx.api.vectorIndex({ action: "rank", chatId: scope.chatId, collection: COLLECTION, modelId: model.id,
      query: { text: options.imageOnly ? "" : query, ...(options.queryImage && model.modalities?.includes("image") ? { messageImage: options.queryImage } : {}) },
      ...(options.before ? { filter: { at: { lte: options.before - 1 } } } : {}), limit: 24, threshold: Math.max(0.65, ctx.config.semanticThreshold ?? 0.7), timeoutMs: options.timeoutMs ?? 15000 });
    const records = [], seen = new Set();
    for (const hit of hits.matches) {
      const ref = hit.metadata;
      if (!ref?.sourceId || seen.has(ref.sourceId) || options.excludeIds?.includes(ref.sourceId)) continue;
      const item = (await ctx.api.sources({ action: "read", chatId: scope.chatId, id: ref.sourceId, version: ref.sourceVersion,
        offset: ref.imageIndex === undefined ? hit.offset : 0, limit: 768 })).item;
      if (!readable(item) || item.version !== ref.sourceVersion) continue;
      seen.add(item.id);
      records.push({ key: `source:${item.id}:${ref.imageIndex === undefined ? hit.offset : 0}`, source: { id: item.id, version: item.version,
        offset: ref.imageIndex === undefined ? hit.offset : 0, limit: 768 }, ...(ref.imageIndex !== undefined ? { sourceImageIndex: ref.imageIndex } : {}) });
      if (records.length >= (options.limit || 2)) break;
    }
    return { records, mode: hits.mode };
  } catch (error) { ctx.signal.throwIfAborted(); return { records: [], fallbackReason: String(error.message || error) }; }
}
module.exports = { COLLECTION, cursorKey, index, search };
