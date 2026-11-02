"use strict";
const { hash } = require("./storage.cjs");
const { lexicalRanks, memoryApplicability, memoryChunks } = require("./lib/features/channels/channel-memory-retrieval.cjs");
const revision = entry => Number.isSafeInteger(entry.revision) ? entry.revision : parseInt(hash(JSON.stringify(entry)).slice(0, 12), 16);
const inputText = entry => String(entry.title || "") + "\n" + String(entry.content || "");
// Immutable passage IDs also support rollback and external Markdown edits,
// whose business revision need not be greater than a previously indexed one.
const ids = entry => { const text = inputText(entry), version = hash(text).slice(0, 24);
  return memoryChunks(text).map((text, i) => ({ id: `${entry.id}@${revision(entry)}:${version}:${i}`, revision: revision(entry), input: { text } })); };
function createRetrieval(ctx, storage, scope) {
  storage.db.exec("CREATE TABLE IF NOT EXISTS embedding_media(chat_id TEXT,collection TEXT,id TEXT,revision INTEGER,assets_json TEXT NOT NULL,PRIMARY KEY(chat_id,collection,id))");
  storage.db.exec("CREATE TABLE IF NOT EXISTS embedding_media_retry(chat_id TEXT,collection TEXT,id TEXT,retry_at INTEGER,PRIMARY KEY(chat_id,collection,id))");
  let selected, calls = 0;
  const MAX_WRITES = 32;
  const write = input => { if (calls >= MAX_WRITES) return null; calls++; return ctx.api.vectorIndex({ ...input, chatId: scope.chatId }); };
  const model = () => selected ||= ctx.api.embeddings({ action: "status", ...(ctx.config.retrievalModelId ? { modelId: ctx.config.retrievalModelId } : {}) });
  async function mediaChunks(entry, current, collection) {
    if (!current.modalities?.includes("image") || !ctx.api.assets || !ctx.api.sources) return [];
    const chunks = [], references = [], seen = new Set(); let failed = false;
    const save = () => { storage.db.prepare("INSERT INTO embedding_media VALUES(?,?,?,?,?) ON CONFLICT(chat_id,collection,id) DO UPDATE SET revision=excluded.revision,assets_json=excluded.assets_json")
      .run(scope.chatId, collection, entry.id, revision(entry), JSON.stringify(references));
      if (failed) storage.db.prepare("INSERT OR REPLACE INTO embedding_media_retry VALUES(?,?,?,?)").run(scope.chatId, collection, entry.id, Date.now() + 300000);
      else storage.db.prepare("DELETE FROM embedding_media_retry WHERE chat_id=? AND collection=? AND id=?").run(scope.chatId, collection, entry.id);
      return chunks; };
    for (const source of (entry.sources || []).slice(0, 8)) {
      if (source.chatId && source.chatId !== scope.chatId) continue;
      try {
        const item = (await ctx.api.sources({ action: "read", chatId: scope.chatId, id: source.id, version: source.version })).item;
        if (!item || item.deleted || item.routeBlocked || item.memoryExcluded) continue;
        for (const attachment of (item.attachments || []).filter(item => item.type === "image").slice(0, 4)) {
          const asset = await ctx.api.assets({ action: "fromMessage", chatId: scope.chatId, messageId: source.id, sourceVersion: item.version, index: attachment.index, kind: "image" });
          if (!asset.ref || seen.has(asset.ref)) continue; seen.add(asset.ref);
          chunks.push({ id: `${entry.id}@${revision(entry)}:image:${hash(asset.ref).slice(0, 24)}`, revision: revision(entry),
            input: { assetRef: asset.ref, ...(current.modalities.includes("joint") ? { text: inputText(entry).slice(0, 4000) } : {}) } });
          references.push({ assetRef: asset.ref, sourceId: source.id, sourceVersion: item.version, index: attachment.index });
          if (chunks.length >= 4) return save();
        }
      } catch { ctx.signal?.throwIfAborted(); failed = true; /* Preserve text indexing and retry transient image failures separately. */ }
    }
    return save();
  }
  async function index(collection, entries, { completeSet = true } = {}) {
    const current = await model();
    if (!current.ready) { await ctx.api.embeddings({ action: "ensure", modelId: current.id }); return { indexed: 0, pendingModel: true, version: current.version }; }
    let count = 0, pending = false;
    const lookup = storage.db.prepare("SELECT * FROM embedding_receipts WHERE chat_id=? AND collection=? AND id=?");
    const live = new Set(entries.map(entry => entry.id));
    for (const receipt of storage.db.prepare("SELECT * FROM embedding_receipts WHERE chat_id=? AND collection=?").all(scope.chatId, collection)) {
      if (!completeSet) break;
      if (live.has(receipt.id)) continue;
      const deleted = JSON.parse(receipt.chunk_ids);
      for (let offset = 0; offset < deleted.length; offset += 256) {
        const operation = write({ action: "delete", collection, ids: deleted.slice(offset, offset + 256) });
        if (!operation) return { indexed: count, pending: true, version: current.version }; await operation;
      }
      storage.db.prepare("DELETE FROM embedding_receipts WHERE chat_id=? AND collection=? AND id=?").run(scope.chatId, collection, receipt.id);
      storage.db.prepare("DELETE FROM embedding_media WHERE chat_id=? AND collection=? AND id=?").run(scope.chatId, collection, receipt.id);
      storage.db.prepare("DELETE FROM embedding_media_retry WHERE chat_id=? AND collection=? AND id=?").run(scope.chatId, collection, receipt.id);
    }
    const changed = entries.filter(entry => { const old = lookup.get(scope.chatId, collection, entry.id); return old?.revision !== revision(entry) || old.version !== current.version || !old.complete; });
    const prepared = new Map();
    for (const entry of changed) prepared.set(entry.id, [...ids(entry), ...await mediaChunks(entry, current, collection)]);
    const completed = new Set();
    const chunks = changed.flatMap(entry => {
      const old = lookup.get(scope.chatId, collection, entry.id), records = prepared.get(entry.id);
      const cursor = old?.revision === revision(entry) && old.version === current.version && !old.complete ? old.cursor : 0;
      records.slice(0, cursor).forEach(record => completed.add(record.id)); return records.slice(cursor);
    });
    for (let offset = 0; offset < chunks.length; offset += 32) {
      const records = chunks.slice(offset, offset + 32), operation = write({ action: "upsert", collection, modelId: current.id, records });
      if (!operation) { pending = true; break; }
      const result = await operation;
      if (result.version !== current.version || result.records.some(record => !record.accepted)) throw Error("索引资料已变化，请重试");
      records.forEach(record => completed.add(record.id));
    }
    for (const entry of changed) {
      const previous = lookup.get(scope.chatId, collection, entry.id);
      const records = prepared.get(entry.id);
      const cursor = records.findIndex(record => !completed.has(record.id));
      if (cursor >= 0) {
        pending = true;
        if (cursor > 0) storage.db.prepare("INSERT INTO embedding_receipts(chat_id,collection,id,revision,version,chunk_ids,complete,cursor) VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(chat_id,collection,id) DO UPDATE SET revision=excluded.revision,version=excluded.version,chunk_ids=excluded.chunk_ids,complete=0,cursor=excluded.cursor")
          .run(scope.chatId, collection, entry.id, revision(entry), current.version, JSON.stringify([...new Set([...JSON.parse(previous?.chunk_ids || "[]"), ...records.map(record => record.id)])]), cursor);
        continue;
      }
      const keep = new Set(records.map(record => record.id)), stale = JSON.parse(previous?.chunk_ids || "[]").filter(id => !keep.has(id));
      for (let offset = 0; offset < stale.length; offset += 256) {
        const operation = write({ action: "delete", collection, ids: stale.slice(offset, offset + 256) });
        if (!operation) return { indexed: count, pending: true, version: current.version }; await operation;
      }
      storage.db.prepare("INSERT INTO embedding_receipts(chat_id,collection,id,revision,version,chunk_ids) VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id,collection,id) DO UPDATE SET revision=excluded.revision,version=excluded.version,chunk_ids=excluded.chunk_ids,complete=1,cursor=0")
        .run(scope.chatId, collection, entry.id, revision(entry), current.version, JSON.stringify([...keep])); count++;
    }
    return { indexed: count, pending, version: current.version };
  }
  async function search(collection, query, entries, limit = 8) {
    if (!query.trim() || !entries.length) return { entries: [], mode: "text" };
    const lexical = lexicalRanks(query, entries.map(entry => ({ ...entry, content: inputText(entry) })), Date.now());
    const scores = new Map(); lexical.filter(row => row.lexicalScore > 0).forEach((row, i) => scores.set(row.entry.id, 1 / (61 + i)));
    let mode = "text", fallbackReason = "";
    try {
      const current = await model();
      if (!current.ready) throw Error("检索模型尚未下载");
      const owners = new Map(), candidates = entries.flatMap(entry => ids(entry).map(({ id, revision }) => { owners.set(id, entry.id); return { id, revision }; }));
      const result = { matches: [], missing: 0 };
      for (let offset = 0; offset < candidates.length; offset += 20000) {
        const page = await ctx.api.vectorIndex({ action: "search", chatId: scope.chatId, collection, modelId: current.id, query: { text: query },
          candidates: candidates.slice(offset, offset + 20000), limit: 100, timeoutMs: 15000 });
        result.matches.push(...page.matches); result.missing += page.missing;
      }
      const semantic = new Map();
      for (const hit of result.matches) { const id = owners.get(hit.id); if (id && hit.score >= (ctx.config.semanticThreshold ?? 0.45)) semantic.set(id, Math.max(semantic.get(id) || 0, hit.score)); }
      [...semantic].sort((a, b) => b[1] - a[1]).forEach(([id], i) => scores.set(id, (scores.get(id) || 0) + 0.65 / (61 + i)));
      if (semantic.size) mode = "hybrid";
      if (result.missing) storage.db.prepare("UPDATE embedding_receipts SET version='' WHERE chat_id=? AND collection=?").run(scope.chatId, collection);
    } catch (error) { fallbackReason = String(error.message || error); }
    return { entries: entries.filter(entry => scores.has(entry.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id)).slice(0, limit), mode, fallbackReason };
  }
  return { index, search, rankEntries: async (currentScope, query, entries, limit, options = {}) => {
    const available = entries.filter(entry => memoryApplicability(entry, options).allowed);
    return search("facts", options.contextualQuery || query, available, limit);
  } };
}
module.exports = { createRetrieval, revision, ids };
