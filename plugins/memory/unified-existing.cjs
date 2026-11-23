"use strict";
const { CATEGORY } = require("./unified-memes.cjs");

// Duplicate lookup is a submission requirement for each proposed record. It is
// scoped to this chat's own space and bounded independently of model searches.
const { identity } = require("./unified-candidates.cjs");
const PAGE_SIZE = 100;
const available = item => item && ["active", "pending"].includes(item.status);
function descriptor(item, scope) {
  const subjectId = item.subjectRefs?.find(value => typeof value === "string") || item.subjectId || item.fact?.subjectId
    || item.attributes?.fact?.subjectId || (item.kind === "matter" ? scope.chatId.split(":private:")[1] : "");
  return { kind: item.kind || "fact", subjectId: subjectId || "", content: String(item.content || "") };
}
function queries(item, scope) {
  const value = descriptor(item, scope);
  if (item.category === CATEGORY && value.subjectId) return [{ kind: value.kind, category: CATEGORY, query: value.subjectId }];
  // Subject-only lookup finds paraphrases whose prose no longer contains the
  // structured attribute/value. Unattributed facts use bounded text queries.
  if (value.subjectId) {
    const fact = item.fact || item.attributes?.fact;
    const personal = ["fact", "preference"].includes(value.kind) && (!item.category || item.category === "profile")
      && fact?.assertion === "self" && fact.subjectId === value.subjectId;
    return [{ ...(personal ? {} : { kind: value.kind }), subjectId: value.subjectId, query: "" }];
  }
  const text = value.content.normalize("NFKC").trim();
  const parts = [...new Set([text.slice(0, 80), ...text.split(/[\s，。！？；：、,.!?;:()（）"“”]+/u).filter(part => part.length >= 2).slice(0, 2)])].filter(Boolean);
  return parts.map(query => ({ kind: value.kind, query: query.slice(0, 500) }));
}
async function resolveExisting(ctx, scope, supplied = [], proposals = [], { profileHistory = false, relatedIds = [] } = {}) {
  ctx.signal.throwIfAborted();
  const ownSpace = ctx.api.memorySpace
    ? (await ctx.api.memorySpace({ action: "list", chatId: scope.chatId })).spaces?.find(item => item.kind === "chat" && item.ownerId === scope.chatId) : null;
  ctx.signal.throwIfAborted();
  const known = new Map(), reads = new Map(), searches = new Map();
  const identities = new Set(proposals.map(identity)), related = new Set(relatedIds);
  const fieldKey = (subject, field) => JSON.stringify([subject, field]);
  const fields = new Set(proposals.flatMap(record => {
    const profile = record.attributes?.profile || {};
    return [profile.field, profile.usage].filter(Boolean).map(field => fieldKey(record.subjectRefs?.[0], field));
  }));
  function relevant(item) {
    if (related.has(item.id) || identities.has(identity(item))) return true;
    const profile = item.attributes?.profile || {};
    return item.subjectRefs?.some(subject => [profile.field, profile.usage].some(field => field && fields.has(fieldKey(subject, field))));
  }
  let stopped;
  const active = () => { ctx.signal.throwIfAborted(); if (stopped) throw stopped; };
  const read = (id, expectedRevision, suppliedRecord = false) => {
    const key = `${id}:${expectedRevision || ""}`;
    if (reads.has(key)) return reads.get(key);
    const task = (async () => {
      active();
      let item;
      try { item = (await ctx.api.memory({ action: "read", chatId: scope.chatId, id, mode: "history", limit: 16000 })).item; }
      catch (error) { ctx.signal.throwIfAborted(); if (error.code === "MEMORY_NOT_FOUND") return; throw error; }
      active();
      if (!item) return;
      if (ctx.api.memorySpace && item.spaceId !== ownSpace?.id) {
        if (suppliedRecord) throw Error("整理只能更新当前聊天自己的记忆，不能合并其他聊天的画像");
        return;
      }
      if (expectedRevision && item.revision !== expectedRevision) throw Error("记忆在查重期间已变化，请重新查询后提交");
      if (suppliedRecord || (available(item) || profileHistory && item.category === "profile") && relevant(item)) known.set(item.id, item);
    })();
    // This cache only prevents repeat reads. Eviction never ends the search.
    if (reads.size >= 256) reads.delete(reads.keys().next().value);
    reads.set(key, task); return task;
  };
  // Explicit revisions and updates still require current authority, including
  // when a caller supplied a previously visible record from another chat.
  for (const item of supplied) await read(item.id, item.revision, true);
  if (ctx.api.memorySpace && !ownSpace) return [...known.values()];
  const search = input => {
    const key = JSON.stringify(input);
    if (searches.has(key)) return searches.get(key);
    const task = (async () => {
      let continuation = {};
      for (;;) {
        active();
        const result = await ctx.api.memory({ action: "search", chatId: scope.chatId, ...(ownSpace ? { spaceId: ownSpace.id } : {}),
          mode: "history", ...input, limit: PAGE_SIZE, ...continuation });
        active();
        for (const item of result.items || []) {
          if (!profileHistory && item.status && !available(item)) continue;
          await read(item.id, item.revision);
        }
        if (result.nextOffset == null) return;
        if (!result.items?.length || !Number.isSafeInteger(result.nextOffset) || result.nextOffset <= (continuation.offset || 0)) throw Error("记忆查重分页没有前进");
        continuation = { offset: result.nextOffset, snapshot: result.snapshot, at: result.at };
      }
    })();
    searches.set(key, task); return task;
  };
  // At most two independent lookups run concurrently; each host page/read stays
  // cancellable. Identical subject queries within this submission share work.
  const work = profileHistory ? [...new Set(proposals.map(item => item.subjectRefs[0]))].map(subjectId => ({ subjectId, category: "profile" }))
    : proposals.flatMap(item => queries(item, scope).flatMap(query => ["active", "pending"].map(status => ({ ...query, status }))));
  let next = 0;
  const results = await Promise.allSettled([0, 1].map(async () => {
    try { for (;;) { active(); const item = work[next++]; if (!item) return; await search(item); } }
    catch (error) { stopped ||= error; throw error; }
  }));
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  ctx.signal.throwIfAborted();
  return [...known.values()];
}
module.exports = { resolveExisting, PAGE_SIZE };
