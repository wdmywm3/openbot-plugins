"use strict";
const { hash } = require("../../context/channel-dream-repository.cjs");
const { isPrivateDreamScope } = require("./channel-dream-settings.cjs");
const READ_TOOLS = /^(?:qqHistory|web_fetch|web_search|mcp__anysearch__(?:search|batch_search|extract|get_sub_domains))$/;
function createDreamFollowups({ repository, tasks, manage, now = Date.now }) {
  function* allFollowups(scope) {
    let cursor = "";
    do {
      const page = repository.recordPage(scope, { kind: "followup", after: cursor, limit: 200 });
      yield* page.records;
      cursor = page.nextCursor;
    } while (cursor);
  }
  async function sync(scope) {
    if (!isPrivateDreamScope(scope)) return;
    const context = { autonomous: true, purpose: "plugin_background", principal: { source: "channel", ...scope, senderId: "", messageType: "private", role: "member" } };
    for (const record of allFollowups(scope)) {
      let current = repository.getRecord(scope, record.id);
      if ((current.relatedIds || []).some(id => ["completed", "closed", "canceled", "invalidated"].includes(repository.getRecord(scope, id)?.status))
        && ["active", "waiting"].includes(current.status)) current = repository.saveRecord(scope, { ...current, status: "closed" }, current.revision);
      const task = current.taskId ? tasks.get(current.taskId) : null;
      const active = !current.documentUnavailable && !current.documentPending && ["active", "waiting"].includes(current.status) && repository.state(scope).settings.enabled;
      try {
        if (!active) {
          if (task?.enabled || task?.running) await manage({ action: "pause", id: task.id },
            { ...context, documentPause: !!(current.documentUnavailable || current.documentPending) });
          continue;
        }
        if (task?.running) continue;
        // Enabling an instance after restoring an old backup is not consent to
        // replay the old snapshot's timers. Resume each paused task explicitly.
        if (task?.enabled === false && ["restored_snapshot", "dream_rollback", "dream_paused"].includes(task.pauseReason)) continue;
        if (task && ["completed", "partial", "blocked", "uncertain", "failed", "permission_denied"].includes(task.lastStatus)
          && current.taskFingerprint === hash(JSON.stringify([current.content, current.nextReviewAt, current.sourceIds]))) {
          const state = task.lastStatus === "completed" ? "completed" : "waiting";
          if (current.status !== state || current.lastTaskStatus !== task.lastStatus) repository.saveRecord(scope,
            { ...current, status: state, lastTaskStatus: task.lastStatus }, current.revision);
          continue;
        }
        if (current.taskId && (!task || task.enabled === false && !task.lastRun && task.pauseReason !== "dream_document")) {
          // A user's pause/delete is durable. A later reflection cannot silently recreate it.
          repository.saveRecord(scope, { ...current, status: "canceled", canceledByTaskControl: true }, current.revision);
          continue;
        }
        const fingerprint = hash(JSON.stringify([current.content, current.nextReviewAt, current.sourceIds]));
        if (task && current.taskFingerprint === fingerprint && !(task.enabled === false && task.pauseReason === "dream_document")) continue;
        const capabilities = await manage({ action: "list", channelId: scope.channelId, chatId: scope.chatId }, context);
        const tools = (capabilities.tools || []).filter(tool => tool.readOnly === true || READ_TOOLS.test(tool.name)).map(tool => tool.name);
        const dueAt = Math.max(now() + 60_000, current.nextReviewAt);
        const saved = await manage({ action: "save", ...(task ? { id: task.id } : {}), channelId: scope.channelId, chatId: scope.chatId,
          title: current.title.slice(0, 100), kind: "agent", timeoutMinutes: 5, tools, requestKey: `dream:${current.id}`,
          schedule: { type: "once", at: dueAt, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          content: `这是梦境安排的私聊复查。只读取资料，不能执行外部写操作。先用 qqHistory 核对本聊天最近情况及下列原材料；必要时查公开来源。\n`
            + `事项可能已完成、已取消或不再相关；这种情况提交 task_result，data.reply 为空字符串。没有有用变化时保持安静。值得告知时按角色风格在 data.reply 填写一条简短消息，由宿主投递，不声称用户已经购买、采用或看过。\n`
            + `<reference-data>\n${JSON.stringify({ id: current.id, title: current.title, content: current.content, sourceIds: current.sourceIds, noteRefs: current.noteRefs })}\n</reference-data>` },
          { ...context, dreamRecord: { id: current.id, fingerprint } });
        const live = repository.getRecord(scope, record.id);
        if (live.revision !== current.revision) { await manage({ action: "pause", id: saved.id }, context); continue; }
        tasks.save({ ...saved, dreamRecordId: current.id, dreamFingerprint: fingerprint });
        repository.saveRecord(scope, { ...current, taskId: saved.id, taskFingerprint: fingerprint, scheduleError: "" }, current.revision);
      } catch (error) {
        current = repository.getRecord(scope, record.id);
        const message = String(error.message || error).slice(0, 300);
        if (current && current.scheduleError !== message) repository.saveRecord(scope, { ...current, scheduleError: message }, current.revision);
      }
    }
  }
  return { sync };
}
module.exports = { createDreamFollowups };
