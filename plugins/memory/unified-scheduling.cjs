"use strict";
const { state, save, get } = require("./unified-state.cjs");
const { nextRun } = require("./lib/features/channels/channel-dream-analysis.cjs");
const foreground = new Map();
const scopeKey = (storage, scope) => `${storage.root}:${scope.chatId}`;
function activity(storage, scope, requestId, running) {
  const key = scopeKey(storage, scope), entries = foreground.get(key) || new Map();
  if (running) entries.set(requestId || "turn", Date.now()); else entries.delete(requestId || "turn");
  if (entries.size) foreground.set(key, entries); else foreground.delete(key);
  save(storage, scope, { lastActivityAt: Date.now() });
}
function active(storage, scope) {
  const key = scopeKey(storage, scope), entries = foreground.get(key);
  if (!entries) return false;
  // An interrupted process/hook must not strand this chat indefinitely.
  for (const [id, at] of entries) if (Date.now() - at > 15 * 60000) entries.delete(id);
  if (!entries.size) foreground.delete(key);
  return entries.size > 0;
}
async function due(ctx, storage, scope, { forks = false } = {}) {
  let live = state(storage, scope);
  if (!live.maintenanceNextRun || forks && !live.nextRun) {
    const next = nextRun(live.settings, Date.now());
    save(storage, scope, { maintenanceNextRun: live.maintenanceNextRun || live.nextRun || next,
      ...(forks ? { nextRun: live.nextRun || next } : {}) });
    live = state(storage, scope);
  }
  const batch = !forks && get(storage, `plus:organizer-batch:${scope.chatId}`);
  const fork = forks && get(storage, `plus:fork-plan:${scope.chatId}`);
  const maintenance = get(storage, `plus:maintenance-cycle:${scope.chatId}`);
  if (live.paused || active(storage, scope)) return "";
  if (forks && live.forkManualRequested) return "manual";
  if (!live.settings.enabled && ((forks ? fork?.job.trigger : live.job?.trigger || batch?.trigger) !== "manual") && !maintenance?.manual && !live.maintenanceManual) return "";
  if (!forks && (live.job || batch)) return "continuation";
  const maintenanceReady = (live.maintenanceFailures || 0) < 5 && !(live.maintenanceRetryAt > Date.now());
  if (forks) {
    if (live.settings.enabled && live.nextRun <= Date.now()) return "scheduled";
    if (fork || live.settings.enabled && (await require("./unified-fork-organizer.cjs").work(ctx, storage, scope)).length) return "boundary";
    if (maintenanceReady && (maintenance || live.maintenanceRequested || live.maintenanceNextRun <= Date.now())) return "maintenance";
    return "";
  }
  if (maintenanceReady && (maintenance || live.maintenanceRequested)) return "maintenance";
  if (maintenanceReady && live.maintenanceNextRun <= Date.now()) return "scheduled";
  if (live.settings.idleMinutes) {
    const head = await ctx.api.sources({ action: "head", chatId: scope.chatId });
    const last = Math.max(head.observedAt || 0, live.lastActivityAt || 0);
    if (head.upper > (live.cursor || 0) && last && last + live.settings.idleMinutes * 60000 <= Date.now()) return "idle";
  }
  return "";
}
module.exports = { activity, active, due };
