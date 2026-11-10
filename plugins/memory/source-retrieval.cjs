"use strict";
const { get, put, hash } = require("./unified-state.cjs");
const { sourceImage, imageFailureStore, findSkippedImages, writeImageBatch } = require("./image-indexing.cjs");
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
  const failures = imageFailureStore(storage, scope, ctx.config.skipOversizedSourceImages === true);
  const synchronized = [], completed = [], images = new Map(), skipped = new Set();
  for (const id of ids) {
    ctx.signal.throwIfAborted();
    const item = (await ctx.api.sources({ action: "read", chatId: scope.chatId, id, limit: 32000 })).item;
    const old = storage.db.prepare("SELECT * FROM source_embedding_receipts WHERE chat_id=? AND id=?").get(scope.chatId, id);
    if (readable(item) && old?.version === item.version && old.model === model.version && !old.retry_at) continue;
    const records = [], revision = parseInt(hash(item?.version || `removed:${id}`).slice(0, 12), 16);
    const available = readable(item);
    let retryAt = 0;
    if (available) {
      const metadata = { sourceId: id, sourceVersion: item.version, senderId: String(item.sender?.id || ""), at: item.createdAt || 0 };
      if (item.content?.trim()) records.push({ id: `${id}:text`, revision, text: item.content, metadata });
      for (const image of model.modalities?.includes("image") ? (item.attachments || []).filter(value => value.type === "image") : []) {
        const photo = sourceImage(item, image), imageId = `${id}:image:${image.index}`;
        if (failures.known(photo, model.version)) continue;
        try {
          const asset = await ctx.api.assets({ action: "fromMessage", chatId: scope.chatId, messageId: id, sourceVersion: item.version, index: image.index, kind: "image" });
          records.push({ id: imageId, revision, text: model.modalities.includes("joint") ? String(item.content || "").slice(0, 768) : "",
            assetRef: asset.ref, metadata: { ...metadata, imageIndex: image.index } });
          images.set(imageId, photo);
        } catch { ctx.signal.throwIfAborted(); retryAt = Date.now() + 300000; }
      }
    }
    const live = new Set(records.map(record => record.id));
    for (const stale of JSON.parse(old?.ids_json || "[]")) if (!live.has(stale)) records.push({ id: stale, revision, text: "", metadata: { unavailable: true } });
    synchronized.push(...records);
    completed.push({ id, version: item?.version || "", available, live, retryAt });
  }
  const sync = records => ctx.api.vectorIndex({ action: "sync", collection: COLLECTION, chatId: scope.chatId, modelId: model.id, records, complete: false });
  const tombstones = [];
  await writeImageBatch(synchronized, {
    write: sync, signal: ctx.signal, isImage: record => images.has(record.id),
    onIndexed(records) {
      for (const record of records) if (images.has(record.id)) failures.indexed(images.get(record.id));
    },
    onFailure(record, code) {
      failures.record(images.get(record.id), model.version, code);
      skipped.add(record.id);
      tombstones.push({ id: record.id, revision: record.revision, text: "", metadata: { unavailable: true } });
    },
  });
  if (tombstones.length) await sync(tombstones);
  ctx.signal.throwIfAborted();
  const saveReceipt = storage.db.prepare("INSERT OR REPLACE INTO source_embedding_receipts VALUES(?,?,?,?,?,?)");
  storage.db.exec("BEGIN IMMEDIATE");
  try {
    for (const { id, version, available, live, retryAt } of completed) {
      saveReceipt.run(scope.chatId, id, version, model.version, JSON.stringify([...live].filter(id => !skipped.has(id))), retryAt);
      failures.prune(id, available ? version : "");
    }
    put(storage, cursorKey(scope), { after: page.items.at(-1)?.seq || Math.max(after, page.upper || 0), model: model.version });
    put(storage, sweepKey, sweep.length === 4 ? sweep.at(-1).id : "");
    storage.db.exec("COMMIT");
  } catch (error) {
    storage.db.exec("ROLLBACK");
    throw error;
  }
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
async function searchSkipped(ctx, storage, scope, input) {
  const skippedImages = [];
  for (const row of findSkippedImages(storage, scope, input, ctx.config.skipOversizedSourceImages === true)) {
    ctx.signal.throwIfAborted();
    const { item } = await ctx.api.sources({ action: "read", chatId: scope.chatId, id: row.source_id, version: row.source_version, limit: 768 });
    if (!readable(item) || item.version !== row.source_version) continue;
    const image = item.attachments?.find(attachment => attachment.type === "image" && attachment.index === row.image_index);
    if (!image) continue;
    skippedImages.push({ messageId: item.id, version: item.version, imageIndex: image.index, name: image.name || "",
      content: item.content, createdAt: item.createdAt, reason: "超过图片索引的像素上限" });
  }
  return { searchIn: "skipped_images", skippedImages, count: skippedImages.length };
}
module.exports = { COLLECTION, cursorKey, index, search, searchSkipped, readable };
