"use strict";
const { catalog } = require("./unified-state.cjs");
const entries = new Map(), pending = new Map();
const MAX_SCOPES = 32, MAX_BYTES = 8 * 1024 * 1024, TTL = 30000;
let bytes = 0;
function remove(key) { const old = entries.get(key); if (old) bytes -= old.bytes; entries.delete(key); }
function identity(ctx, storage, scope) {
  const principal = ctx.principal || {};
  return JSON.stringify([storage.root, scope.channelId, scope.chatId, principal.source || "", principal.senderId || "", principal.role || ""]);
}
function waitFor(task, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    task.then(value => { signal.removeEventListener("abort", aborted); signal.aborted ? reject(signal.reason) : resolve(value); },
      error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}
async function candidates(ctx, storage, scope) {
  const key = identity(ctx, storage, scope), cached = entries.get(key);
  ctx.signal.throwIfAborted();
  // The host's change head is cheap compared with rebuilding and transferring
  // every catalog page. This is a candidate cache, never an access decision:
  // retrieval still re-reads each selected record from the host before use.
  const head = await ctx.api.memory({ action: "changes", chatId: scope.chatId, after: cached?.upper || 0, limit: 1 });
  ctx.signal.throwIfAborted();
  if (cached && cached.until > Date.now() && Number.isSafeInteger(head.upper) && head.upper === cached.upper) {
    entries.delete(key); entries.set(key, cached); return cached.items;
  }
  remove(key);
  const active = pending.get(key);
  if (active) {
    try { return await waitFor(active.promise, ctx.signal); }
    catch (error) {
      ctx.signal.throwIfAborted();
      if (!active.signal.aborted) throw error;
      // A shared cold read belongs to its initiating invocation. Its cancellation
      // must not fail a different live request; retry with that request's authority.
      if (pending.get(key) === active) pending.delete(key);
      return candidates(ctx, storage, scope);
    }
  }
  const task = (async () => {
    const items = await catalog(ctx, scope); ctx.signal.throwIfAborted();
    const size = Buffer.byteLength(JSON.stringify(items));
    if (size <= MAX_BYTES && Number.isSafeInteger(head.upper)) {
      while (entries.size >= MAX_SCOPES || bytes + size > MAX_BYTES) remove(entries.keys().next().value);
      entries.set(key, { items, bytes: size, upper: head.upper, until: Date.now() + TTL }); bytes += size;
    }
    return items;
  })();
  const entry = { promise: task, signal: ctx.signal };
  pending.set(key, entry);
  try { return await task; } finally { if (pending.get(key) === entry) pending.delete(key); }
}
module.exports = { candidates, TTL, MAX_BYTES, MAX_SCOPES };
