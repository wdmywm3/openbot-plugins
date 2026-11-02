"use strict";

const { createHash } = require("node:crypto");
const { gunzipSync, gzipSync } = require("node:zlib");
const { normalizeDreamSettings, isPrivateDreamScope } = require("../features/channels/channel-dream-settings.cjs");
const { contentFromDreamDocument } = require("../features/channels/channel-dream-documents-format.cjs");
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const scopeArgs = scope => {
  if (!scope.channelId || !scope.chatId) throw new Error("Dream requires an instance and a chat");
  return [String(scope.channelId), String(scope.chatId)];
};

// The journal freezes the evidence seen by a job. Compression and other storage
// maintenance must not create new conversational evidence.
function createChannelDreamRepository(db, { now = Date.now, readDocument } = {}) {
  const runs = require("./channel-dream-run-repository.cjs").createDreamRunRepository(db, now);
  const rollback = require("./channel-dream-rollback.cjs").createDreamRollback(db, { now });
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_dream_changes(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      event_id TEXT NOT NULL, observed_at INTEGER NOT NULL, encoding TEXT NOT NULL, event_json BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dream_changes_scope ON channel_dream_changes(channel_id,chat_id,seq);
    CREATE INDEX IF NOT EXISTS idx_dream_changes_event ON channel_dream_changes(channel_id,chat_id,event_id,seq);
    CREATE TABLE IF NOT EXISTS channel_dream_state(
      channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY(channel_id,chat_id)
    );
    CREATE TABLE IF NOT EXISTS channel_dream_topics(
      channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, id TEXT NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY(channel_id,chat_id,id)
    );
    CREATE TABLE IF NOT EXISTS channel_dream_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_dream_deferred(
      channel_id TEXT NOT NULL,chat_id TEXT NOT NULL,event_id TEXT NOT NULL,created_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id,chat_id,event_id)
    );
    CREATE TABLE IF NOT EXISTS channel_dream_records(
      channel_id TEXT NOT NULL,chat_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,
      revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,value_json TEXT NOT NULL,
      PRIMARY KEY(channel_id,chat_id,id)
    );
    CREATE INDEX IF NOT EXISTS idx_dream_records_scope ON channel_dream_records(channel_id,chat_id,updated_at);
    CREATE TABLE IF NOT EXISTS channel_dream_message_notes(
      channel_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,value_json TEXT NOT NULL,
      PRIMARY KEY(channel_id,chat_id,message_id)
    );
  `);
  const q = sql => db.prepare(sql);
  function transaction(fn) {
    db.exec("SAVEPOINT dream_write");
    try { const result = fn(); db.exec("RELEASE dream_write"); return result; }
    catch (error) { db.exec("ROLLBACK TO dream_write"); db.exec("RELEASE dream_write"); throw error; }
  }
  // Seed once, before installing the triggers; existing history is analyzed too.
  transaction(() => {
    if (!q("SELECT 1 FROM channel_dream_meta WHERE key='seeded'").get()) {
      q(`INSERT INTO channel_dream_changes(channel_id,chat_id,event_id,observed_at,encoding,event_json)
        SELECT channel_id,chat_id,event_id,?,event_encoding,event_json FROM channel_events
        ORDER BY created_at,rowid`).run(now());
      q("INSERT INTO channel_dream_meta VALUES('seeded','1')").run();
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS dream_event_insert AFTER INSERT ON channel_events BEGIN
        INSERT INTO channel_dream_changes(channel_id,chat_id,event_id,observed_at,encoding,event_json)
        VALUES(NEW.channel_id,NEW.chat_id,NEW.event_id,CAST(unixepoch('subsec')*1000 AS INTEGER),NEW.event_encoding,NEW.event_json);
      END;
      CREATE TRIGGER IF NOT EXISTS dream_event_update AFTER UPDATE ON channel_events
      WHEN NEW.search_text<>OLD.search_text OR NEW.searchable<>OLD.searchable OR NEW.sender_id<>OLD.sender_id BEGIN
        INSERT INTO channel_dream_changes(channel_id,chat_id,event_id,observed_at,encoding,event_json)
        VALUES(NEW.channel_id,NEW.chat_id,NEW.event_id,CAST(unixepoch('subsec')*1000 AS INTEGER),NEW.event_encoding,NEW.event_json);
      END;
      CREATE TRIGGER IF NOT EXISTS dream_event_delete AFTER DELETE ON channel_events BEGIN
        INSERT INTO channel_dream_changes(channel_id,chat_id,event_id,observed_at,encoding,event_json)
        VALUES(OLD.channel_id,OLD.chat_id,OLD.event_id,CAST(unixepoch('subsec')*1000 AS INTEGER),'json',
          json_object('id',OLD.event_id,'chatId',OLD.chat_id,'deleted',json('true'),'content',''));
      END;
    `);
  });
  function defaults(channelId) {
    const row = q("SELECT value FROM channel_dream_meta WHERE key=?").get(`settings:${channelId}`);
    return normalizeDreamSettings(row ? JSON.parse(row.value) : {});
  }
  function state(scope) {
    const row = q("SELECT value_json FROM channel_dream_state WHERE channel_id=? AND chat_id=?").get(...scopeArgs(scope));
    const stored = row ? JSON.parse(row.value_json) : {};
    return { cursor: 0, offset: 0, job: null, pending: [], style: null, styleVersion: 0,
      nextRun: 0, ...stored, settings: normalizeDreamSettings(stored.settingsOverride || {}, defaults(scope.channelId)) };
  }
  function saveState(scope, value) {
    const { settings, ...stored } = value;
    q(`INSERT INTO channel_dream_state VALUES(?,?,?) ON CONFLICT(channel_id,chat_id)
      DO UPDATE SET value_json=excluded.value_json`).run(...scopeArgs(scope), JSON.stringify(stored));
    return value;
  }
  function begin(scope, trigger = "manual") {
    const current = state(scope);
    if (current.job) return current;
    const cutoff = now();
    transaction(() => {
      const deferred = q("SELECT event_id FROM channel_dream_deferred WHERE channel_id=? AND chat_id=? AND created_at<=? LIMIT 1000")
        .all(...scopeArgs(scope), cutoff);
      for (const row of deferred) {
        const event = source(scope, row.event_id, Number.MAX_SAFE_INTEGER);
        if (event?.createdAt > cutoff) { defer(scope, event); continue; }
        if (event) q("INSERT INTO channel_dream_changes(channel_id,chat_id,event_id,observed_at,encoding,event_json) VALUES(?,?,?,?,?,?)")
          .run(...scopeArgs(scope), event.id, cutoff, "json", JSON.stringify(event));
        q("DELETE FROM channel_dream_deferred WHERE channel_id=? AND chat_id=? AND event_id=?").run(...scopeArgs(scope), row.event_id);
      }
    });
    // Freeze committed revisions by sequence, not by two independent wall
    // clocks: SQLite's observation time may be slightly ahead of Date.now().
    // The job's cutoff still defers future event timestamps during extraction.
    const upper = Number(q("SELECT MAX(seq) AS seq FROM channel_dream_changes WHERE channel_id=? AND chat_id=?")
      .get(...scopeArgs(scope))?.seq || current.cursor);
    return saveState(scope, { ...current, job: { upper, cutoff, startedAt: cutoff, trigger, scheduledFor: current.nextRun }, error: "" });
  }
  function decode(row) {
    const event = JSON.parse(row.encoding === "gzip" ? gunzipSync(Buffer.from(row.event_json)).toString("utf8") : row.event_json);
    return { ...event, id: row.event_id, createdAt: Number(event.createdAt || row.observed_at), seq: Number(row.seq) };
  }
  function page(scope, cursor, upper, limit = 60) {
    return q("SELECT * FROM channel_dream_changes WHERE channel_id=? AND chat_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?")
      .all(...scopeArgs(scope), cursor, upper, Math.max(1, Math.min(60, limit))).map(decode);
  }
  function source(scope, id, upper, cutoff = Number.MAX_SAFE_INTEGER) {
    for (const row of q("SELECT * FROM channel_dream_changes WHERE channel_id=? AND chat_id=? AND event_id=? AND seq<=? ORDER BY seq DESC")
      .iterate(...scopeArgs(scope), String(id), upper)) {
      const event = decode(row);
      if (event.createdAt <= cutoff) return event;
    }
    return null;
  }
  function defer(scope, event) {
    q("INSERT OR REPLACE INTO channel_dream_deferred VALUES(?,?,?,?)")
      .run(...scopeArgs(scope), event.id, event.createdAt);
  }
  function putTopic(scope, topic) {
    const id = hash(JSON.stringify([topic.title, topic.sourceIds.slice().sort()])).slice(0, 32);
    q("INSERT OR REPLACE INTO channel_dream_topics VALUES(?,?,?,?)").run(...scopeArgs(scope), id, JSON.stringify({ ...topic, id }));
  }
  function removeDerived(scope, sourceIds) {
    const ids = new Set(sourceIds);
    for (const row of q("SELECT id,value_json FROM channel_dream_topics WHERE channel_id=? AND chat_id=?").all(...scopeArgs(scope))) {
      if (JSON.parse(row.value_json).sourceIds.some(id => ids.has(id))) {
        q("DELETE FROM channel_dream_topics WHERE channel_id=? AND chat_id=? AND id=?").run(...scopeArgs(scope), row.id);
      }
    }
    const current = state(scope);
    const styleRevoked = current.style?.evidence?.some(e => ids.has(e.id));
    saveState(scope, { ...current, pending: current.pending.filter(t => !t.sourceIds.some(id => ids.has(id))),
      ...(styleRevoked ? { style: null, styleVersion: current.styleVersion + 1 } : {}) });
    for (const row of q("SELECT id FROM channel_dream_records WHERE channel_id=? AND chat_id=?").all(...scopeArgs(scope))) {
      const entry = getRecord(scope, row.id);
      if ((entry.sourceIds || []).some(id => ids.has(id))) saveRecord(scope, { ...entry, status: "invalidated" }, entry.revision);
    }
  }
  function activity(scope) {
    const row = q("SELECT seq,observed_at FROM channel_dream_changes WHERE channel_id=? AND chat_id=? ORDER BY seq DESC LIMIT 1").get(...scopeArgs(scope));
    return { seq: Number(row?.seq || 0), at: Number(row?.observed_at || 0) };
  }
  function recordMaterial(scope, material) {
    const content = String(material.content || "");
    if (!content && !material.deleted || Buffer.byteLength(content) > 8 * 1024 * 1024) return null;
    const id = String(material.id || `material-${hash(JSON.stringify([material.source, material.provenance, content])).slice(0, 40)}`);
    const previous = source(scope, id, Number.MAX_SAFE_INTEGER);
    if (previous && previous.content === content && previous.version === material.version && !!previous.deleted === !!material.deleted
      && JSON.stringify(previous.noteRefs || []) === JSON.stringify(material.noteRefs || [])) return id;
    const event = { ...material, id, chatId: scope.chatId, direction: material.direction || "out", createdAt: material.createdAt || now(),
      sender: material.sender || { id: "bot", name: "bot" }, content };
    const json = JSON.stringify(event), compressed = Buffer.byteLength(json) > 16000;
    q("INSERT INTO channel_dream_changes(channel_id,chat_id,event_id,observed_at,encoding,event_json) VALUES(?,?,?,?,?,?)")
      .run(...scopeArgs(scope), id, now(), compressed ? "gzip" : "json", compressed ? gzipSync(json) : json);
    return id;
  }
  function getRecord(scope, id) {
    const row = q("SELECT value_json FROM channel_dream_records WHERE channel_id=? AND chat_id=? AND id=?").get(...scopeArgs(scope), String(id));
    return row ? projectDocument(scope, JSON.parse(row.value_json)) : null;
  }
  function writeRecord(scope, record) {
    q(`INSERT INTO channel_dream_records VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel_id,chat_id,id)
      DO UPDATE SET kind=excluded.kind,revision=excluded.revision,updated_at=excluded.updated_at,value_json=excluded.value_json`)
      .run(...scopeArgs(scope), record.id, record.kind, record.revision, record.updatedAt, JSON.stringify(record));
    return record;
  }
  function projectDocument(scope, entry) {
    if (!entry.documentRef) return entry;
    let loaded, body = "";
    try {
      loaded = readDocument?.(scope, entry.documentRef);
      if (loaded?.rollbackPending) return { ...entry, documentPending: true };
      if (typeof loaded?.content === "string") body = contentFromDreamDocument(loaded.content).trim();
    } catch { /* Only the document service can resolve a readable, authorized artifact. */ }
    const readable = typeof loaded?.content === "string";
    const sha256 = readable ? String(loaded.sha256 || hash(loaded.content)) : entry.documentHash;
    const next = { ...entry, content: body.slice(0, 3000), documentHash: sha256,
      documentUnavailable: !body, documentPending: loaded ? loaded.pending === true : entry.documentPending === true,
      documentTruncated: body.length > 3000 };
    if (readable && (next.documentHash !== entry.documentHash || next.content !== entry.content)) next.revision = Number(entry.revision || 0) + 1;
    // Only derived text and its version change. Cancellation, source revocation,
    // schedules and task receipts remain authoritative in the database.
    if (JSON.stringify(next) !== JSON.stringify(entry)) writeRecord(scope, next);
    return next;
  }
  function records(scope, { query = "", kind = "", includeClosed = false, includeInvalidated = false, limit = 40, from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
    const needle = String(query).slice(0, 200).toLowerCase();
    // Refresh before searching and limiting: a file edit may introduce the only
    // matching word, which cannot be found by filtering the stale SQL cache.
    return q("SELECT value_json FROM channel_dream_records WHERE channel_id=? AND chat_id=? ORDER BY updated_at DESC,id")
      .all(...scopeArgs(scope)).map(row => projectDocument(scope, JSON.parse(row.value_json)))
      .filter(entry => {
        const at = entry.occurredAt ?? entry.updatedAt, status = entry.status || "active";
        return !entry.documentUnavailable && !entry.documentPending && (!kind || entry.kind === kind)
          && at >= from && at <= to && (includeInvalidated || status !== "invalidated")
          && (includeClosed || !["completed", "closed", "canceled", "invalidated"].includes(status))
          && (!needle || JSON.stringify(entry).toLowerCase().includes(needle));
      }).slice(0, Math.max(1, Math.min(200, limit)));
  }
  // Maintenance scans include every status and use immutable IDs: updating a
  // record during a page must not move it across an updated_at cursor.
  function recordPage(scope, { kind = "", after = "", limit = 200, query = "" } = {}) {
    const pageSize = Math.max(1, Math.min(200, Math.floor(Number(limit) || 200)));
    const needle = String(query).slice(0, 200).toLowerCase();
    const rows = q(`SELECT value_json FROM channel_dream_records WHERE channel_id=? AND chat_id=?
      AND (?='' OR kind=?) AND id>? ORDER BY id LIMIT ?`)
      .all(...scopeArgs(scope), kind, kind, String(after || ""), needle ? -1 : pageSize + 1).map(row => projectDocument(scope, JSON.parse(row.value_json)))
      .filter(entry => !needle || JSON.stringify(entry).toLowerCase().includes(needle));
    const page = rows.slice(0, pageSize);
    return { records: page, nextCursor: rows.length > pageSize ? page.at(-1).id : null };
  }
  function saveRecord(scope, value, expectedRevision = 0) {
    if (!["episode", "goal", "question", "followup"].includes(value.kind)) throw new Error("未知梦境记录类别");
    if (!isPrivateDreamScope(scope) && value.kind !== "episode") throw new Error("群聊只能保存事实经历");
    const previous = getRecord(scope, value.id);
    if (Number(previous?.revision || 0) !== Number(expectedRevision)) throw Object.assign(new Error("梦境记录已变化，请重新读取"), { code: "DREAM_RECORD_CONFLICT" });
    const record = { ...previous, ...value, revision: Number(expectedRevision) + 1, createdAt: previous?.createdAt || now(), updatedAt: now() };
    writeRecord(scope, record);
    return projectDocument(scope, record);
  }
  function topics(scope, { query = "", senderId = "", from = 0, to = Number.MAX_SAFE_INTEGER, limit = 30 } = {}) {
    // Parameterized and escaped LIKE, matching Chinese text as well as keywords.
    const escaped = String(query).slice(0, 200).replace(/[\\%_]/g, "\\$&");
    return q(`SELECT value_json FROM channel_dream_topics WHERE channel_id=? AND chat_id=?
      AND json_extract(value_json,'$.to')>=? AND json_extract(value_json,'$.from')<=?
      AND (?='' OR EXISTS(SELECT 1 FROM json_each(json_extract(value_json,'$.participants')) WHERE value=?))
      AND value_json LIKE ? ESCAPE '\\' ORDER BY rowid DESC LIMIT ?`)
      .all(...scopeArgs(scope), from, to, senderId, senderId, `%${escaped}%`, Math.max(1, Math.min(50, limit)))
      .map(row => JSON.parse(row.value_json));
  }
  return {
    runs, rollback, transaction, state, saveState, begin, page, source, putTopic, topics, defaults, removeDerived, defer,
    activity, recordMaterial, records, recordPage, getRecord, saveRecord,
    requeueSources(scope, ids) {
      for (const id of new Set(ids.filter(Boolean))) {
        const event = source(scope, id, Number.MAX_SAFE_INTEGER);
        if (!event || event.deleted) continue;
        const json = JSON.stringify(event), compressed = Buffer.byteLength(json) > 16000;
        q("INSERT INTO channel_dream_changes(channel_id,chat_id,event_id,observed_at,encoding,event_json) VALUES(?,?,?,?,?,?)")
          .run(...scopeArgs(scope), id, now(), compressed ? "gzip" : "json", compressed ? gzipSync(json) : json);
      }
    },
    linkMessageNotes(scope, messageId, noteRefs) {
      q("INSERT OR REPLACE INTO channel_dream_message_notes VALUES(?,?,?,?)").run(...scopeArgs(scope), String(messageId), JSON.stringify(noteRefs));
    },
    messageNotes(scope, messageId) {
      const row = q("SELECT value_json FROM channel_dream_message_notes WHERE channel_id=? AND chat_id=? AND message_id=?").get(...scopeArgs(scope), String(messageId));
      return row ? JSON.parse(row.value_json) : [];
    },
    exportConfiguration(channelId) {
      return { channelId, defaults: defaults(channelId), overrides: q("SELECT chat_id,value_json FROM channel_dream_state WHERE channel_id=?").all(channelId)
        .map(row => ({ chatId: row.chat_id, settings: JSON.parse(row.value_json).settingsOverride ?? null })) };
    },
    importConfiguration(config) {
      transaction(() => {
        q("INSERT OR REPLACE INTO channel_dream_meta VALUES(?,?)").run(`settings:${config.channelId}`, JSON.stringify(config.defaults));
        for (const row of config.overrides) {
          const scope = { channelId: config.channelId, chatId: row.chatId };
          saveState(scope, { ...state(scope), settingsOverride: row.settings, nextRun: 0 });
        }
      });
    },
    recordExperience(scope, { taskId, pluginId, content, result, noteRefs }) {
      const id = `experience-${hash(taskId).slice(0, 32)}`;
      if (!result && source(scope, id, Number.MAX_SAFE_INTEGER)) return id;
      return recordMaterial(scope, { id, content: result ? JSON.stringify({ summary: content, ...result }) : content,
        source: "task_report", noteRefs, provenance: { taskId, pluginId, kind: "delegated_report" } });
    },
    setDefaults(channelId, settings) {
      q("INSERT OR REPLACE INTO channel_dream_meta VALUES(?,?)").run(`settings:${channelId}`, JSON.stringify(normalizeDreamSettings(settings)));
    },
    scopes: () => q(`SELECT channel_id AS channelId,chat_id AS chatId FROM channel_dream_changes GROUP BY channel_id,chat_id
      UNION SELECT channel_id,chat_id FROM channel_dream_state`).all(),
    deleteChannel(id) {
      rollback.deleteChannel(id);
      runs.deleteChannel(id);
      q("DELETE FROM channel_dream_meta WHERE key=?").run(`settings:${id}`);
      for (const table of ["channel_dream_changes", "channel_dream_state", "channel_dream_topics", "channel_dream_deferred", "channel_dream_records", "channel_dream_message_notes"]) {
        q(`DELETE FROM ${table} WHERE channel_id=?`).run(String(id));
      }
    },
  };
}

module.exports = { createChannelDreamRepository, hash };
