"use strict";
const { get, put, readMemory, catalog } = require("./unified-state.cjs");
const { createRetrieval } = require("./retrieval.cjs");
const { lexicalRanks, memoryApplicability } = require("./lib/features/channels/channel-memory-retrieval.cjs");
const { searchTokens } = require("./lib/features/channels/channel-memory-policy.cjs");
function applicable(record, options) {
  if (record.category === "followup_handoff") return false;
  const subjects = (record.subjectRefs || []).filter(value => typeof value === "string");
  if (subjects.length && options.subjectIds?.length && !subjects.some(id => options.subjectIds.includes(id))) return false;
  const content = record.content || record.preview || "";
  return memoryApplicability({ ...record, content, fact: { contentHash: require("./lib/features/channels/channel-memory-write.cjs").digest(content), subjectId: subjects[0] || "", conditions: record.conditions || [] } }, options).allowed;
}
const COLLECTION = "unified-memory";
async function remove(ctx, storage, scope, id) {
  const row = storage.db.prepare("SELECT chunk_ids FROM embedding_receipts WHERE chat_id=? AND collection=? AND id=?").get(scope.chatId, COLLECTION, id);
  if (!row) return;
  const ids = JSON.parse(row.chunk_ids);
  for (let offset = 0; offset < ids.length; offset += 256) await ctx.api.vectorIndex({ action: "delete", chatId: scope.chatId, collection: COLLECTION, ids: ids.slice(offset, offset + 256) });
  storage.db.prepare("DELETE FROM embedding_receipts WHERE chat_id=? AND collection=? AND id=?").run(scope.chatId, COLLECTION, id);
  if (storage.db.prepare("SELECT 1 FROM sqlite_master WHERE name='embedding_media'").get()) storage.db.prepare("DELETE FROM embedding_media WHERE chat_id=? AND collection=? AND id=?").run(scope.chatId, COLLECTION, id);
  if (storage.db.prepare("SELECT 1 FROM sqlite_master WHERE name='embedding_media_retry'").get()) storage.db.prepare("DELETE FROM embedding_media_retry WHERE chat_id=? AND collection=? AND id=?").run(scope.chatId, COLLECTION, id);
}
async function index(ctx, storage, scope) {
  if (!ctx.api.embeddings || !ctx.api.vectorIndex) return { mode: "text" };
  const key = `plus:index:${scope.chatId}`;
  const model = await ctx.api.embeddings({ action: "status", ...(ctx.config.retrievalModelId ? { modelId: ctx.config.retrievalModelId } : {}) });
  const mediaKey = `plus:media-index:${scope.chatId}`;
  if (model.modalities?.includes("image") && !get(storage, mediaKey) && (await ctx.api.getCapabilities?.())?.features?.sourceAttachments) {
    storage.db.prepare("UPDATE embedding_receipts SET complete=0,cursor=0 WHERE chat_id=? AND collection=?").run(scope.chatId, COLLECTION);
    put(storage, key, { after: 0, version: model.version }); put(storage, mediaKey, true);
  }
  const old = get(storage, key, { after: 0 });
  const start = old.version === model.version ? old.after : 0;
  const page = await ctx.api.memory({ action: "changes", chatId: scope.chatId, after: start, limit: 20 });
  for (const change of page.items) {
    let record;
    try { record = await readMemory(ctx, scope, change.id); }
    catch (error) { if (error.code !== "MEMORY_NOT_FOUND") throw error; }
    if (record && record.category !== "followup_handoff") {
      const result = await createRetrieval(ctx, storage, scope).index(COLLECTION, [record], { completeSet: false });
      if (result.pending || result.pendingModel) return { pending: true, version: model.version };
    } else await remove(ctx, storage, scope, change.id);
    put(storage, key, { after: change.seq, version: model.version });
  }
  if (page.nextCursor === null) put(storage, key, { after: page.upper, version: model.version });
  // Source revocation and expiry need not emit a memory edit. Sweep a bounded part of the derived index too.
  const cursorKey = `plus:sweep:${scope.chatId}`, afterId = get(storage, cursorKey, "");
  const stale = storage.db.prepare("SELECT id FROM embedding_receipts WHERE chat_id=? AND collection=? AND id>? ORDER BY id LIMIT 20").all(scope.chatId, COLLECTION, afterId);
  for (const row of stale) {
    let current; try { current = await readMemory(ctx, scope, row.id, { complete: false }); } catch (error) { if (error.code !== "MEMORY_NOT_FOUND") throw error; }
    if (!current) await remove(ctx, storage, scope, row.id);
    else if (storage.db.prepare("SELECT 1 FROM sqlite_master WHERE name='embedding_media_retry'").get()
      && storage.db.prepare("SELECT 1 FROM embedding_media_retry WHERE chat_id=? AND collection=? AND id=? AND retry_at<=?").get(scope.chatId, COLLECTION, row.id, Date.now())) {
      const full = await readMemory(ctx, scope, row.id);
      storage.db.prepare("UPDATE embedding_receipts SET complete=0,cursor=0 WHERE chat_id=? AND collection=? AND id=?").run(scope.chatId, COLLECTION, row.id);
      await createRetrieval(ctx, storage, scope).index(COLLECTION, [full], { completeSet: false });
    }
  }
  put(storage, cursorKey, stale.length === 20 ? stale.at(-1).id : "");
  if (stale.length < 20) put(storage, `plus:sweepAt:${scope.chatId}`, Date.now());
  return { pending: page.nextCursor !== null, version: model.version };
}
async function search(ctx, storage, scope, query, limit = 8, options = {}) {
  if (!String(query || "").trim()) return { records: [], mode: "text" };
  const byId = new Map((await (options.catalog || catalog(ctx, scope))).filter(item => applicable(item, options)).map(item => [item.id, item]));
  // The catalog preview is not the full body. Ask the host for bounded full-text hits too.
  const terms = [...new Set([String(query).trim(), ...searchTokens(query)])].filter(term => term && term.length <= 500).slice(0, 8);
  for (const term of [...byId.values()].some(item => item.preview?.length >= 600) ? terms : []) {
    ctx.signal.throwIfAborted();
    const matches = await ctx.api.memory({ action: "search", chatId: scope.chatId, query: term, limit: 100 });
    for (const item of matches.items || []) {
      if (!applicable(item, options)) continue;
      const previous = byId.get(item.id);
      const score = value => lexicalRanks(query, [{ ...value, content: value.preview }], Date.now())[0].lexicalScore;
      if (!previous || previous.revision !== item.revision || score(item) > score(previous)) byId.set(item.id, item);
    }
  }
  const entries = [...byId.values()];
  const ranked = options.imageOnly ? [] : lexicalRanks(query, entries.map(item => ({ ...item, content: item.preview })), Date.now()).filter(row => row.lexicalScore > 0);
  const scores = new Map(ranked.map((row, index) => [row.entry.id, 0.35 / (61 + index)]));
  let mode = "text", fallbackReason = "";
  if (ctx.api.embeddings && ctx.api.vectorIndex) try {
    const model = await ctx.api.embeddings({ action: "status", ...(ctx.config.retrievalModelId ? { modelId: ctx.config.retrievalModelId } : {}) });
    if (!model.ready) throw Error("检索模型尚未就绪");
    if (options.imageOnly && !model.modalities?.includes("image")) throw Error("当前检索模型不支持图片查询");
    const owners = new Map(), candidates = [];
    for (const receipt of storage.db.prepare("SELECT * FROM embedding_receipts WHERE chat_id=? AND collection=? ORDER BY id").all(scope.chatId, COLLECTION)) {
      if (byId.get(receipt.id)?.revision !== receipt.revision || receipt.version !== model.version) continue;
      for (const id of JSON.parse(receipt.chunk_ids)) { candidates.push({ id, revision: receipt.revision }); owners.set(id, receipt.id); }
    }
    const semantic = new Map();
    for (let offset = 0; offset < candidates.length; offset += 20000) {
      const result = await ctx.api.vectorIndex({ action: "search", chatId: scope.chatId, collection: COLLECTION, modelId: model.id,
        candidates: candidates.slice(offset, offset + 20000), query: { text: options.imageOnly ? "" : query,
          ...(options.queryImage && model.modalities?.includes("image") ? { messageImage: options.queryImage } : {}) }, limit: 100, timeoutMs: options.timeoutMs ?? 15000 });
      for (const hit of result.matches) if (hit.score >= (ctx.config.semanticThreshold ?? 0.45)) semantic.set(owners.get(hit.id), Math.max(semantic.get(owners.get(hit.id)) || 0, hit.score));
    }
    [...semantic].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([id], index) => scores.set(id, (scores.get(id) || 0) + 0.65 / (61 + index)));
    if (semantic.size) mode = "hybrid";
  } catch (error) { fallbackReason = String(error.message || error); }
  for (const [id, score] of scores) {
    const usage = get(storage, `plus:score:${id}:${byId.get(id)?.revision}`);
    if (usage) scores.set(id, score * Math.max(0.5, Math.min(1.2, 1 + (usage.used - 2 * usage.misapplied) / Math.max(10, usage.selected))));
  }
  const selected = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit), groups = [], seen = new Set();
  for (const [id] of selected) {
    if (!byId.has(id) || seen.has(id)) continue;
    let record;
    try { record = await readMemory(ctx, scope, id, { complete: false }); } catch (error) { if (error.code !== "MEMORY_NOT_FOUND") throw error; }
    if (!record || !applicable(record, options)) continue;
    const hit = byId.get(id);
    if (hit.revision === record.revision && hit.previewOffset > 0) {
      const offset = Math.floor((hit.previewOffset + 120) / 512) * 512;
      const page = (await ctx.api.memory({ action: "read", chatId: scope.chatId, id, revision: record.revision, offset, limit: 768 })).item;
      if (!page) continue;
      record = { ...record, recallExcerpt: page.content, recallOffset: offset };
    }
    const group = [record]; seen.add(id);
    // Expand explicitly linked progress with current reads; never inject an old question alone after dropping its resolution to meet a budget.
    for (const link of record.relations || []) {
      if (seen.has(link.id) || group.length >= 5) continue;
      let related; try { related = await readMemory(ctx, scope, link.id, { complete: false }); } catch (error) { if (error.code !== "MEMORY_NOT_FOUND") throw error; }
      if (related && applicable(related, options)) { group.push(related); seen.add(link.id); }
    }
    groups.push(group);
  }
  if (options.raw === true) return { records: groups.flat().slice(0, limit), mode, fallbackReason };
  const records = []; let used = 0;
  for (const group of groups) {
    const values = group.map(({ id, revision, kind, subtype, content, conditions, progress, validFrom, validTo, recallExcerpt, recallOffset, nextOffset }) => ({ id, revision, kind, subtype,
      content: recallExcerpt || content.slice(0, 768), truncated: !!recallOffset || content.length > 768 || nextOffset != null,
      conditions, progress, validFrom, validTo, read: { action: "read", id, revision, offset: recallOffset || 0, limit: 768 } }));
    const size = JSON.stringify(values).length; if (used + size > 3500) continue; used += size; records.push(...values);
  }
  records.sort((a, b) => a.id.localeCompare(b.id) || a.read.offset - b.read.offset);
  return { records, mode, fallbackReason };
}
module.exports = { index, search, remove, COLLECTION };
