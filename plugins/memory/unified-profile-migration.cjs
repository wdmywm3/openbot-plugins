"use strict";
const { get, put, hash } = require("./unified-state.cjs");
const key = scope => `plus:profile-category:${scope.chatId}`;
// Move only already classified personal records. Never infer a person's profile
// from event prose, copy another chat's records, or change content/validity.
async function classify(ctx, storage, scope) {
  ctx.signal.throwIfAborted();
  if (!ctx.api.memorySpace) return { pending: false };
  const spaces = await ctx.api.memorySpace({ action: "list", chatId: scope.chatId });
  const local = spaces.spaces?.find(item => item.kind === "chat" && item.ownerId === scope.chatId);
  const old = get(storage, key(scope), { after: 0 });
  const page = await ctx.api.memory({ action: "changes", chatId: scope.chatId, after: old.after, limit: 20 });
  for (const change of page.items) {
    ctx.signal.throwIfAborted();
    if (!local || change.spaceId !== local.id) continue;
    let record;
    try { record = (await ctx.api.memory({ action: "read", chatId: scope.chatId, id: change.id, mode: "history", limit: 1 })).item; }
    catch (error) { if (error.code === "MEMORY_NOT_FOUND") continue; throw error; }
    if (!record || record.category || !["fact", "preference"].includes(record.kind)
      || record.subjectRefs?.length !== 1 || typeof record.subjectRefs[0] !== "string"
      || record.kind !== "preference" && !record.attributes?.profile) continue;
    try {
      await ctx.api.memory({ action: "revise", chatId: scope.chatId, id: record.id, expectedRevision: record.revision,
        changeType: "edit", patch: { category: "profile" }, requestKey: `profile-category:${hash([record.id, record.revision])}` });
    } catch (error) { if (!["MEMORY_NOT_FOUND", "MEMORY_CONFLICT", "MEMORY_SOURCE"].includes(error.code)) throw error; }
  }
  put(storage, key(scope), { after: page.nextCursor ?? page.upper, complete: page.nextCursor == null });
  return { pending: page.nextCursor != null };
}
module.exports = { classify, key };
