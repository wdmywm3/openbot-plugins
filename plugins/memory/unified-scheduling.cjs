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
async function due(ctx, storage, scope) {
  let live = state(storage, scope);
  if (!live.maintenanceNextRun) {
    save(storage, scope, { maintenanceNextRun: live.nextRun || nextRun(live.settings, Date.now()) }); live = state(storage, scope);
  }
  const batch = get(storage, `plus:organizer-batch:${scope.chatId}`);
  const maintenance = get(storage, `plus:maintenance-cycle:${scope.chatId}`);
  if (live.paused || !live.settings.enabled && (live.job?.trigger || batch?.trigger) !== "manual" && !maintenance?.manual && !live.maintenanceManual || active(storage, scope)) return "";
  if (live.job || batch) return "continuation";
  const maintenanceReady = (live.maintenanceFailures || 0) < 5 && !(live.maintenanceRetryAt > Date.now());
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
