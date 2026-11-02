"use strict";

const text = (value, limit = 160) => String(value || "").slice(0, limit * 8).replace(/\s+/g, " ").trim().slice(0, limit);
const messageText = message => typeof message?.content === "string" ? message.content
  : (message?.content || []).filter(part => part.type === "text").map(part => part.text || "").join(" ");

function createTaskActivityIndex(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_activity (
    channel_id TEXT NOT NULL, source TEXT NOT NULL, plugin_id TEXT NOT NULL, chat_id TEXT NOT NULL, id TEXT NOT NULL,
    title TEXT NOT NULL, preview TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    model_id TEXT NOT NULL, agent_id TEXT NOT NULL, schedule_id TEXT NOT NULL,
    PRIMARY KEY(channel_id,source,plugin_id,chat_id,id));
    CREATE INDEX IF NOT EXISTS idx_task_activity_recent ON task_activity(channel_id,updated_at DESC,id);
    CREATE INDEX IF NOT EXISTS idx_task_activity_title ON task_activity(channel_id,title,id);`);
  if (!db.prepare("PRAGMA table_info(task_activity)").all().some(column => column.name === "origin_trigger"))
    db.exec("ALTER TABLE task_activity ADD COLUMN origin_trigger TEXT NOT NULL DEFAULT ''");
  const save = db.prepare(`INSERT INTO task_activity(channel_id,source,plugin_id,chat_id,id,title,preview,status,created_at,updated_at,model_id,agent_id,schedule_id,origin_trigger) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(channel_id,source,plugin_id,chat_id,id) DO UPDATE SET
    title=excluded.title,preview=excluded.preview,status=excluded.status,updated_at=MAX(task_activity.updated_at,excluded.updated_at),
    model_id=COALESCE(NULLIF(excluded.model_id,''),task_activity.model_id),agent_id=COALESCE(NULLIF(excluded.agent_id,''),task_activity.agent_id),schedule_id=excluded.schedule_id,
    origin_trigger=COALESCE(NULLIF(excluded.origin_trigger,''),task_activity.origin_trigger)`);
  function agent(scope, task, kind = "", payload = {}) {
    // Scheduled executions have one card, whose status also includes result delivery.
    const prompt = task.prompt || messageText(task.messages?.find(message => message.role === "user"));
    const preview = task.workflow?.summary || task.result?.summary || task.result?.text || payload.error || (kind === "tool_start" ? `正在调用 ${payload.name || payload.toolName || "工具"}` : "")
      || messageText(task.messages?.findLast(message => message.role === "assistant")) || prompt;
    if (scope.pluginId === "host-scheduled-tasks") {
      db.prepare(`UPDATE task_activity SET preview=?,updated_at=MAX(updated_at,?),model_id=?,agent_id=?
        WHERE channel_id=? AND source='scheduled' AND chat_id=? AND id=? AND status='running'`)
        .run(text(preview), task.updatedAt || 0, task.modelId || "", task.agentId || "", scope.channelId, scope.chatId, task.id);
      return;
    }
    const title = task.title || prompt.replace(/<plugin-skill>[\s\S]*?<\/plugin-skill>/g, "").trim() || "执行记录";
    save.run(scope.channelId, "agent", scope.pluginId, scope.chatId, task.id, text(title, 100),
      text(preview), task.status || "running", task.createdAt || 0, task.updatedAt || task.createdAt || 0,
      task.modelId || "", task.agentId || "", "", task.origin?.trigger || "");
  }
  function scheduled(task, run) {
    save.run(run.channelId, "scheduled", "host-scheduled-tasks", task.chatId || "", run.id,
      text(task.title || task.content || "定时任务", 100), text(run.error || run.conclusion?.summary || run.result || task.content), run.status || "running",
      run.startedAt || 0, run.endedAt || run.updatedAt || run.startedAt || 0, "", "", run.taskId, "");
  }
  function dream(scope, run) {
    const target = scope.chatId.replace(/^onebot:group:/, "群 ").replace(/^onebot:private:/, "QQ ");
    save.run(scope.channelId, "dream", "host-dream", scope.chatId, run.id, text(`梦境整理 · ${target}`, 100),
      text(run.error || run.summary || "正在整理聊天资料"), run.status, run.createdAt, run.updatedAt,
      run.modelId || "", "", "", run.trigger || "");
  }
  const fields = `source,plugin_id AS pluginId,chat_id AS chatId,id,title,preview,status,
    created_at AS createdAt,updated_at AS updatedAt,model_id AS modelId,agent_id AS agentId,schedule_id AS scheduleId,origin_trigger AS originTrigger`;
  function list(channelId, params = {}) {
    const where = ["channel_id=?"], args = [channelId];
    // Chat calls already belong to their originating conversation/tool trace.
    // Keep their journals readable, but do not duplicate them as conversations.
    if (params.standalone === true) where.push("(source IN ('scheduled','dream') OR (source='agent' AND plugin_id<>'host-subagents' AND origin_trigger IN ('','background','manual')))");
    const query = text(params.query, 100);
    if (query) { where.push("(title LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\')"); const match = `%${query.replace(/[\\%_]/g, "\\$&")}%`; args.push(match, match); }
    if (params.status === "running") where.push("status IN ('running','queued')");
    if (params.status === "finished") where.push("status IN ('completed','partial','skipped','cancelled','rolled_back')");
    if (params.status === "error") where.push("status IN ('failed','blocked','suspended','uncertain','permission_denied','interrupted','rollback_pending')");
    const order = params.sort === "name" ? "title COLLATE NOCASE ASC,id ASC" : params.sort === "oldest" ? "updated_at ASC,id ASC" : "updated_at DESC,id DESC";
    const limit = Math.max(1, Math.min(100, Math.floor(Number(params.limit) || 50)));
    const offset = Math.max(0, Math.min(1000000, Math.floor(Number(params.offset) || 0)));
    const rows = db.prepare(`SELECT ${fields} FROM task_activity WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }
  function get(channelId, ref) {
    return db.prepare(`SELECT ${fields} FROM task_activity WHERE channel_id=? AND source=? AND plugin_id=? AND chat_id=? AND id=?`)
      .get(channelId, ref.source, ref.pluginId, ref.chatId, ref.id) || null;
  }
  async function backfill() {
    // Legacy transcripts can be large. Index a few at a time and yield to Electron between batches.
    for (;;) {
      const rows = db.prepare(`SELECT t.* FROM background_agent_tasks t LEFT JOIN task_activity a ON
        a.channel_id=t.channel_id AND a.source='agent' AND a.plugin_id=t.plugin_id AND a.chat_id=t.chat_id AND a.id=t.id
        WHERE a.id IS NULL AND t.plugin_id<>'host-scheduled-tasks' LIMIT 8`).all();
      if (!rows.length) break;
      for (const row of rows) agent({ channelId: row.channel_id, pluginId: row.plugin_id, chatId: row.chat_id }, JSON.parse(row.value_json));
      await new Promise(resolve => setImmediate(resolve));
    }
    for (;;) {
      const rows = db.prepare(`SELECT r.value_json,t.value_json AS task_json FROM scheduled_task_runs r
        LEFT JOIN scheduled_tasks t ON t.id=r.task_id LEFT JOIN task_activity a ON a.channel_id=r.channel_id AND a.source='scheduled' AND a.id=r.id
        WHERE a.id IS NULL AND (t.id IS NOT NULL OR json_extract(r.value_json,'$.task') IS NOT NULL) LIMIT 20`).all();
      if (!rows.length) break;
      for (const row of rows) { const run = JSON.parse(row.value_json); scheduled(run.task || JSON.parse(row.task_json), run); }
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return { agent, scheduled, dream, list, get, backfill,
    deleteChannel(channelId, source) { db.prepare("DELETE FROM task_activity WHERE channel_id=? AND source=?").run(channelId, source); },
    pruneScheduled(taskId) { db.prepare("DELETE FROM task_activity WHERE source='scheduled' AND schedule_id=? AND id NOT IN (SELECT id FROM scheduled_task_runs WHERE task_id=?)").run(taskId, taskId); },
  };
}
module.exports = { createTaskActivityIndex };
