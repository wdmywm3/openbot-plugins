"use strict";
const { hash } = require("./storage.cjs");
const { validateEntries } = require("./sources.cjs");
const { isPrivateDreamScope } = require("./lib/features/channels/channel-dream-settings.cjs");
const MAX_ATTEMPTS = 5;
const attemptState = task => task.followupState?.fingerprint === task.dreamFingerprint ? task.followupState
  : { fingerprint: task.dreamFingerprint, attempt: 0, jobId: "", retryAt: 0 };
function currentTask(storage, scope, task) {
  const live = storage.scheduledTaskRepository.get(task.id);
  return live?.channelId === scope.channelId && live.chatId === scope.chatId && live.enabled
    && live.dreamFingerprint === task.dreamFingerprint ? live : null;
}
function recordFor(storage, scope, task) {
  if (!task || !isPrivateDreamScope(scope) || !storage.dreamRepository.state(scope).settings.enabled) return null;
  const record = storage.dreamRepository.getRecord(scope, task.dreamRecordId);
  return record && ["active", "waiting"].includes(record.status) && !record.documentPending && !record.documentUnavailable
    && task.dreamFingerprint === hash(JSON.stringify([record.content, record.nextReviewAt, record.sourceIds])) ? record : null;
}
function defer(storage, scope, task, job, now) {
  const live = currentTask(storage, scope, task); if (!live) return;
  const state = attemptState(live), attempt = state.attempt + 1;
  const paused = ["canceled", "paused"].includes(job.status) || attempt >= MAX_ATTEMPTS;
  storage.scheduledTaskRepository.save({ ...live, enabled: !paused, pauseReason: paused ? "dream_paused" : "",
    lastStatus: ["blocked", "partial"].includes(live.lastStatus) ? live.lastStatus : "failed",
    lastError: String(job.error || live.lastError || "本次复查未完成").slice(0, 500), lastRun: now,
    followupState: { ...state, attempt, jobId: "", retryAt: now + Math.min(3600000, 60000 * 2 ** Math.min(attempt - 1, 6)) } });
}
async function admit(ctx, storage, scope, task, now = Date.now()) {
  if (!recordFor(storage, scope, task)) return;
  const state = attemptState(task);
  if (state.retryAt > now) return;
  let job;
  if (state.jobId) job = await ctx.api.jobs({ action: "status", id: state.jobId, chatId: scope.chatId });
  else job = await ctx.api.jobs({ action: "start", actionId: "followup", chatId: scope.chatId,
    requestKey: `followup:${task.id}:${task.dreamFingerprint}${state.attempt ? `:${state.attempt}` : ""}`,
    // Preserve the first attempt's legacy input for existing idempotency receipts.
    input: { chatId: scope.chatId, taskId: task.id, ...(state.attempt ? { attempt: state.attempt } : {}) } });
  const live = currentTask(storage, scope, task); if (!live) return;
  if (attemptState(live).attempt !== state.attempt) return;
  if (["queued", "running"].includes(job.status)) {
    storage.scheduledTaskRepository.save({ ...live, followupState: { ...attemptState(live), jobId: job.id } });
  } else defer(storage, scope, live, job, now);
}
async function execute(ctx, storage, scope) {
  const task = storage.scheduledTaskRepository.get(ctx.input.taskId);
  const live = task && currentTask(storage, scope, task), state = live && attemptState(live);
  const record = recordFor(storage, scope, live);
  if (!record || (ctx.input.attempt || 0) !== state.attempt) return { skipped: true };
  if (!(await validateEntries(ctx, storage, scope, [record])).length) return { skipped: true };
  let savedResult = state.result;
  if (!savedResult) {
    // These are plugin-selected read capabilities. Missing optional tools never
    // broaden authorization; recent messages remain available without search.
    const result = await ctx.api.runAgent({ chatId: scope.chatId, prompt: task.content, tools: [],
      optionalTools: ["qqHistory", "web_search", "web_fetch"], context: { recentMessages: 20 },
      taskId: `followup-${hash(JSON.stringify([task.id, task.dreamFingerprint, state.attempt])).slice(0, 48)}`, timeoutMs: 120000 });
    ctx.signal.throwIfAborted();
    const latest = currentTask(storage, scope, task);
    if (!recordFor(storage, scope, latest) || attemptState(latest).attempt !== state.attempt) return { skipped: true };
    if (!["completed", "partial", "blocked"].includes(result?.status)) throw Error("复查没有返回有效的完成状态");
    if (result.status !== "completed") {
      storage.scheduledTaskRepository.save({ ...latest, lastStatus: result.status, lastRun: Date.now(),
        lastError: String(result.summary || result.text || "本次复查未完成").slice(0, 500) });
      return { completed: false, status: result.status, notified: false };
    }
    if (typeof result.data?.reply !== "string") throw Error("复查结果缺少回复字段，未确认完成");
    savedResult = { text: result.data.reply.trim() };
    // Persist before publication. Retrying a lost response republishes identical
    // content under the same event ID instead of rerunning analysis or sending twice.
    storage.scheduledTaskRepository.save({ ...latest, followupState: { ...attemptState(latest), result: savedResult } });
  }
  const beforeSend = currentTask(storage, scope, task);
  const validRecord = recordFor(storage, scope, beforeSend);
  if (!validRecord || !(await validateEntries(ctx, storage, scope, [validRecord])).length) return { skipped: true };
  ctx.signal.throwIfAborted();
  if (savedResult.text) await ctx.api.publishConversationEvent({ chatId: scope.chatId,
    id: `followup:${task.id}:${task.dreamFingerprint}`, kind: "notice", delivery: "flush", text: savedResult.text });
  const final = currentTask(storage, scope, task);
  if (final) storage.scheduledTaskRepository.save({ ...final, enabled: false, lastStatus: "completed", lastError: "", lastRun: Date.now() });
  return { completed: true, notified: !!savedResult.text };
}
module.exports = { admit, execute, attemptState };
