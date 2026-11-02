"use strict";
const { createHash } = require("node:crypto");
const { encodeRecord, decodeRecord } = require("../plugins/plugin-record-codec.cjs");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = require("node:util").isDeepStrictEqual;
const volatile = new Set(["revision", "updatedAt", "retrievedCount", "documentHash", "documentPending", "documentUnavailable", "documentTruncated", "documentRef", "taskId", "taskFingerprint", "scheduleError", "lastTaskStatus"]);
const semantic = value => value && Object.fromEntries(Object.entries(value).filter(([key]) => !volatile.has(key)));
const names = { memory: "记忆", record: "持续事项", topic: "话题", style: "交流偏好", exclusion: "遗忘标记", document: "笔记" };

function createDreamRollback(db, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS channel_dream_undo(channel_id TEXT,chat_id TEXT,run_id TEXT,kind TEXT,item_id TEXT,before_hash TEXT,after_hash TEXT,PRIMARY KEY(channel_id,chat_id,run_id,kind,item_id));
    CREATE TABLE IF NOT EXISTS channel_dream_rollback_jobs(channel_id TEXT,chat_id TEXT,run_id TEXT,state TEXT,value_json TEXT,PRIMARY KEY(channel_id,chat_id,run_id));`);
  const args = scope => [scope.channelId, scope.chatId];
  const hasTable = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const putBlob = value => {
    const e = encodeRecord(value);
    db.prepare("INSERT OR IGNORE INTO channel_dream_run_payloads VALUES(?,?,?,?)").run(e.hash, e.encoding, e.bytes, e.data); return e.hash;
  };
  const readBlob = id => {
    const row = db.prepare("SELECT * FROM channel_dream_run_payloads WHERE hash=?").get(id);
    if (!row) throw new Error("回滚版本正文缺失，已停止操作");
    return decodeRecord(row);
  };
  function changes(scope, id) {
    return db.prepare("SELECT * FROM channel_dream_undo WHERE channel_id=? AND chat_id=? AND run_id=? ORDER BY kind,item_id").all(...args(scope), id)
      .map(row => ({ kind: row.kind, id: row.item_id, before: readBlob(row.before_hash), after: readBlob(row.after_hash) }));
  }
  function remember(scope, runId, kind, id, before, after) {
    if (same(before, after)) return;
    if (["memory", "record"].includes(kind) && same(semantic(before), semantic(after)) && same(before?.documentRef, after?.documentRef)) return;
    db.prepare(`INSERT INTO channel_dream_undo VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel_id,chat_id,run_id,kind,item_id) DO UPDATE SET after_hash=excluded.after_hash`)
      .run(...args(scope), runId, kind, id, putBlob(before ?? null), putBlob(after ?? null));
  }
  function snapshot(scope) {
    const state = db.prepare("SELECT value_json FROM channel_dream_state WHERE channel_id=? AND chat_id=?").get(...args(scope));
    const value = state ? JSON.parse(state.value_json) : {};
    const result = { style: new Map([["style", { style: value.style || null, styleLocked: !!value.styleLocked }]]), document: new Map() };
    for (const [kind, table, column] of [["memory", "channel_memories", "entry_json"], ["record", "channel_dream_records", "value_json"], ["topic", "channel_dream_topics", "value_json"]]) {
      result[kind] = new Map(db.prepare(`SELECT id,${column} AS value FROM ${table} WHERE channel_id=? AND chat_id=?`).all(...args(scope)).map(r => [r.id, JSON.parse(r.value)]));
    }
    result.exclusion = new Map(db.prepare("SELECT content_hash,sources_json FROM channel_memory_exclusions WHERE channel_id=? AND chat_id=?").all(...args(scope)).map(r => [r.content_hash, r.sources_json]));
    if (hasTable("channel_documents")) for (const row of db.prepare("SELECT * FROM channel_documents WHERE channel_id=? AND chat_id=?").all(...args(scope))) {
      const doc = { ...JSON.parse(row.value_json), ownerId: row.owner_id, artifactId: row.artifact_id, relativePath: row.relative_path, contentHash: row.content_hash, content: row.content_text, revision: row.revision };
      if (doc.kind === "daily") continue;
      result.document.set(JSON.stringify([doc.ownerId, doc.artifactId]), doc.revokedAt ? null : doc);
    }
    const readOp = hasTable("channel_document_writes") ? db.prepare("SELECT content_text,state FROM channel_document_writes WHERE op_id=?") : null;
    for (const kind of ["memory", "record"]) for (const value of result[kind].values()) if (value.documentRef) {
      const ref = value.documentRef, doc = result.document.get(JSON.stringify([ref.ownerId || "host", ref.artifactId]));
      const op = ref.opId ? readOp?.get(ref.opId) : null;
      const body = op?.content_text ?? doc?.content;
      if (typeof body === "string") value.content = require("../features/channels/channel-dream-documents-format.cjs").contentFromDreamDocument(body).trim().slice(0, kind === "memory" ? 500 : 3000);
    }
    return result;
  }
  function track(scope, runId, work) {
    if (!runId) return work();
    const before = snapshot(scope);
    const seq = hasTable("channel_document_writes") ? db.prepare("SELECT MAX(seq) n FROM channel_document_writes").get().n || 0 : 0;
    const result = work(), after = snapshot(scope);
    const writes = hasTable("channel_document_writes") ? db.prepare("SELECT * FROM channel_document_writes WHERE channel_id=? AND chat_id=? AND seq>?").all(...args(scope), seq) : [];
    for (const kind of ["memory", "record", "topic", "style", "exclusion"]) {
      for (const id of new Set([...before[kind].keys(), ...after[kind].keys()])) {
        const a = before[kind].get(id) ?? null, b = after[kind].get(id) ?? null;
        if (["memory", "record"].includes(kind) && a?.documentRef && b) {
          const ref = a.documentRef, doc = after.document.get(JSON.stringify([ref.ownerId || "host", ref.artifactId]));
          const write = writes.find(op => op.artifact_id === ref.artifactId && op.owner_id === (ref.ownerId || "host"));
          // Refreshes of an externally edited note are not Dream edits.
          if (!write) a.content = b.content;
          else if (doc?.contentHash === write.expected_hash) a.content = require("../features/channels/channel-dream-documents-format.cjs").contentFromDreamDocument(doc.content).trim().slice(0, kind === "memory" ? 500 : 3000);
        }
        if (same(a, b)) continue;
        remember(scope, runId, kind, id, a, b);
        if (["memory", "record"].includes(kind) && a?.documentRef && (!b || b.invalidatedAt || b.status === "invalidated" || b.sourceRevoked)) {
          const key = JSON.stringify([a.documentRef.ownerId || "host", a.documentRef.artifactId]);
          remember(scope, runId, "document", key, before.document.get(key) || after.document.get(key) || null, null);
        }
      }
    }
    for (const op of writes) {
      const meta = JSON.parse(op.value_json).metadata;
      if (!meta?.metadata?.derivedId) continue;
      const key = JSON.stringify([op.owner_id, op.artifact_id]);
      remember(scope, runId, "document", key, after.document.get(key) || before.document.get(key) || null,
        { ...meta, ownerId: op.owner_id, artifactId: op.artifact_id, relativePath: op.relative_path, contentHash: op.target_hash, content: op.content_text, opId: op.op_id });
    }
    return result;
  }
  function merge(change, current) {
    const { before, after, kind } = change;
    const normalize = value => ["memory", "record"].includes(kind) ? semantic(value) : value;
    if (!before || !after || typeof before !== "object") {
      if (!same(normalize(current), normalize(after))) throw Error("已被后续操作修改");
      return before;
    }
    if (!current) throw Error("内容已删除");
    if (kind === "style" && current.styleLocked !== after.styleLocked) throw Error("主人已修改交流偏好锁定设置");
    const next = { ...current };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (["memory", "record"].includes(kind) && volatile.has(key) || same(before[key], after[key])) continue;
      if (!same(current[key], after[key])) throw Error("已被后续操作修改");
      if (Object.hasOwn(before, key)) next[key] = before[key]; else delete next[key];
    }
    if (["memory", "record"].includes(kind)) {
      if (before.documentRef) next.documentRef = before.documentRef; else delete next.documentRef;
    }
    return next;
  }
  function preview(scope, id, storage) {
    const run = storage.dreamRepository.runs.get(scope, id);
    if (!run) throw Error("梦境记录不存在");
    if (!run.rollbackVersion) return { available: false, conflicts: ["旧版记录未保存修改前版本，不能回滚"], changes: [] };
    if (run.rollback?.status === "completed") return { available: false, rolledBack: true, conflicts: [], changes: [] };
    const current = snapshot(scope), edits = changes(scope, id).filter(c => !same(c.before, c.after)), conflicts = [], planned = [];
    for (const change of edits) {
      try {
        if (change.kind === "document") {
          const doc = change.after || change.before;
          const actual = storage.documentService.versionSync({ ...scope, ownerId: doc.ownerId }, doc.relativePath);
          const expected = change.after?.contentHash || "new", target = change.before?.contentHash || "new";
          if (![expected, target].includes(actual)) throw Error("笔记正文已被后续操作修改");
          const pending = db.prepare("SELECT op_id FROM channel_document_writes WHERE channel_id=? AND chat_id=? AND owner_id=? AND artifact_id=? AND state IN ('pending','error','conflict')").all(...args(scope), doc.ownerId, doc.artifactId);
          if (pending.some(op => op.op_id !== change.after?.opId)) throw Error("笔记还有其他待处理的写入");
          planned.push({ ...change, actual });
        } else planned.push({ ...change, current: current[change.kind].get(change.id) ?? null, restored: merge(change, current[change.kind].get(change.id) ?? null) });
      } catch (error) { conflicts.push(`${names[change.kind]} ${change.before?.title || change.after?.title || change.id}：${error.message}`); }
    }
    const recordIds = new Set(edits.filter(c => c.kind === "record").map(c => c.id));
    const tasks = storage.scheduledTaskRepository.list(scope.channelId).filter(t => t.chatId === scope.chatId && recordIds.has(t.dreamRecordId));
    if (tasks.some(t => t.running)) conflicts.push("关联复查正在执行，请先暂停该任务并等它结束");
    const job = storage.dreamRepository.state(scope).job;
    if (job && job.runId !== id) conflicts.push("当前聊天已有另一轮未完成的 Dream，请先处理该轮");
    const token = hash([id, planned, tasks, job?.runId || null]);
    return { available: !conflicts.length, token, conflicts, changes: edits.map(c => ({ kind: c.kind, id: c.id,
      title: c.before?.title || c.after?.title || c.before?.content?.slice(0, 80) || c.after?.content?.slice(0, 80) || names[c.kind], action: c.before == null ? "remove" : c.after == null ? "restore" : "revert",
      before: c.kind === "document" ? undefined : c.before?.content || (c.kind === "style" ? JSON.stringify(c.before?.style) : undefined),
      after: c.kind === "document" ? undefined : c.after?.content || (c.kind === "style" ? JSON.stringify(c.after?.style) : undefined) })),
      tasks: tasks.map(t => ({ id: t.id, title: t.title, lastStatus: t.lastStatus, willPause: !!t.enabled })), planned, taskRows: tasks };
  }
  function apply(scope, id, token, storage, actor = "desktop") {
    const existing = db.prepare("SELECT * FROM channel_dream_rollback_jobs WHERE channel_id=? AND chat_id=? AND run_id=?").get(...args(scope), id);
    if (existing?.state === "completed") return { status: "already_rolled_back", runId: id };
    let plan;
    if (existing?.state === "pending") plan = readBlob(JSON.parse(existing.value_json).planHash);
    else {
      plan = preview(scope, id, storage);
      if (!plan.available || plan.token !== token) throw Error(plan.conflicts.join("；") || "回滚预览已变化，请重新查看");
      plan.actor = actor;
      db.prepare("INSERT OR REPLACE INTO channel_dream_rollback_jobs VALUES(?,?,?,'pending',?)").run(...args(scope), id, JSON.stringify({ planHash: putBlob(plan) }));
    }
    // A committed intent precedes file writes. Recovery accepts the old or the
    // intended restored hash, so a crash never requires blindly replaying I/O.
    storage.dreamRepository.runs.rollbackPending(scope, id);
    try {
    const fresh = snapshot(scope);
    for (const item of plan.planned.filter(c => c.kind !== "document")) merge(item, fresh[item.kind].get(item.id) ?? null);
    for (const item of plan.planned.filter(c => c.kind === "document")) {
      const doc = item.after || item.before;
      storage.documentService.restoreSync({ ...scope, ownerId: doc.ownerId }, doc.relativePath,
        item.before?.content ?? null, [item.actual, item.before?.contentHash || "new"]);
    }
    storage.dreamRepository.transaction(() => {
      const live = snapshot(scope);
      for (const item of plan.planned.filter(c => c.kind !== "document")) {
        const value = merge(item, live[item.kind].get(item.id) ?? null);
        if (item.kind === "style") {
          const state = storage.dreamRepository.state(scope);
          storage.dreamRepository.saveState(scope, { ...state, ...value, styleVersion: state.styleVersion + 1 });
        } else if (item.kind === "exclusion") {
          db.prepare("DELETE FROM channel_memory_exclusions WHERE channel_id=? AND chat_id=? AND content_hash=?").run(...args(scope), item.id);
          if (value != null) db.prepare("INSERT INTO channel_memory_exclusions VALUES(?,?,?,?)").run(...args(scope), item.id, value);
        } else {
          const table = { memory: "channel_memories", record: "channel_dream_records", topic: "channel_dream_topics" }[item.kind];
          db.prepare(`DELETE FROM ${table} WHERE channel_id=? AND chat_id=? AND id=?`).run(...args(scope), item.id);
          if (value) {
            if (item.kind === "topic") db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`).run(...args(scope), item.id, JSON.stringify(value));
            else {
              value.revision = Math.max(item.before?.revision || 0, item.after?.revision || 0, item.current?.revision || 0) + 1;
              delete value.documentPending; delete value.documentUnavailable; delete value.documentHash;
              if (value.documentRef) value.documentRef = { ...value.documentRef, opId: undefined };
              if (item.kind === "memory") {
                db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?)`).run(...args(scope), item.id, value.revision, JSON.stringify(value));
                db.prepare("INSERT OR REPLACE INTO channel_memory_revisions VALUES(?,?,?,?,?)").run(...args(scope), item.id, value.revision, JSON.stringify(value));
              } else db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?,?)`).run(...args(scope), item.id, value.kind, value.revision, now(), JSON.stringify(value));
            }
          }

        }
      }
      for (const item of plan.planned.filter(c => c.kind === "document")) storage.documentRepository.restoreCheckpoint({ ...scope, ownerId: (item.after || item.before).ownerId }, item.before, item.after || item.before);
      for (const task of plan.taskRows) {
        const liveTask = storage.scheduledTaskRepository.get(task.id);
        if (liveTask) storage.scheduledTaskRepository.save({ ...liveTask, enabled: false, pauseReason: "dream_rollback" });
      }
      const state = storage.dreamRepository.state(scope), run = storage.dreamRepository.runs.get(scope, id);
      storage.dreamRepository.saveState(scope, { ...state, job: state.job?.runId === id ? null : state.job,
        cursor: Math.max(state.cursor, run.upper || 0), offset: 0, error: "" });
      storage.dreamRepository.runs.markRollback(scope, id, { status: "completed", actor: plan.actor, at: now(), changes: plan.changes.length });
      db.prepare("UPDATE channel_dream_rollback_jobs SET state='completed' WHERE channel_id=? AND chat_id=? AND run_id=?").run(...args(scope), id);
    });
    return { status: "rolled_back", runId: id, changes: plan.changes.length, pausedTasks: plan.taskRows.length,
      note: "已撤回该轮学习变更并暂停关联复查；已发送的消息和执行历史保留" };
    } catch (error) {
      storage.dreamRepository.runs.rollbackPending(scope, id, String(error.message || error).slice(0, 1000));
      throw error;
    }
  }
  return { track, preview, apply,
    pending: scope => !!db.prepare("SELECT 1 FROM channel_dream_rollback_jobs WHERE channel_id=? AND chat_id=? AND state='pending'").get(...args(scope)),
    recover(storage) { for (const row of db.prepare("SELECT * FROM channel_dream_rollback_jobs WHERE state='pending'").all()) apply({ channelId: row.channel_id, chatId: row.chat_id }, row.run_id, "", storage); },
    deleteChannel(id) { for (const table of ["channel_dream_undo", "channel_dream_rollback_jobs"]) db.prepare(`DELETE FROM ${table} WHERE channel_id=?`).run(id); },
  };
}
module.exports = { createDreamRollback };
