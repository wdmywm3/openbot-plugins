"use strict";

const { normalizeMemory, memoryAvailable, memoryHistoryAvailable, applyMemoryUse, DAY } = require("../features/channels/channel-memory-policy.cjs");
const { contentFromDreamDocument } = require("../features/channels/channel-dream-documents-format.cjs");
const { createHash } = require("node:crypto");
const contentHash = content => createHash("sha256").update(String(content).normalize("NFKC").replace(/\s+/g, "")).digest("hex");
const LEGACY_PLUGIN = "__channel_memory__";
const scopeArgs = scope => {
  const values = [String(scope.channelId || ""), String(scope.chatId || "")];
  if (values.some(value => !value)) throw new Error("Memory requires an instance and a chat");
  return values;
};

function createChannelMemoryRepository(db, { now = Date.now, readDocument, deleteLegacyState } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_memories (
      channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, id TEXT NOT NULL,
      revision INTEGER NOT NULL, entry_json TEXT NOT NULL,
      PRIMARY KEY(channel_id, chat_id, id)
    );
    CREATE TABLE IF NOT EXISTS channel_memory_migrations (
      channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, migrated_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, chat_id)
    );
    CREATE TABLE IF NOT EXISTS channel_memory_revisions (
      channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, memory_id TEXT NOT NULL,
      revision INTEGER NOT NULL, entry_json TEXT NOT NULL,
      PRIMARY KEY(channel_id, chat_id, memory_id, revision)
    );
    CREATE TABLE IF NOT EXISTS channel_memory_turns (
      channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'retrieved',
      session_id TEXT NOT NULL DEFAULT '', answer_message_id TEXT NOT NULL DEFAULT '', answer_hash TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(channel_id, chat_id, turn_id)
    );
    CREATE TABLE IF NOT EXISTS channel_memory_candidates (
      channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(channel_id, chat_id, turn_id, memory_id, revision)
    );
    CREATE TABLE IF NOT EXISTS channel_memory_uses (
      channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      memory_id TEXT NOT NULL, revision INTEGER NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL,
      evidence_json TEXT NOT NULL,
      PRIMARY KEY(channel_id, chat_id, source_message_id, memory_id, revision)
    );
    CREATE TABLE IF NOT EXISTS channel_memory_exclusions(
      channel_id TEXT NOT NULL,chat_id TEXT NOT NULL,content_hash TEXT NOT NULL,sources_json TEXT NOT NULL,
      PRIMARY KEY(channel_id,chat_id,content_hash)
    );
    CREATE TABLE IF NOT EXISTS channel_memory_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      memory_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, entry_created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_memory_changes_date ON channel_memory_changes(channel_id, created_at);
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(channel_memory_turns)").all().map(c => c.name));
  for (const name of ["assessed_seq", "delivered_at", "assessed_candidate_offset"]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE channel_memory_turns ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
  }
  const query = sql => db.prepare(sql);
  const getRow = query("SELECT entry_json FROM channel_memories WHERE channel_id=? AND chat_id=? AND id=?");
  const putRow = query("INSERT INTO channel_memories VALUES(?,?,?,?,?) ON CONFLICT(channel_id,chat_id,id) DO UPDATE SET revision=excluded.revision,entry_json=excluded.entry_json");
  const migrated = query("SELECT 1 FROM channel_memory_migrations WHERE channel_id=? AND chat_id=?");
  function transaction(fn) {
    db.exec("SAVEPOINT channel_memory_write");
    try { const result = fn(); db.exec("RELEASE channel_memory_write"); return result; }
    catch (error) { db.exec("ROLLBACK TO channel_memory_write"); db.exec("RELEASE channel_memory_write"); throw error; }
  }
  const get = (scope, id) => {
    const row = getRow.get(...scopeArgs(scope), String(id));
    return row ? projectDocument(scope, JSON.parse(row.entry_json)) : null;
  };
  const write = (scope, entry) => {
    putRow.run(...scopeArgs(scope), entry.id, entry.revision, JSON.stringify(entry));
    return entry;
  };
  const saveRevision = (scope, entry) => query("INSERT INTO channel_memory_revisions VALUES(?,?,?,?,?)")
    .run(...scopeArgs(scope), entry.id, entry.revision, JSON.stringify(entry));
  const documentFields = entry => ({ content: entry.content, documentRef: entry.documentRef, documentHash: entry.documentHash,
    documentUnavailable: entry.documentUnavailable, documentPending: entry.documentPending, documentTruncated: entry.documentTruncated });
  const provenanceFields = entry => ({ fact: entry.fact, subjectId: entry.subjectId, sourceMessageId: entry.sourceMessageId,
    sourceIds: entry.sourceIds, sources: entry.sources, evidence: entry.evidence, captureMethods: entry.captureMethods, writeIdentity: entry.writeIdentity,
    reviewStatus: entry.reviewStatus, pendingReason: entry.pendingReason, changeType: entry.changeType,
    supersedes: entry.supersedes, supersededBy: entry.supersededBy, validFrom: entry.validFrom, validTo: entry.validTo });
  function projectDocument(scope, raw) {
    const entry = normalizeMemory(raw, now());
    if (!entry.documentRef) return entry;
    let loaded, body = "";
    try {
      loaded = readDocument?.(scope, entry.documentRef);
      if (loaded?.rollbackPending) return { ...entry, documentPending: true };
      if (typeof loaded?.content === "string") body = contentFromDreamDocument(loaded.content).trim();
    } catch { /* Missing and revoked documents are unavailable; their DB cache is not a fallback. */ }
    const readable = typeof loaded?.content === "string";
    const sha256 = readable ? String(loaded.sha256 || createHash("sha256").update(loaded.content).digest("hex")) : entry.documentHash;
    const next = { ...entry, content: body.slice(0, 500), documentHash: sha256,
      documentUnavailable: !body, documentPending: loaded ? loaded.pending === true : entry.documentPending === true,
      documentTruncated: body.length > 500 };
    const changed = readable && (next.documentHash !== entry.documentHash || next.content !== entry.content);
    if (readable && !next.documentPending && next.content !== entry.content
      && next.fact?.contentHash !== createHash("sha256").update(next.content).digest("hex")) next.fact = null;
    if (changed) next.revision = entry.revision + 1;
    if (changed || JSON.stringify(documentFields(next)) !== JSON.stringify(documentFields(entry))) transaction(() => {
      write(scope, next);
      if (changed) saveRevision(scope, next);
      else {
        const base = query("SELECT entry_json FROM channel_memory_revisions WHERE channel_id=? AND chat_id=? AND memory_id=? AND revision=?")
          .get(...scopeArgs(scope), entry.id, entry.revision);
        if (base) query("UPDATE channel_memory_revisions SET entry_json=? WHERE channel_id=? AND chat_id=? AND memory_id=? AND revision=?")
          .run(JSON.stringify({ ...JSON.parse(base.entry_json), ...documentFields(next), ...provenanceFields(next) }), ...scopeArgs(scope), entry.id, entry.revision);
      }

    });
    return next;
  }
  function isMigrated(scope) { return !!migrated.get(...scopeArgs(scope)); }
  function migrate(scope, legacy) {
    const cleanup = () => deleteLegacyState?.({ channelId: scope.channelId, pluginId: LEGACY_PLUGIN, scope: "chat", scopeId: scope.chatId, key: "entries" });
    if (isMigrated(scope)) { cleanup(); return; }
    if (legacy != null && !Array.isArray(legacy)) throw new Error("Invalid legacy chat memories; migration stopped");
    const entries = (legacy || []).map(raw => {
      if (!raw || !raw.id || typeof raw.content !== "string" || !raw.content.trim()) throw new Error("Invalid legacy memory; migration stopped");
      return normalizeMemory(raw, now());
    });
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("Duplicate legacy memory IDs; migration stopped");
    transaction(() => {
      for (const entry of entries) {
        if (get(scope, entry.id)) throw new Error("Memory migration collision");
        write(scope, entry);
        saveRevision(scope, entry);
      }
      query("INSERT INTO channel_memory_migrations VALUES(?,?,?)").run(...scopeArgs(scope), now());
      query("DELETE FROM channel_plugin_state WHERE channel_id=? AND scope='chat' AND scope_id=? AND plugin_id=? AND state_key='entries'")
        .run(...scopeArgs(scope), LEGACY_PLUGIN);
    });
    cleanup();
  }
  function list(scope, { includeExpired = false, query: search = "" } = {}) {
    const needle = String(search).slice(0, 200).toLowerCase();
    return query("SELECT entry_json FROM channel_memories WHERE channel_id=? AND chat_id=? ORDER BY rowid")
      .all(...scopeArgs(scope)).map(row => projectDocument(scope, JSON.parse(row.entry_json)))
      .filter(entry => (includeExpired || memoryAvailable(entry, now())) && (!needle || JSON.stringify(entry).toLowerCase().includes(needle)));
  }
  function save(scope, raw, expectedRevision = null) {
    return transaction(() => {
      const previous = get(scope, raw.id);
      if (expectedRevision !== null && (previous?.revision || 0) !== expectedRevision) throw new Error("Memory changed; read it again before updating");
      if (previous && raw.content === previous.content) {
        const next = normalizeMemory({ ...previous, ...raw, revision: previous.revision }, now());
        write(scope, next);
        const base = JSON.parse(query("SELECT entry_json FROM channel_memory_revisions WHERE channel_id=? AND chat_id=? AND memory_id=? AND revision=?")
          .get(...scopeArgs(scope), next.id, next.revision).entry_json);
        // Retention changes are metadata, not a new fact. Keep past use reversible.
        query("UPDATE channel_memory_revisions SET entry_json=? WHERE channel_id=? AND chat_id=? AND memory_id=? AND revision=?")
          .run(JSON.stringify({ ...base, retention: next.retention, pinned: next.pinned, expiresAt: next.expiresAt,
            promotedAt: next.promotedAt, knowledgeDocumentId: next.knowledgeDocumentId,
            knowledgeCollection: next.knowledgeCollection, ...documentFields(next), ...provenanceFields(next) }), ...scopeArgs(scope), next.id, next.revision);
        return projectDocument(scope, next);
      }
      const next = normalizeMemory({ ...previous, ...raw, revision: (previous?.revision || 0) + 1 }, now());
      if (!next.id || !next.content) throw new Error("Memory ID and content are required");
      write(scope, next);
      saveRevision(scope, next);
      query("INSERT INTO channel_memory_changes(channel_id,chat_id,memory_id,kind,created_at,entry_created_at) VALUES(?,?,?,?,?,?)")
        .run(...scopeArgs(scope), next.id, previous ? "updated" : "created", now(), next.createdAt || now());

      return projectDocument(scope, next);
    });
  }
  function remove(scope, id) {
    return transaction(() => {
      const entry = get(scope, id);
      if (entry) exclude(scope, entry);
      if (entry) query("INSERT INTO channel_memory_changes(channel_id,chat_id,memory_id,kind,created_at,entry_created_at) VALUES(?,?,?,?,?,?)")
        .run(...scopeArgs(scope), String(id), "deleted", now(), entry.createdAt || 0);
      for (const [table, column] of [["channel_memories", "id"], ["channel_memory_revisions", "memory_id"], ["channel_memory_candidates", "memory_id"], ["channel_memory_uses", "memory_id"]]) {
        query(`DELETE FROM ${table} WHERE channel_id=? AND chat_id=? AND ${column}=?`).run(...scopeArgs(scope), String(id));
      }
    });
  }
  function revisionFamily(scope, id) {
    const rows = list(scope, { includeExpired: true }), ids = new Set([String(id)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of rows) if (ids.has(entry.id) || ids.has(entry.supersedes?.id) || ids.has(entry.supersededBy?.id)) {
        for (const linked of [entry.id, entry.supersedes?.id, entry.supersededBy?.id].filter(Boolean)) {
          if (!ids.has(linked)) { ids.add(linked); changed = true; }
        }
      }
    }
    return rows.filter(entry => ids.has(entry.id));
  }
  function history(scope, { id = "", includePending = false } = {}) {
    const liveEntries = id ? revisionFamily(scope, id) : list(scope, { includeExpired: true });
    return liveEntries.filter(entry => memoryHistoryAvailable(entry, { includePending })
      && !excluded(scope, entry.content, entry.sourceIds || [entry.sourceMessageId])).flatMap(entry => {
      const rows = query("SELECT entry_json FROM channel_memory_revisions WHERE channel_id=? AND chat_id=? AND memory_id=? ORDER BY revision")
        .all(...scopeArgs(scope), entry.id).map(row => normalizeMemory(JSON.parse(row.entry_json), now()));
      return rows.map(row => row.revision === entry.revision ? entry : row).filter(row =>
        memoryHistoryAvailable(row, { includePending })
        && !excluded(scope, row.content, row.sourceIds || [row.sourceMessageId])).map(row => ({ ...row,
          historicalStatus: row.reviewStatus === "pending" ? "pending" : row.supersededBy?.changeType === "correction" ? "corrected"
            : row.supersededBy || row.revision !== entry.revision ? "historical" : "current" }));
    });
  }
  function exclude(scope, entry) {
    query("INSERT OR REPLACE INTO channel_memory_exclusions VALUES(?,?,?,?)")
      .run(...scopeArgs(scope), contentHash(entry.content), JSON.stringify(entry.sourceIds || [entry.sourceMessageId].filter(Boolean)));
  }
  function excluded(scope, content, sourceIds = []) {
    return query("SELECT content_hash,sources_json FROM channel_memory_exclusions WHERE channel_id=? AND chat_id=?")
      .all(...scopeArgs(scope)).some(row => row.content_hash === contentHash(content)
        || (sourceIds.length && sourceIds.every(id => JSON.parse(row.sources_json).includes(id))));
  }
  function invalidateSource(scope, sourceId, event) {
    for (const entry of list(scope, { includeExpired: true })) {
      if (!(entry.sourceIds || [entry.sourceMessageId]).includes(sourceId)) continue;
      const evidence = (entry.evidence || []).filter(item => item.id === sourceId);
      if (event && !event.deleted && !event.routeBlocked && evidence.length
        && evidence.every(item => String(event.content || "").includes(item.quote))) continue;
      write(scope, { ...entry, invalidatedAt: now(), sourceRevoked: true });

    }
  }
  function invalidateFact(scope, id, revision, evidence) {
    const entry = get(scope, id);
    if (!entry || entry.revision !== revision) return false;
    const invalidatedAt = now();
    write(scope, { ...entry, invalidatedAt, correctionEvidence: evidence });
    const row = query("SELECT entry_json FROM channel_memory_revisions WHERE channel_id=? AND chat_id=? AND memory_id=? AND revision=?")
      .get(...scopeArgs(scope), id, revision);
    query("UPDATE channel_memory_revisions SET entry_json=? WHERE channel_id=? AND chat_id=? AND memory_id=? AND revision=?")
      .run(JSON.stringify({ ...JSON.parse(row.entry_json), invalidatedAt, correctionEvidence: evidence }), ...scopeArgs(scope), id, revision);

    return true;
  }

  function recordRecall(scope, turnId, sourceMessageId, entries) {
    if (!turnId || !sourceMessageId || !entries.length) return;
    transaction(() => {
      query("INSERT OR IGNORE INTO channel_memory_turns(channel_id,chat_id,turn_id,source_message_id,created_at) VALUES(?,?,?,?,?)")
        .run(...scopeArgs(scope), turnId, sourceMessageId, now());
      const turn = query("SELECT * FROM channel_memory_turns WHERE channel_id=? AND chat_id=? AND turn_id=?").get(...scopeArgs(scope), turnId);
      if (turn.source_message_id !== sourceMessageId || turn.status !== "retrieved") return;
      for (const candidate of entries.slice(0, 20)) {
        const entry = get(scope, candidate.id);
        if (!entry || entry.revision !== candidate.revision || !memoryAvailable(entry, now())) continue;
        const added = query("INSERT OR IGNORE INTO channel_memory_candidates VALUES(?,?,?,?,?)")
          .run(...scopeArgs(scope), turnId, entry.id, entry.revision);
        if (added.changes) write(scope, { ...entry, retrievedCount: entry.retrievedCount + 1 });
      }
    });
  }
  function recordDelivery(scope, turnId, { sessionId, answerMessageId, answerHash }) {
    if (!sessionId || !answerMessageId || !/^[a-f0-9]{64}$/.test(answerHash || "")) throw new Error("Delivered memory turn requires a persisted answer reference and hash");
    query("UPDATE channel_memory_turns SET status='pending',session_id=?,answer_message_id=?,answer_hash=?,delivered_at=? WHERE channel_id=? AND chat_id=? AND turn_id=? AND status='retrieved'")
      .run(sessionId, answerMessageId, answerHash, now(), ...scopeArgs(scope), turnId);
  }
  function pendingAssessments(scope, limit = 20, upper = null, cutoff = now()) {
    return query(`SELECT * FROM channel_memory_turns WHERE channel_id=? AND chat_id=?
      AND status IN ('pending','assessed') AND (delivered_at=0 OR delivered_at<=?)
      AND (? IS NULL OR status='pending' OR assessed_seq<?)
      ORDER BY assessed_seq,created_at LIMIT ?`)
      .all(...scopeArgs(scope), cutoff, upper, upper, Math.max(1, Math.min(100, limit))).map(turn => ({
        turnId: turn.turn_id, sourceMessageId: turn.source_message_id, createdAt: turn.created_at,
        assessedSeq: turn.assessed_seq, candidateOffset: turn.assessed_candidate_offset,
        sessionId: turn.session_id, answerMessageId: turn.answer_message_id, answerHash: turn.answer_hash,
        previousOutcomes: query("SELECT memory_id AS id,revision,outcome,evidence_json FROM channel_memory_uses WHERE channel_id=? AND chat_id=? AND source_message_id=?")
          .all(...scopeArgs(scope), turn.source_message_id).map(row => ({ id: row.id, revision: row.revision,
            outcome: row.outcome, evidenceRefs: JSON.parse(row.evidence_json) })),
        candidates: query(`SELECT m.entry_json FROM channel_memory_candidates c JOIN channel_memory_revisions m
          ON m.channel_id=c.channel_id AND m.chat_id=c.chat_id AND m.memory_id=c.memory_id AND m.revision=c.revision
          WHERE c.channel_id=? AND c.chat_id=? AND c.turn_id=? ORDER BY c.memory_id,c.revision`)
          .all(...scopeArgs(scope), turn.turn_id).map(row => JSON.parse(row.entry_json)).filter(entry => {
            if (!entry.documentRef) return true;
            const live = get(scope, entry.id);
            return live?.revision === entry.revision && !live.documentUnavailable && !live.documentPending;
          }),
      }));
  }
  // Called by the host Dream evaluator, never by an agent tool. The caller
  // must resolve evidence in this scope and verify the persisted answer/hash first.
  function applyDreamAssessment(scope, turnId, outcomes) {
    return transaction(() => {
      const turn = query("SELECT * FROM channel_memory_turns WHERE channel_id=? AND chat_id=? AND turn_id=? AND status IN ('pending','assessed')")
        .get(...scopeArgs(scope), turnId);
      if (!turn) return [];
      const changed = [];
      for (const result of outcomes.slice(0, 20)) {
        if (!["used", "not_used", "retrieval_error", "misapplied", "contradicted"].includes(result.outcome)) continue;
        if (!Array.isArray(result.evidenceRefs) || !result.evidenceRefs.length
          || result.evidenceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 200)) continue;
        const candidate = query("SELECT 1 FROM channel_memory_candidates WHERE channel_id=? AND chat_id=? AND turn_id=? AND memory_id=? AND revision=?")
          .get(...scopeArgs(scope), turnId, result.id, result.revision);
        const entry = candidate && get(scope, result.id);
        if (!entry || entry.sourceRevoked || entry.documentUnavailable || entry.documentPending || entry.revision !== result.revision || (entry.expiresAt && entry.expiresAt <= now())) continue;
        query(`INSERT INTO channel_memory_uses VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,chat_id,source_message_id,memory_id,revision)
          DO UPDATE SET outcome=excluded.outcome,created_at=excluded.created_at,evidence_json=excluded.evidence_json`)
          .run(...scopeArgs(scope), turn.source_message_id, entry.id, entry.revision, result.outcome,
            turn.delivered_at || turn.created_at, JSON.stringify(result.evidenceRefs.slice(0, 10)));
        // Rebuild reinforcement from this content revision's base, so a later correction
        // can retract an earlier credit instead of adding a second, contradictory score.
        const base = query("SELECT entry_json FROM channel_memory_revisions WHERE channel_id=? AND chat_id=? AND memory_id=? AND revision=?")
          .get(...scopeArgs(scope), entry.id, entry.revision);
        let learned = normalizeMemory(JSON.parse(base.entry_json), now());
        const uses = query("SELECT outcome,created_at FROM channel_memory_uses WHERE channel_id=? AND chat_id=? AND memory_id=? AND revision=? ORDER BY created_at,source_message_id")
          .all(...scopeArgs(scope), entry.id, entry.revision);
        for (const use of uses) learned = applyMemoryUse(learned, use.outcome, use.created_at);
        if (learned.invalidatedAt) learned.invalidatedAt = entry.invalidatedAt || now();
        changed.push(write(scope, { ...learned, ...documentFields(entry), retrievedCount: entry.retrievedCount }));
      }
      return changed;
    });
  }
  function pruneReceipts() {
    transaction(() => {
      query(`DELETE FROM channel_memory_candidates WHERE EXISTS(SELECT 1 FROM channel_memory_turns t
        WHERE t.channel_id=channel_memory_candidates.channel_id AND t.chat_id=channel_memory_candidates.chat_id
        AND t.turn_id=channel_memory_candidates.turn_id AND t.status='retrieved' AND t.created_at<?)`).run(now() - 30 * DAY);
      // Pending judgments need later conversation evidence. Do not age them out
      // before Dream has had an opportunity to assess them.
      query("DELETE FROM channel_memory_turns WHERE status='retrieved' AND created_at<?").run(now() - 30 * DAY);
    });
  }
  pruneReceipts();
  return {
    transaction, isMigrated, migrate, get, list, save, remove, revisionFamily, history, exclude, excluded, invalidateSource, invalidateFact, recordRecall, recordDelivery, pendingAssessments, applyDreamAssessment,
    completeAssessment(scope, turnId, upper) {
      query("UPDATE channel_memory_turns SET status='assessed',assessed_seq=?,assessed_candidate_offset=0 WHERE channel_id=? AND chat_id=? AND turn_id=? AND status IN ('pending','assessed')")
        .run(upper, ...scopeArgs(scope), turnId);
    },
    advanceAssessmentCandidates(scope, turnId, offset) {
      query("UPDATE channel_memory_turns SET assessed_candidate_offset=? WHERE channel_id=? AND chat_id=? AND turn_id=? AND status IN ('pending','assessed')")
        .run(offset, ...scopeArgs(scope), turnId);
    },
    overview(channelId, start, end) {
      const entries = query("SELECT chat_id,entry_json FROM channel_memories WHERE channel_id=?").all(String(channelId));
      const created = new Set(), updated = new Set(), deleted = new Set();
      let total = 0;
      const inDay = value => Number(value) >= start && Number(value) < end;
      for (const row of entries) {
        const entry = JSON.parse(row.entry_json), key = JSON.stringify([row.chat_id, entry.id]);
        if (memoryAvailable(entry, now())) total++;
        if (inDay(entry.createdAt)) created.add(key);
        if (inDay(entry.updatedAt) && entry.updatedAt !== entry.createdAt) updated.add(key);
      }
      for (const row of query("SELECT chat_id,memory_id,kind,entry_created_at FROM channel_memory_changes WHERE channel_id=? AND created_at>=? AND created_at<?").all(String(channelId), start, end)) {
        const key = JSON.stringify([row.chat_id, row.memory_id]);
        if (row.kind === "created" || inDay(row.entry_created_at)) created.add(key);
        if (row.kind === "updated") updated.add(key);
        if (row.kind === "deleted") deleted.add(key);
      }
      return { total, todayCreated: created.size, todayUpdated: updated.size, todayDeleted: deleted.size };
    },
    deleteChannel(channelId) {
      query("DELETE FROM channel_memory_changes WHERE channel_id=?").run(String(channelId));
      for (const table of ["channel_memories", "channel_memory_migrations", "channel_memory_revisions", "channel_memory_turns", "channel_memory_candidates", "channel_memory_uses", "channel_memory_exclusions"]) {
        query(`DELETE FROM ${table} WHERE channel_id=?`).run(String(channelId));
      }
    },
  };
}

module.exports = { createChannelMemoryRepository };
