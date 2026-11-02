"use strict";
function createScheduledTaskRepository(db) {
  const activity = require("./task-activity-index.cjs").createTaskActivityIndex(db);
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_tasks(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, value_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_channel ON scheduled_tasks(channel_id);
    CREATE TABLE IF NOT EXISTS scheduled_task_runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, channel_id TEXT NOT NULL, started_at INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs ON scheduled_task_runs(task_id,started_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_channel ON scheduled_task_runs(channel_id,started_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS scheduled_task_policies(channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(channel_id,chat_id));`);
  const decode = row => row ? JSON.parse(row.value_json) : null;
  const list = channelId => (channelId ? db.prepare("SELECT value_json FROM scheduled_tasks WHERE channel_id=?").all(channelId)
    : db.prepare("SELECT value_json FROM scheduled_tasks").all()).map(decode);
  const get = id => decode(db.prepare("SELECT value_json FROM scheduled_tasks WHERE id=?").get(id));
  const getRun = id => decode(db.prepare("SELECT value_json FROM scheduled_task_runs WHERE id=?").get(id));
  const snapshot = task => task && ({ id: task.id, channelId: task.channelId, chatId: task.chatId, title: task.title,
    content: task.content, kind: task.kind, schedule: task.schedule, creatorId: task.creatorId, creatorType: task.creatorType,
    sourceChatId: task.sourceChatId, sourceMessageId: task.sourceMessageId, triggeredById: task.triggeredById, deliveryTarget: task.deliveryTarget,
    interactionOrigin: task.interactionOrigin });
  const save = task => transaction(() => {
    preserveLegacyRuns(task.id);
    db.prepare("INSERT INTO scheduled_tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json")
      .run(task.id, task.channelId, JSON.stringify(task)); return task;
  });
  const saveRun = value => {
    const previous = getRun(value.id);
    const run = { ...previous, ...value, task: previous?.task || snapshot(get(value.taskId)) || value.task };
    db.prepare("INSERT INTO scheduled_task_runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json")
    .run(run.id, run.taskId, run.channelId, run.startedAt, JSON.stringify(run));
    if (run.task) activity.scheduled(run.task, run);
    return run; };
  function preserveLegacyRuns(id) {
    for (const row of db.prepare("SELECT value_json FROM scheduled_task_runs WHERE task_id=? AND json_extract(value_json,'$.task') IS NULL").all(id)) saveRun(decode(row));
  }
  function transaction(fn) {
    db.exec("SAVEPOINT scheduled_write");
    try { const value = fn(); db.exec("RELEASE scheduled_write"); return value; }
    catch (e) { db.exec("ROLLBACK TO scheduled_write; RELEASE scheduled_write"); throw e; }
  }
  const policy = (channelId, chatId) => decode(db.prepare("SELECT value_json FROM scheduled_task_policies WHERE channel_id=? AND chat_id=?").get(channelId, chatId))
    || null;
  function history(channelId, params = {}) {
    const where = ["r.channel_id=?"], args = [channelId];
    if (params.chatId) { where.push("COALESCE(json_extract(r.value_json,'$.task.chatId'),json_extract(t.value_json,'$.chatId'))=?"); args.push(params.chatId); }
    if (params.taskId) { where.push("r.task_id=?"); args.push(String(params.taskId)); }
    const query = String(params.query || "").trim().slice(0, 200);
    if (query) {
      const match = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
      where.push(`(COALESCE(json_extract(r.value_json,'$.task.title'),json_extract(t.value_json,'$.title'),'') LIKE ? ESCAPE '\\'
        OR COALESCE(json_extract(r.value_json,'$.task.content'),json_extract(t.value_json,'$.content'),'') LIKE ? ESCAPE '\\')`);
      args.push(match, match);
    }
    const limit = Math.max(1, Math.min(100, Math.floor(Number(params.limit) || 30)));
    const offset = Math.max(0, Math.min(1000000, Math.floor(Number(params.offset) || 0)));
    const rows = db.prepare(`SELECT r.value_json,t.value_json AS task_json FROM scheduled_task_runs r
      LEFT JOIN scheduled_tasks t ON t.id=r.task_id WHERE ${where.join(" AND ")} ORDER BY r.started_at DESC,r.id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit + 1, offset);
    return { items: rows.slice(0, limit).map(row => {
      const run = decode(row), task = run.task || snapshot(row.task_json && JSON.parse(row.task_json));
      return { id: run.id, taskId: run.taskId, startedAt: run.startedAt, endedAt: run.endedAt, dueAt: run.dueAt, status: run.status,
        error: run.error || "", preview: String(run.error || run.result || "").slice(0, 160),
        title: task?.title || "定时任务", chatId: task?.chatId || "", schedule: task?.schedule };
    }), hasMore: rows.length > limit };
  }
  return { get, list, save, saveRun, transaction, policy, history, getRun,
    pendingCount: (channelId, chatId, creatorId, excludeId = "", autonomous = false) => db.prepare(`SELECT COUNT(*) AS total FROM scheduled_tasks
      WHERE channel_id=? AND id<>? AND COALESCE(NULLIF(json_extract(value_json,'$.sourceChatId'),''),json_extract(value_json,'$.ownerHandoff.chatId'),json_extract(value_json,'$.chatId'))=?
      AND ((?=1 AND json_extract(value_json,'$.creatorType')='autonomous') OR (?=0 AND COALESCE(json_extract(value_json,'$.creatorType'),'')<>'autonomous' AND COALESCE(json_extract(value_json,'$.creatorId'),'')=?))
      AND NOT (COALESCE(json_extract(value_json,'$.schedule.type'),'')='once' AND COALESCE(json_extract(value_json,'$.enabled'),0)=0
        AND COALESCE(json_extract(value_json,'$.running'),'')='' AND COALESCE(json_extract(value_json,'$.lastStatus'),'')='completed')`)
      .get(channelId, excludeId, chatId, autonomous ? 1 : 0, autonomous ? 1 : 0, creatorId).total,
    pendingConversationDeliveries: () => db.prepare("SELECT value_json FROM scheduled_task_runs WHERE json_extract(value_json,'$.delivery.status')='accepted' AND json_extract(value_json,'$.delivery.receipt.id') IS NOT NULL").all().map(decode),
    listPolicies() { return db.prepare("SELECT channel_id,chat_id,value_json FROM scheduled_task_policies").all()
      .map(row => ({ channelId: row.channel_id, chatId: row.chat_id, value: JSON.parse(row.value_json) })); },
    setPolicy(channelId, chatId, value) { db.prepare("INSERT INTO scheduled_task_policies VALUES(?,?,?) ON CONFLICT(channel_id,chat_id) DO UPDATE SET value_json=excluded.value_json")
      .run(channelId, chatId, JSON.stringify(value)); },
    runs(taskId) { return db.prepare("SELECT value_json FROM scheduled_task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 30").all(taskId).map(decode); },
    remove(id) { transaction(() => {
      // Keep the original requirements and results available after removing a timer.
      preserveLegacyRuns(id);
      db.prepare("DELETE FROM scheduled_tasks WHERE id=?").run(id);
    }); },
    recover(now) { for (const task of list().filter(t => t.running)) transaction(() => {
      const run = decode(db.prepare("SELECT value_json FROM scheduled_task_runs WHERE id=?").get(task.running));
      if (run) saveRun({ ...run, status: "uncertain", endedAt: now, error: "上次运行中断，请核对结果后再恢复任务" });
      save({ ...task, running: null, enabled: false, lastStatus: "uncertain" });
    }); },
    deleteChannel(channelId) { transaction(() => { activity.deleteChannel(channelId, "scheduled"); for (const table of ["scheduled_tasks", "scheduled_task_runs", "scheduled_task_policies"]) db.prepare(`DELETE FROM ${table} WHERE channel_id=?`).run(channelId); }); },
  };
}
module.exports = { createScheduledTaskRepository };
