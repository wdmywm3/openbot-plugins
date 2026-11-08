"use strict";
const { get, put, state, save, hash } = require("./unified-state.cjs");
const { nextRun } = require("./lib/features/channels/channel-dream-analysis.cjs");
const resetting = new Set();
const key = (storage, scope) => `${storage.root}:${scope.chatId}`;
const busy = (storage, scope) => resetting.has(key(storage, scope));
function view(storage, scope) {
  const value = state(storage, scope);
  return { cursor: value.cursor || 0, upper: value.job?.upper ?? null, updatedAt: value.checkpointAt || 0,
    start: value.scanStart || null };
}
async function startNow(ctx, storage, scope, occupied = () => false) {
  const requestKey = ctx.input?.requestKey;
  if (typeof requestKey !== "string" || !requestKey.trim() || requestKey.length > 160) throw Error("更新整理起点需要稳定的 requestKey");
  const receiptKey = `plus:checkpoint-request:${hash([scope.channelId, scope.chatId, requestKey])}`;
  const previous = get(storage, receiptKey); if (previous) return previous;
  const chats = scope.chatId ? [scope.chatId] : [...new Set([
    ...(await ctx.api.sources({ action: "scopes" })).scopes.map(item => item.chatId),
    ...storage.db.prepare("SELECT key FROM plugin_meta WHERE key LIKE 'plus:state:%'").all().map(row => row.key.slice("plus:state:".length)),
  ].filter(Boolean))].sort();
  // Scope discovery can yield while a duplicate request finishes.
  const completed = get(storage, receiptKey); if (completed) return completed;
  const scopes = chats.map(chatId => ({ ...scope, chatId }));
  if (scopes.some(target => busy(storage, target) || occupied(target))) throw Error("当前仍在整理，请先暂停后再更新起点");
  for (const target of scopes) resetting.add(key(storage, target));
  try {
    const starts = [];
    for (const target of scopes) {
      ctx.signal.throwIfAborted();
      const jobs = await ctx.api.jobs({ action: "list", chatId: target.chatId, statuses: ["queued", "running"] });
      if (jobs.jobs?.some(job => ["process", "followup"].includes(job.action))) throw Error("当前还有整理或复查任务，请先暂停后再更新起点");
      const head = await ctx.api.sources({ action: "head", chatId: target.chatId });
      if (!Number.isSafeInteger(head.upper) || head.upper < 0) throw Error("无法读取当前资料位置，整理起点未修改");
      starts.push({ chatId: target.chatId, cursor: head.upper, observedAt: head.observedAt || 0 });
    }
    ctx.signal.throwIfAborted();
    const at = Date.now(), result = { saved: true, at, chats: starts };
    storage.db.exec("SAVEPOINT plus_checkpoint_start");
    try {
      for (const start of starts) {
        const target = { ...scope, chatId: start.chatId }, live = state(storage, target);
        if (live.job?.runId) storage.dreamRepository.runs.finish(target, live.job.runId, "interrupted", "用户更新整理起点，旧批次不再继续");
        const historyKey = `plus:checkpoint-history:${start.chatId}`;
        put(storage, historyKey, [...get(storage, historyKey, []), { at, from: live.cursor || 0, to: start.cursor, requestKey }].slice(-50));
        save(storage, target, { cursor: start.cursor, checkpointAt: at, scanStart: { ...start, at }, job: null,
          forkManualRequested: false, error: "", failures: 0, retryAt: 0, nextRun: nextRun(live.settings, at) });
        storage.db.prepare("DELETE FROM plugin_meta WHERE key=?").run(`plus:plan:${start.chatId}`);
        storage.db.prepare("DELETE FROM plugin_meta WHERE key=?").run(`plus:organizer-batch:${start.chatId}`);
        storage.db.prepare("DELETE FROM plugin_meta WHERE key=?").run(`plus:organizer-session:${start.chatId}`);
        const forkKey = `plus:fork-plan:${start.chatId}`, fork = get(storage, forkKey);
        if (fork?.runId) storage.dreamRepository.runs.finish(target, fork.runId, "interrupted", "用户更新整理起点，旧批次不再继续");
        storage.db.prepare("DELETE FROM plugin_meta WHERE key=?").run(forkKey);
        put(storage, `plus:topics:${start.chatId}`, []);
      }
      put(storage, receiptKey, result);
      storage.db.exec("RELEASE plus_checkpoint_start");
    } catch (error) { storage.db.exec("ROLLBACK TO plus_checkpoint_start; RELEASE plus_checkpoint_start"); throw error; }
    return result;
  } finally { for (const target of scopes) resetting.delete(key(storage, target)); }
}
module.exports = { busy, view, startNow };
