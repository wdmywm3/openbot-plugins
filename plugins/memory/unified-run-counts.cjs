"use strict";
const { get, put } = require("./unified-state.cjs");
const { formatCounts } = require("./lib/context/channel-dream-run-repository.cjs");

function countChanges(operations, receipts) {
  const counts = {};
  for (const [index, receipt] of receipts.entries()) {
    if (!receipt?.ok || receipt.forgotten) continue;
    const operation = operations[index];
    let key = "updated";
    if (operation.action === "create") key = operation.record.category === "profile" ? "profiles" : "created";
    else if (operation.patch?.status === "invalidated") key = "invalidated";
    else if (operation.patch?.status === "archived") key = "removed";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function runSummary(ctx, storage, scope, run, budget) {
  const total = run.counts?.memories;
  if (!total || ["rolled_back", "rollback_pending"].includes(run.status)) return run.summary;
  const fallback = formatCounts(run.counts);
  if (run.status !== "completed" || !ctx.api.memory) return fallback;
  const key = `plus:run-counts:${scope.chatId}:${run.id}`;
  const cached = get(storage, key);
  if (cached?.total === total && cached.endedAt === run.endedAt) return formatCounts(cached.counts);
  // Older receipts kept versions but omitted the category. Resolve only this page's
  // small completed runs, using the original revision even if a member edited it later.
  if (total > 100) return fallback;
  const audit = get(storage, `plus:undo:${scope.chatId}:${run.id}`, []);
  if (!Array.isArray(audit) || audit.length !== total || audit.some(change => !change?.id
    || change.beforeRevision !== null && !(Number.isSafeInteger(change.beforeRevision) && change.beforeRevision > 0))) return fallback;
  if (audit.filter(change => change.beforeRevision === null).length > budget.remaining) return fallback;
  const counts = { ...run.counts };
  delete counts.memories;
  for (const change of audit) {
    let bucket = "updated";
    if (change.beforeRevision === null) {
      ctx.signal.throwIfAborted();
      budget.remaining--;
      let record;
      try {
        record = (await ctx.api.memory({ action: "read", chatId: scope.chatId, id: change.id, revision: 1, mode: "history", limit: 1 })).item;
      } catch {
        ctx.signal.throwIfAborted();
        return fallback;
      }
      if (!record || record.id !== change.id || record.revision !== 1) return fallback;
      bucket = record.category === "profile" ? "profiles" : "created";
    }
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  ctx.signal.throwIfAborted();
  put(storage, key, { total, endedAt: run.endedAt, counts });
  return formatCounts(counts);
}

module.exports = { countChanges, runSummary };
