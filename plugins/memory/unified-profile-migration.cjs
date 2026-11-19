"use strict";
const { get, put, hash } = require("./unified-state.cjs");
const { identity, factIdentity } = require("./unified-candidates.cjs");
const { sectionForSelfFact } = require("./unified-profile-policy.cjs");
const { admit } = require("./unified-material-policy.cjs");
const key = scope => `plus:profile-category:${scope.chatId}`;
const VERSION = 2;
const pending = (storage, scope) => {
  const cursor = get(storage, key(scope));
  return cursor?.version !== VERSION || !cursor.complete;
};
const sourceKey = ref => JSON.stringify([ref.chatId, ref.id, ref.version, ref.quote || ""]);
async function mergeProfileTwin(ctx, scope, record) {
  const actor = `plugin:${ctx.plugin?.id || "memory"}`, attributes = record.attributes || {};
  if (record.kind !== "fact" || record.createdBy !== actor || record.updatedBy !== actor || record.nextOffset != null
    || !["active", "pending"].includes(record.status) || attributes.origin || attributes.legacy || attributes.import
    || attributes.retention?.protected !== false || !record.sources?.length || record.relations?.length
    || factIdentity(record)?.assertion !== "self" || attributes.fact.subjectId !== record.subjectRefs[0]) return;
  const page = await ctx.api.memory({ action: "search", chatId: scope.chatId, spaceId: record.spaceId,
    subjectId: record.subjectRefs[0], query: record.content.slice(0, 500), mode: "current", limit: 12 });
  let equivalent = false;
  for (const hit of page.items || []) {
    if (hit.id === record.id || hit.category !== "profile" && (hit.category || hit.kind !== "preference")) continue;
    ctx.signal.throwIfAborted();
    const twin = (await ctx.api.memory({ action: "read", chatId: scope.chatId, id: hit.id, limit: 2000 })).item;
    if (!twin || twin.spaceId !== record.spaceId || twin.category !== "profile" && (twin.category || twin.kind !== "preference") || twin.status !== "active"
      || twin.createdBy !== actor || twin.updatedBy !== actor || twin.nextOffset != null || twin.content !== record.content
      || record.tier === "long_term" && twin.tier !== "long_term" || identity(twin) !== identity(record)) continue;
    equivalent = true;
    const sources = new Set(twin.sources.map(sourceKey));
    if (!record.sources.every(ref => ref.chatId === scope.chatId && sources.has(sourceKey(ref)))) continue;
    // Both revisions are checked by the same transaction. Keep a link and the
    // original history so an owner can trace the archived copy.
    const classifyTwin = twin.category !== "profile";
    await ctx.api.memory({ action: "batch", chatId: scope.chatId, requestKey: `profile-twin:${hash([twin.id, twin.revision, record.id, record.revision])}`,
      operations: [...(classifyTwin ? [{ action: "revise", id: twin.id, expectedRevision: twin.revision, changeType: "edit", patch: { category: "profile" } }] : []),
        { action: "relate", id: twin.id, expectedRevision: twin.revision + Number(classifyTwin), targetId: record.id, kind: "related" },
        { action: "transition", id: record.id, expectedRevision: record.revision, reason: "同一成员的同源事实已保存在人物画像", patch: { status: "archived" } }] });
    return;
  }
  const section = sectionForSelfFact(attributes.fact);
  if (equivalent || page.nextOffset != null || !section || record.status !== "active" || record.tier !== "long_term"
    || !["stable", "explicit", "boundary"].includes(attributes.retention?.basis) || !ctx.api.sources || record.sources.length > 10) return;
  for (const ref of record.sources) {
    ctx.signal.throwIfAborted();
    if (ref.chatId !== scope.chatId || !ref.quote?.trim()) return;
    const { item } = await ctx.api.sources({ action: "read", chatId: scope.chatId, id: ref.id, version: ref.version, limit: 4000 });
    if (!item || item.version !== ref.version || !admit(item) || item.direction !== "in" || item.forwarded || item.sender?.isBot
      || String(item.sender?.id) !== record.subjectRefs[0] || !item.content.includes(ref.quote)) return;
  }
  await ctx.api.memory({ action: "revise", chatId: scope.chatId, id: record.id, expectedRevision: record.revision,
    requestKey: `profile-self-fact:${hash([record.id, record.revision])}`, changeType: "edit",
    patch: { category: "profile", attributes: { ...attributes, profile: { section, basis: "self_report" } } } });
}
async function classify(ctx, storage, scope) {
  ctx.signal.throwIfAborted();
  if (!ctx.api.memorySpace) return { pending: false };
  const spaces = await ctx.api.memorySpace({ action: "list", chatId: scope.chatId });
  const local = spaces.spaces?.find(item => item.kind === "chat" && item.ownerId === scope.chatId);
  const previous = get(storage, key(scope)), old = previous?.version === VERSION ? previous : { after: 0 };
  if (old.complete) return { pending: false };
  if (!local) { put(storage, key(scope), { version: VERSION, after: 0, complete: true }); return { pending: false }; }
  const page = await ctx.api.memory({ action: "changes", chatId: scope.chatId, spaceId: local.id, after: old.after, upper: old.upper, limit: 20 });
  const seen = new Set();
  for (const change of page.items) {
    ctx.signal.throwIfAborted();
    if (change.spaceId !== local.id || seen.has(change.id)) continue;
    seen.add(change.id);
    let record;
    try { record = (await ctx.api.memory({ action: "read", chatId: scope.chatId, id: change.id, mode: "history", limit: 2000 })).item; }
    catch (error) { if (error.code === "MEMORY_NOT_FOUND") continue; throw error; }
    if (!record || record.category || !["fact", "preference"].includes(record.kind)
      || record.subjectRefs?.length !== 1 || typeof record.subjectRefs[0] !== "string") continue;
    try {
      if (record.kind === "preference" || record.attributes?.profile) {
        if (record.updatedBy !== record.createdBy) continue;
        await ctx.api.memory({ action: "revise", chatId: scope.chatId, id: record.id, expectedRevision: record.revision,
          changeType: "edit", patch: { category: "profile" }, requestKey: `profile-category:${hash([record.id, record.revision])}` });
      } else await mergeProfileTwin(ctx, scope, record);
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (error.code === "MEMORY_CONFLICT") return { pending: true };
      if (!["MEMORY_NOT_FOUND", "MEMORY_SOURCE", "MEMORY_FORGOTTEN_SOURCE"].includes(error.code)) throw error;
    }
  }
  put(storage, key(scope), { version: VERSION, after: page.nextCursor ?? page.upper, upper: page.upper, complete: page.nextCursor == null });
  return { pending: page.nextCursor != null };
}
module.exports = { classify, key, pending };
