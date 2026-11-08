"use strict";
const { CATEGORY } = require("./unified-memes.cjs");

// Duplicate lookup is a submission requirement for each proposed record. It is
// scoped to this chat's own space and bounded independently of model searches.
const PAGE_SIZE = 32, MAX_PAGES = 4, MAX_READS = 256, MAX_SEARCHES = 256;
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
  if (value.subjectId) return [{ kind: value.kind, subjectId: value.subjectId, query: "" }];
  const text = value.content.normalize("NFKC").trim();
  const parts = [...new Set([text.slice(0, 80), ...text.split(/[\s，。！？；：、,.!?;:()（）"“”]+/u).filter(part => part.length >= 2).slice(0, 2)])].filter(Boolean);
  return parts.map(query => ({ kind: value.kind, query: query.slice(0, 500) }));
}
async function resolveExisting(ctx, scope, supplied = [], proposals = []) {
  ctx.signal.throwIfAborted();
  if (proposals.length > 128 || supplied.length > MAX_READS) throw Error("本批查重条目过多，请分批提交");
  const ownSpace = ctx.api.memorySpace
    ? (await ctx.api.memorySpace({ action: "list", chatId: scope.chatId })).spaces?.find(item => item.kind === "chat" && item.ownerId === scope.chatId) : null;
  ctx.signal.throwIfAborted();
  const known = new Map(), reads = new Map(), searches = new Map();
  let readCount = 0, searchCount = 0, stopped;
  const active = () => { ctx.signal.throwIfAborted(); if (stopped) throw stopped; };
  const read = (id, expectedRevision, suppliedRecord = false) => {
    const key = `${id}:${expectedRevision || ""}`;
    if (reads.has(key)) return reads.get(key);
    const task = (async () => {
      active();
      if (++readCount > MAX_READS) throw Error("本批查重范围过大，请按对象或主题分批提交");
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
      if (suppliedRecord || available(item)) known.set(item.id, item);
    })();
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
      for (let page = 0; page < MAX_PAGES; page++) {
        active();
        if (++searchCount > MAX_SEARCHES) throw Error("本批查重查询过多，请分批提交");
        const result = await ctx.api.memory({ action: "search", chatId: scope.chatId, ...(ownSpace ? { spaceId: ownSpace.id } : {}),
          mode: "history", ...input, limit: PAGE_SIZE, ...continuation });
        active();
        for (const item of result.items || []) {
          if (item.status && !available(item)) continue;
          await read(item.id, item.revision);
        }
        if (result.nextOffset == null) return;
        continuation = { offset: result.nextOffset, snapshot: result.snapshot, at: result.at };
      }
      throw Error("这个对象的记忆过多，请缩小查重范围后提交");
    })();
    searches.set(key, task); return task;
  };
  // At most two independent lookups run concurrently; each host page/read stays
  // cancellable. Identical subject queries within this submission share work.
  const work = proposals.flatMap(item => queries(item, scope).flatMap(query => ["active", "pending"].map(status => ({ ...query, status }))));
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
module.exports = { resolveExisting, PAGE_SIZE, MAX_PAGES, MAX_READS, MAX_SEARCHES };
