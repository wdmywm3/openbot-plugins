"use strict";

const { createHash } = require("node:crypto");
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = (message, code = "DOCUMENT_INVALID") => Object.assign(new Error(message), { code });

function documentScope(scope = {}) {
  const value = { channelId: String(scope.channelId || ""), chatId: String(scope.chatId || ""), ownerId: String(scope.ownerId || "host") };
  if (!value.channelId || Object.values(value).some(text => text.length > 256 || /[\u0000-\u001f]/.test(text))) throw fail("资料范围无效");
  return value;
}
const scopeArgs = scope => Object.values(documentScope(scope));
function artifactId(value) {
  const id = String(value || "");
  if (!id || id.length > 256 || /[\u0000-\u001f]/.test(id)) throw fail("资料编号无效");
  return id;
}
function documentPath(proposal) {
  let relative = proposal.relativePath;
  if (!relative && proposal.kind === "daily") {
    const day = String(proposal.day || "");
    const date = new Date(`${day}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) throw fail("每日日记需要有效的 YYYY-MM-DD 日期");
    relative = `notes/daily/${day.replaceAll("-", "/")}.md`;
  }
  if (!relative) {
    const id = artifactId(proposal.artifactId || proposal.id);
    const fileId = /^[A-Za-z0-9_-]{1,120}$/.test(id) ? id : `document-${hash(id).slice(0, 32)}`;
    relative = `notes/topics/${fileId}.md`;
  }
  if (typeof relative !== "string" || relative.length > 500 || !relative.startsWith("notes/") || !relative.endsWith(".md")) throw fail("资料路径必须位于 notes 下并使用 .md 文件");
  const parts = relative.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.length > 180 || /[<>:"\\|?*\u0000-\u001f]/.test(part)
    || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw fail("资料路径无效");
  return relative;
}

function createChannelDocumentRepository(db, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS channel_documents(
    channel_id TEXT NOT NULL,chat_id TEXT NOT NULL,owner_id TEXT NOT NULL,artifact_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,content_hash TEXT NOT NULL,revision INTEGER NOT NULL,
    content_text TEXT NOT NULL,value_json TEXT NOT NULL,
    PRIMARY KEY(channel_id,chat_id,owner_id,artifact_id),
    UNIQUE(channel_id,chat_id,owner_id,relative_path)
  );
  CREATE TABLE IF NOT EXISTS channel_document_writes(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,op_id TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,chat_id TEXT NOT NULL,owner_id TEXT NOT NULL,artifact_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,state TEXT NOT NULL,fingerprint TEXT NOT NULL,
    expected_hash TEXT NOT NULL,target_hash TEXT NOT NULL,content_text TEXT,value_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_document_writes_scope ON channel_document_writes(channel_id,chat_id,owner_id,state,seq);
  CREATE INDEX IF NOT EXISTS idx_document_writes_target ON channel_document_writes(channel_id,chat_id,owner_id,artifact_id,state);`);
  const q = sql => db.prepare(sql);
  function transaction(fn) {
    db.exec("SAVEPOINT document_write");
    try { const result = fn(); db.exec("RELEASE document_write"); return result; }
    catch (error) { db.exec("ROLLBACK TO document_write"); db.exec("RELEASE document_write"); throw error; }
  }
  const fromRow = row => row ? { ...JSON.parse(row.value_json), artifactId: row.artifact_id, id: row.artifact_id,
    relativePath: row.relative_path, contentHash: row.content_hash, revision: Number(row.revision), content: row.content_text } : null;
  const operation = row => row ? { ...JSON.parse(row.value_json), seq: Number(row.seq), opId: row.op_id,
    scope: { channelId: row.channel_id, chatId: row.chat_id, ownerId: row.owner_id }, artifactId: row.artifact_id,
    relativePath: row.relative_path, state: row.state, expectedHash: row.expected_hash, targetHash: row.target_hash,
    content: row.content_text, fingerprint: row.fingerprint } : null;
  function get(scope, id) {
    return fromRow(q("SELECT * FROM channel_documents WHERE channel_id=? AND chat_id=? AND owner_id=? AND artifact_id=?")
      .get(...scopeArgs(scope), artifactId(id)));
  }
  function getOperation(opId) { return operation(q("SELECT * FROM channel_document_writes WHERE op_id=?").get(String(opId))); }
  function saveIndex(scope, entry) {
    const { content, ...metadata } = entry;
    q(`INSERT INTO channel_documents VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,chat_id,owner_id,artifact_id)
      DO UPDATE SET relative_path=excluded.relative_path,content_hash=excluded.content_hash,revision=excluded.revision,
      content_text=excluded.content_text,value_json=excluded.value_json`)
      .run(...scopeArgs(scope), entry.artifactId, entry.relativePath, entry.contentHash || "", entry.revision,
        String(content || ""), JSON.stringify(metadata));
    return get(scope, entry.artifactId);
  }
  function updateOperation(op, fields) {
    const { content, ...value } = { ...op, ...fields, updatedAt: now() };
    q("UPDATE channel_document_writes SET state=?,content_text=?,value_json=? WHERE op_id=?")
      .run(value.state, content == null ? null : content, JSON.stringify(value), op.opId);
    return getOperation(op.opId);
  }
  function enqueue(scope, proposal = {}) {
    scope = documentScope(scope);
    const id = artifactId(proposal.artifactId || proposal.id), relativePath = documentPath({ ...proposal, artifactId: id });
    if (relativePath.toLowerCase().startsWith("notes/.history/")) throw fail("资料写回不能使用历史版本目录");
    const content = proposal.content;
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_DOCUMENT_BYTES || content.includes("\0")) throw fail("资料正文须为不超过 1 MiB 的 Markdown 文本");
    const expectedHash = proposal.expectedHash;
    if (expectedHash !== "new" && !/^[a-f0-9]{64}$/.test(expectedHash || "")) throw fail("写回资料需要读取时的 SHA-256，新文件使用 new");
    const time = now();
    const targetHash = hash(Buffer.from(content, "utf8"));
    const metadata = { ...scope, artifactId: id, id, relativePath,
      kind: String(proposal.kind || "note").slice(0, 64), title: String(proposal.title || id).slice(0, 200),
      createdAt: Number(proposal.createdAt) || time, occurredAt: Number(proposal.occurredAt) || time,
      updatedAt: time, status: String(proposal.status || "active").slice(0, 64),
      sourceIds: Array.isArray(proposal.sourceIds) ? [...new Set(proposal.sourceIds.map(String))] : [], noteRefs: proposal.noteRefs || [],
      ...(proposal.metadata ? { metadata: proposal.metadata } : {}) };
    if (metadata.sourceIds.length > 500 || !Array.isArray(metadata.noteRefs) || Buffer.byteLength(JSON.stringify(metadata)) > 64 * 1024) throw fail("资料元信息过大或无效");
    const fingerprint = hash(JSON.stringify([scope, id, relativePath, expectedHash, targetHash,
      metadata.kind, metadata.title, metadata.status, metadata.sourceIds, metadata.noteRefs, metadata.metadata || null,
      proposal.resolvesOpId || null, proposal.resolutionMode || null]));
    const opId = artifactId(proposal.opId || `document-write-${fingerprint}`);
    return transaction(() => {
      const prior = getOperation(opId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw fail("写回编号已用于不同内容", "DOCUMENT_OPERATION_CONFLICT");
        return prior;
      }
      if (proposal.resolvesOpId) {
        const original = getOperation(proposal.resolvesOpId);
        if (!original || original.state !== "conflict" || original.artifactId !== id || JSON.stringify(original.scope) !== JSON.stringify(scope)) throw fail("待解决的写回冲突不存在或已变化", "DOCUMENT_OPERATION_CONFLICT");
        const resolving = q("SELECT op_id FROM channel_document_writes WHERE json_extract(value_json,'$.resolvesOpId')=? AND state IN ('pending','error','applied') LIMIT 1").get(original.opId);
        if (resolving) throw fail("该冲突已有待完成的处理操作", "DOCUMENT_RESOLUTION_PENDING");
      }
      const previous = get(scope, id);
      if (previous?.revokedAt) throw fail("资料已撤销，不能由旧任务重新写入", "DOCUMENT_REVOKED");
      if (previous && previous.relativePath !== relativePath) throw fail("资料路径已登记，不能通过写回更改归属或路径");
      const earlierPath = q("SELECT relative_path FROM channel_document_writes WHERE channel_id=? AND chat_id=? AND owner_id=? AND artifact_id=? ORDER BY seq LIMIT 1")
        .get(...scopeArgs(scope), id)?.relative_path;
      if (earlierPath && earlierPath !== relativePath) throw fail("资料路径已登记，不能通过写回更改归属或路径");
      const collision = q(`SELECT artifact_id FROM channel_documents WHERE channel_id=? AND chat_id=? AND owner_id=? AND relative_path=? COLLATE NOCASE
        UNION SELECT artifact_id FROM channel_document_writes WHERE channel_id=? AND chat_id=? AND owner_id=? AND relative_path=? COLLATE NOCASE AND state IN ('pending','error')`)
        .all(...scopeArgs(scope), relativePath, ...scopeArgs(scope), relativePath).some(row => row.artifact_id !== id);
      if (collision) throw fail("资料路径已被另一份资料占用");
      if (previous) { metadata.createdAt = previous.createdAt; metadata.occurredAt = proposal.occurredAt == null ? previous.occurredAt : metadata.occurredAt; }
      q("INSERT INTO channel_document_writes(op_id,channel_id,chat_id,owner_id,artifact_id,relative_path,state,fingerprint,expected_hash,target_hash,content_text,value_json) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?)")
        .run(opId, ...scopeArgs(scope), id, relativePath, fingerprint, expectedHash, targetHash, content,
          JSON.stringify({ metadata, createdAt: time, updatedAt: time, attempts: 0,
            ...(proposal.resolvesOpId ? { resolvesOpId: proposal.resolvesOpId, resolutionMode: proposal.resolutionMode } : {}) }));
      return getOperation(opId);
    });
  }
  function finish(opId, { content, mtimeMs = 0 } = {}) {
    return transaction(() => {
      const op = getOperation(opId);
      if (!op) throw fail("写回操作不存在");
      const previous = get(op.scope, op.artifactId);
      if (op.state === "applied") return previous;
      if (op.state === "canceled" || previous?.revokedAt) throw fail("资料已撤销", "DOCUMENT_REVOKED");
      if (typeof content !== "string" || hash(Buffer.from(content, "utf8")) !== op.targetHash) throw fail("落盘内容与待写回版本不匹配");
      const saved = saveIndex(op.scope, { ...op.metadata, state: "ready", content,
        contentHash: op.targetHash, revision: (previous?.revision || 0) + 1, updatedAt: now(), mtimeMs,
        externallyModified: false, missingAt: 0, revokedAt: 0, lastWriteOpId: op.opId });
      updateOperation(op, { state: "applied", content: null, error: "", appliedAt: now() });
      if (op.resolvesOpId) {
        const original = getOperation(op.resolvesOpId);
        if (original?.state === "conflict") updateOperation(original, { state: "resolved", resolvedAt: now(), resolutionOpId: op.opId });
      }
      return saved;
    });
  }
  function reconcileIndex(scope, id, { content, mtimeMs = 0 } = {}) {
    const previous = get(scope, id);
    if (!previous || previous.revokedAt) return previous;
    if (typeof content !== "string") throw fail("资料正文无效");
    const contentHash = hash(Buffer.from(content, "utf8"));
    if (contentHash === previous.contentHash && !previous.missingAt) return previous;
    // Content discovery never writes task/cancellation/delivery state or reactivates a revoked document.
    return saveIndex(scope, { ...previous, content, contentHash, revision: previous.revision + 1,
      updatedAt: now(), mtimeMs, externallyModified: true, state: "ready", missingAt: 0 });
  }
  function markMissing(scope, id) {
    const previous = get(scope, id);
    if (!previous || previous.revokedAt || previous.missingAt) return previous;
    return saveIndex(scope, { ...previous, content: "", state: "missing", missingAt: now() });
  }
  function revoke(scope, id, reason = "") {
    return transaction(() => {
      scope = documentScope(scope); id = artifactId(id);
      const previous = get(scope, id);
      if (previous?.revokedAt) return previous;
      const queued = q("SELECT * FROM channel_document_writes WHERE channel_id=? AND chat_id=? AND owner_id=? AND artifact_id=? ORDER BY seq DESC LIMIT 1").get(...scopeArgs(scope), id);
      const metadata = previous || (queued ? operation(queued).metadata : { ...scope, artifactId: id, id, kind: "note", title: id,
        relativePath: documentPath({ artifactId: id }), createdAt: now(), occurredAt: now(), sourceIds: [], noteRefs: [] });
      const saved = saveIndex(scope, { ...metadata, status: "revoked", state: "revoked", revokedAt: now(),
        unregistered: !previous && !queued,
        revokeReason: String(reason).slice(0, 500), updatedAt: now(), revision: (previous?.revision || 0) + 1,
        content: "", contentHash: previous?.contentHash || "" });
      for (const row of q("SELECT * FROM channel_document_writes WHERE channel_id=? AND chat_id=? AND owner_id=? AND artifact_id=? AND state<>'applied'").all(...scopeArgs(scope), id)) {
        updateOperation(operation(row), { state: "canceled", content: null, error: "资料已撤销" });
      }
      return saved;
    });
  }
  function list(scope, { kind = "", query = "", after = "", limit = 100, includeRevoked = false } = {}) {
    const size = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
    const escaped = String(query).slice(0, 200).replace(/[\\%_]/g, "\\$&");
    const rows = q(`SELECT * FROM channel_documents WHERE channel_id=? AND chat_id=? AND owner_id=? AND artifact_id>?
      AND (?='' OR json_extract(value_json,'$.kind')=?) AND (? OR COALESCE(json_extract(value_json,'$.revokedAt'),0)=0)
      AND (?='' OR content_text LIKE ? ESCAPE '\\' OR json_extract(value_json,'$.title') LIKE ? ESCAPE '\\')
      ORDER BY artifact_id LIMIT ?`).all(...scopeArgs(scope), String(after || ""), kind, kind, includeRevoked ? 1 : 0,
        escaped, `%${escaped}%`, `%${escaped}%`, size + 1);
    const records = rows.slice(0, size).map(fromRow);
    return { records, nextCursor: rows.length > size ? records.at(-1).artifactId : null };
  }
  function pending(scope = null, { after = 0, limit = 100 } = {}) {
    const size = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
    const rows = scope ? q("SELECT * FROM channel_document_writes WHERE channel_id=? AND chat_id=? AND owner_id=? AND state IN ('pending','error') AND seq>? ORDER BY seq LIMIT ?")
      .all(...scopeArgs(scope), Number(after) || 0, size + 1)
      : q("SELECT * FROM channel_document_writes WHERE state IN ('pending','error') AND seq>? ORDER BY seq LIMIT ?").all(Number(after) || 0, size + 1);
    const items = rows.slice(0, size).map(operation);
    return { items, nextCursor: rows.length > size ? items.at(-1).seq : null };
  }
  function owners(scope) {
    const { channelId, chatId } = documentScope(scope);
    return q(`SELECT owner_id FROM channel_documents WHERE channel_id=? AND chat_id=?
      UNION SELECT owner_id FROM channel_document_writes WHERE channel_id=? AND chat_id=? ORDER BY owner_id`)
      .all(channelId, chatId, channelId, chatId).map(row => row.owner_id);
  }
  function scopes() {
    return q(`SELECT channel_id,chat_id FROM channel_documents
      UNION SELECT channel_id,chat_id FROM channel_document_writes ORDER BY channel_id,chat_id`)
      .all().map(row => ({ channelId: row.channel_id, chatId: row.chat_id }));
  }
  return { transaction, get, getOperation, enqueue, finish, reconcileIndex, markMissing, revoke, list, pending, owners, scopes,
    restoreCheckpoint(scope, before, after) {
      const id = (before || after).artifactId, current = get(scope, id);
      // Cancel stale writes before any async writer can resume after the rollback.
      for (const row of q("SELECT op_id FROM channel_document_writes WHERE channel_id=? AND chat_id=? AND owner_id=? AND artifact_id=? AND state IN ('pending','error','conflict')").all(...scopeArgs(scope), id)) {
        const op = getOperation(row.op_id); updateOperation(op, { state: "canceled", error: "对应 Dream 已回滚" });
      }
      return saveIndex(scope, before ? { ...before, revision: Math.max(current?.revision || 0, before.revision || 0) + 1,
        updatedAt: now(), revokedAt: 0, missingAt: 0, lastWriteOpId: "", externallyModified: false }
        : { ...after, content: "", contentHash: "", revision: (current?.revision || 0) + 1, revokedAt: now(), status: "revoked", updatedAt: now() });
    },
    markConflict(opId, message = "文件版本已变化，请重新读取后合并") {
      const op = getOperation(opId);
      return op && !["applied", "canceled", "resolved"].includes(op.state) ? updateOperation(op, { state: "conflict", error: String(message).slice(0, 500), attempts: (op.attempts || 0) + 1 }) : op;
    },
    markError(opId, error) {
      const op = getOperation(opId);
      return op && !["applied", "canceled", "resolved"].includes(op.state) ? updateOperation(op, { state: "error", error: String(error?.message || error).slice(0, 500), attempts: (op.attempts || 0) + 1 }) : op;
    },
    deleteChannel(channelId) {
      q("DELETE FROM channel_document_writes WHERE channel_id=?").run(String(channelId));
      q("DELETE FROM channel_documents WHERE channel_id=?").run(String(channelId));
    },
  };
}
module.exports = { createChannelDocumentRepository, documentScope, documentPath, MAX_DOCUMENT_BYTES };
