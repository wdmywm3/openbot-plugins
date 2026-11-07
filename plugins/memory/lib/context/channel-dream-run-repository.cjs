"use strict";
const { randomUUID } = require("node:crypto");
const { encodeRecord, decodeRecord } = require("../plugins/plugin-record-codec.cjs");
const labels = { materials: "资料片段", memories: "新增记忆", records: "保存事项", topics: "更新话题", assessments: "评估记忆", removed: "清理记忆", invalidated: "撤销记忆", style: "调整交流偏好" };

function createDreamRunRepository(db, now = Date.now) {
  const activity = require("./task-activity-index.cjs").createTaskActivityIndex(db);
  db.exec(`CREATE TABLE IF NOT EXISTS channel_dream_runs(channel_id TEXT NOT NULL,chat_id TEXT NOT NULL,id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(channel_id,chat_id,id));
    CREATE TABLE IF NOT EXISTS channel_dream_run_payloads(hash TEXT PRIMARY KEY,encoding TEXT NOT NULL,bytes INTEGER NOT NULL,data BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_dream_run_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,channel_id TEXT NOT NULL,chat_id TEXT NOT NULL,run_id TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL,payload_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS dream_run_events_scope ON channel_dream_run_events(channel_id,chat_id,run_id,seq);
    CREATE INDEX IF NOT EXISTS dream_run_events_payload ON channel_dream_run_events(payload_hash);`);
  const args = scope => [String(scope.channelId), String(scope.chatId)];
  const get = (scope, id) => {
    const row = db.prepare("SELECT value_json FROM channel_dream_runs WHERE channel_id=? AND chat_id=? AND id=?").get(...args(scope), id);
    return row ? JSON.parse(row.value_json) : null;
  };
  const save = (scope, run) => {
    run.updatedAt = now();
    db.prepare("INSERT INTO channel_dream_runs VALUES(?,?,?,?) ON CONFLICT(channel_id,chat_id,id) DO UPDATE SET value_json=excluded.value_json")
      .run(...args(scope), run.id, JSON.stringify(run));
    activity.dream(scope, run);
    return run;
  };
  function append(scope, id, kind, payload = {}) {
    const encoded = encodeRecord(payload);
    db.exec("SAVEPOINT dream_run_event");
    try {
      db.prepare("INSERT OR IGNORE INTO channel_dream_run_payloads VALUES(?,?,?,?)").run(encoded.hash, encoded.encoding, encoded.bytes, encoded.data);
      const seq = Number(db.prepare("INSERT INTO channel_dream_run_events(channel_id,chat_id,run_id,kind,created_at,payload_hash) VALUES(?,?,?,?,?,?)")
        .run(...args(scope), id, kind, now(), encoded.hash).lastInsertRowid);
      db.exec("RELEASE dream_run_event"); return seq;
    } catch (error) { db.exec("ROLLBACK TO dream_run_event; RELEASE dream_run_event"); throw error; }
  }
  const summary = run => {
    const counts = Object.entries(labels).filter(([key]) => run.counts[key]).map(([key, label]) => `${label} ${run.counts[key]}`);
    return counts.length ? counts.join("；") : "本轮没有保存新的记忆或事项";
  };
  function finish(scope, id, status, error = "") {
    const run = get(scope, id); if (!run) return;
    run.status = status; run.error = error; run.summary = summary(run);
    run.endedAt = status === "completed" ? now() : null;
    run.conclusion = { outcome: status, summary: run.summary,
      remaining: status === "completed" ? [] : [error || "本轮进度已保存，稍后继续整理"] };
    save(scope, run);
    append(scope, id, status === "completed" ? "completed" : "dream_pause", { text: error || run.summary });
    return run;
  }
  // A process interruption must not leave a permanent "running" card. The
  // original Dream job/checkpoint remains the authority for resuming work.
  for (const row of db.prepare("SELECT channel_id,chat_id,id FROM channel_dream_runs WHERE json_extract(value_json,'$.status')='running'").all()) {
    finish({ channelId: row.channel_id, chatId: row.chat_id }, row.id, "interrupted", "上次整理中断，已保留进度和记录");
  }
  function project(row) {
    const payload = db.prepare("SELECT * FROM channel_dream_run_payloads WHERE hash=?").get(row.payload_hash);
    if (!payload) throw new Error("梦境运行记录正文缺失");
    return { tool: "", arguments: "", ...decodeRecord(payload), id: `event:${row.seq}`, seq: row.seq, kind: row.kind, createdAt: row.created_at };
  }
  return { get, append, finish,
    enableRollback(scope, id) { const run = get(scope, id); if (run) save(scope, { ...run, rollbackVersion: 1 }); },
    list(scope, { offset = 0, limit = 20, meaningfulOnly = false } = {}) {
      offset = Math.max(0, Math.floor(Number(offset) || 0)); limit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 20)));
      // Keep the journal for recovery and direct inspection, but do not fill the
      // user-facing list with successful scans that committed no changes.
      const changed = ["memories", "records", "removed", "invalidated", "style"].map(key => `coalesce(json_extract(value_json,'$.counts.${key}'),0)>0`).join(" OR ");
      const visible = meaningfulOnly ? ` AND (coalesce(json_extract(value_json,'$.status'),'')<>'completed' OR ${changed})` : "";
      const rows = db.prepare(`SELECT value_json FROM channel_dream_runs WHERE channel_id=? AND chat_id=?${visible} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
        .all(...args(scope), Math.max(1, Math.min(20, Number(limit) || 20)) + 1, Math.max(0, Math.floor(Number(offset) || 0)));
      const items = rows.slice(0, limit).map(r => JSON.parse(r.value_json));
      return { items, nextOffset: rows.length > items.length ? offset + items.length : null };
    },
    markRollback(scope, id, rollback) {
      const run = get(scope, id);
      save(scope, { ...run, rollback, status: "rolled_back", summary: "该轮学习变更已回滚", conclusion: { outcome: "rolled_back", summary: "该轮学习变更已回滚", remaining: [] } });
      append(scope, id, "dream_rollback", { text: `已回滚 ${rollback.changes} 项变更；执行历史保留，关联复查已暂停` });
    },
    rollbackPending(scope, id, error = "") {
      const run = get(scope, id);
      save(scope, { ...run, status: "rollback_pending", rollback: { status: "pending" },
        summary: error ? "回滚待处理" : "正在回滚", conclusion: { outcome: "rollback_pending", summary: "回滚尚未完成", remaining: [error || "正在恢复已保存的版本"] } });
    },
    readEvent(scope, id, seq, offset = 0) {
      const row = db.prepare("SELECT * FROM channel_dream_run_events WHERE channel_id=? AND chat_id=? AND run_id=? AND seq=?").get(...args(scope), id, Number(seq));
      if (!row) throw new Error("运行事件不存在或不属于当前聊天");
      const text = JSON.stringify(project(row), null, 2), start = Math.max(0, Math.floor(Number(offset) || 0)), end = Math.min(text.length, start + 6000);
      return { eventSeq: Number(seq), text: text.slice(start, end), nextOffset: end < text.length ? end : null };
    },
    readEventText(scope, id, seq, offset = 0) {
      const row = db.prepare("SELECT * FROM channel_dream_run_events WHERE channel_id=? AND chat_id=? AND run_id=? AND seq=?").get(...args(scope), id, Number(seq));
      if (!row) throw new Error("运行事件不存在或不属于当前聊天");
      const event = project(row), text = typeof event.text === "string" ? event.text : event.kind;
      const start = Math.max(0, Math.floor(Number(offset) || 0)), end = Math.min(text.length, start + 6000);
      return { eventSeq: Number(seq), text: text.slice(start, end), nextOffset: end < text.length ? end : null };
    },
    start(scope, job) {
      const old = job.runId && get(scope, job.runId);
      const run = old || { id: randomUUID(), trigger: job.trigger, createdAt: now(), cutoff: job.cutoff, upper: job.upper, counts: {}, summary: "", modelId: "" };
      save(scope, { ...run, status: "running", endedAt: null, error: "", conclusion: undefined });
      append(scope, run.id, old ? "dream_resume" : "start", { text: old ? "继续上次未完成的整理" : `整理当前聊天截至 ${new Date(job.cutoff).toLocaleString()} 的资料` });
      return run.id;
    },
    trace(scope, id, kind, payload) {
      const run = get(scope, id); if (!run) return 0;
      if (payload.modelId) { run.modelId = payload.modelId; save(scope, run); }
      return append(scope, id, kind, payload);
    },
    change(scope, id, counts, detail) {
      const run = get(scope, id); if (!run) return;
      for (const [key, count] of Object.entries(counts)) run.counts[key] = (run.counts[key] || 0) + count;
      run.summary = summary(run); save(scope, run);
      if (detail) append(scope, id, "dream_change", { text: detail });
    },
    events(scope, id, before = 0, after = 0, { previews = false } = {}) {
      const base = [...args(scope), id], conditions = "channel_id=? AND chat_id=? AND run_id=?";
      const rows = db.prepare(`SELECT * FROM channel_dream_run_events WHERE ${conditions}${after ? " AND seq>?" : before ? " AND seq<?" : ""} ORDER BY seq ${after ? "ASC" : "DESC"} LIMIT 21`)
        .all(...base, ...(after || before ? [after || before] : []));
      const events = rows.slice(0, 20).sort((a, b) => a.seq - b.seq).map(project);
      const nextBefore = events[0]?.seq || 0, nextAfter = events.at(-1)?.seq || after;
      if (!before && !after) {
        const first = db.prepare(`SELECT * FROM channel_dream_run_events WHERE ${conditions} ORDER BY seq LIMIT 1`).get(...base);
        if (first && !events.some(e => e.seq === first.seq)) events.unshift(project(first));
      }
      const related = (previews ? [] : events.filter(e => e.callSeq && !events.some(call => call.seq === e.callSeq))).map(event =>
        db.prepare(`SELECT * FROM channel_dream_run_events WHERE ${conditions} AND seq=?`).get(...base, event.callSeq)).filter(Boolean);
      const combined = [...new Map([...events, ...related.map(project)].map(e => [e.id, e])).values()];
      return { events: previews ? combined.map(event => {
        const text = typeof event.text === "string" ? event.text : event.kind;
        let end = Math.min(500, text.length);
        while (Buffer.byteLength(JSON.stringify(text.slice(0, end))) > 2000) end = Math.floor(end * 0.8);
        return { id: event.id, seq: event.seq, kind: event.kind, createdAt: event.createdAt,
          text: text.slice(0, end), textLength: text.length, nextOffset: end < text.length ? end : null };
      }) : combined, hasMore: rows.length > 20, nextBefore, nextAfter };
    },
    deleteChannel(channelId) {
      for (const table of ["channel_dream_runs", "channel_dream_run_events"]) db.prepare(`DELETE FROM ${table} WHERE channel_id=?`).run(channelId);
      db.prepare("DELETE FROM channel_dream_run_payloads WHERE hash NOT IN (SELECT payload_hash FROM channel_dream_run_events) AND hash NOT IN (SELECT before_hash FROM channel_dream_undo UNION SELECT after_hash FROM channel_dream_undo) AND hash NOT IN (SELECT json_extract(value_json,'$.planHash') FROM channel_dream_rollback_jobs WHERE json_extract(value_json,'$.planHash') IS NOT NULL)").run();
      activity.deleteChannel(channelId, "dream");
    },
  };
}
module.exports = { createDreamRunRepository };
