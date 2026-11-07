"use strict";

const VERSION = 1;
const LIMITS = Object.freeze({ candidateCount: 64, candidateCharacters: 24000, workingCount: 128,
  workingCharacters: 64000, candidateTtlMs: 14 * 86400000 });
const BASES = new Set(["explicit", "boundary", "stable", "ongoing", "ephemeral"]);
const PROFILE_SECTIONS = new Set(["identity", "habits", "interests", "communication", "boundaries", "self_description"]);
const genericReasons = new Set(["有用", "以后有用", "以后可能有用", "便于以后回答", "供以后参考", "用户提到过", "有原话依据", "保存事实", "长期记忆", "useful", "for future reference"]);

function protectedRecord(record) {
  const attributes = record?.attributes || {}, policy = attributes.retention;
  return record?.tier === "long_term" || !!attributes.legacy || !!attributes.import || !!attributes.imported
    || attributes.origin === "direct" || attributes.origin === "manual"
    || !!record?.updatedBy && !!record?.createdBy && record.updatedBy !== record.createdBy
    || policy?.protected === true || policy?.basis === "explicit" || policy?.basis === "boundary"
    || ["identity", "communication", "boundaries"].includes(attributes.profile?.section)
    || record?.kind === "matter" && !["completed", "canceled", "closed"].includes(record.progress);
}

function admission(item, materials, scope, now = Date.now()) {
  const value = item?.retention;
  if (!value || typeof value !== "object" || Array.isArray(value) || !BASES.has(value.basis) || value.basis === "ephemeral") return null;
  if (typeof value.reason !== "string") return null;
  const reason = value.reason.trim();
  if (reason.length < 6 || reason.length > 500 || genericReasons.has(reason.normalize("NFKC").toLowerCase().replace(/[。.!！]+$/, ""))) return null;
  if (!Array.isArray(item.evidence) || !item.evidence.length) return null;
  const evidence = item.evidence.map(ref => materials.find(source => source.id === ref.id && typeof ref.quote === "string"
    && ref.quote.trim() && String(source.content || "").includes(ref.quote)));
  if (evidence.some(source => !source || source.direction !== "in" || source.sender?.isBot
    || source.deleted || source.routeBlocked || source.memoryExcluded || source.source && source.source !== "chat"
    || source.event?.type && source.event.type !== "message")) return null;
  const subjectId = item.subjectId || item.fact?.subjectId || scope.chatId?.split(":private:")[1] || "";
  const self = !!subjectId && evidence.every(source => String(source.sender?.id || source.senderId || "") === subjectId);
  const profile = PROFILE_SECTIONS.has(item.profileSection) && self;
  // A third party cannot turn a claim about somebody else into that person's
  // durable request or boundary. Ordinary supported facts can remain candidates.
  if (["explicit", "boundary"].includes(value.basis) && subjectId && !self) return null;
  if (value.basis === "boundary" && !self) return null;
  const stableProfile = profile && (item.kind === "preference" || ["identity", "communication", "boundaries"].includes(item.profileSection));
  const immediate = value.basis === "explicit" || value.basis === "boundary" || value.basis === "stable" && stableProfile;
  const observedAt = Math.max(...evidence.map(source => Number(source.createdAt) || 0));
  return { status: immediate ? "active" : "pending", tier: immediate ? "long_term" : "working",
    expiresAt: immediate ? null : (observedAt > 0 ? observedAt : now) + LIMITS.candidateTtlMs,
    attributes: { retention: { version: VERSION, basis: value.basis, reason, protected: immediate, observedAt } } };
}

async function candidateBudget(ctx, scope, operations, before) {
  const additions = operations.filter(operation => operation.action === "create" && operation.record?.status === "pending"
    && operation.record.attributes?.retention?.version === VERSION);
  if (!additions.length) return { operations, before, omitted: 0 };
  const spaces = await ctx.api.memorySpace?.({ action: "list", chatId: scope.chatId });
  const own = spaces?.spaces?.find(space => space.kind === "chat" && space.ownerId === scope.chatId);
  let count = 0, characters = 0, continuation = {};
  if (!ctx.api.memorySpace || own) do {
    ctx.signal.throwIfAborted();
    const result = await ctx.api.memory({ action: "search", chatId: scope.chatId, ...(own ? { spaceId: own.id } : {}),
      mode: "history", status: "pending", limit: 100, ...continuation });
    for (const item of result.items || []) {
      ctx.signal.throwIfAborted();
      const record = (await ctx.api.memory({ action: "read", chatId: scope.chatId, id: item.id, mode: "history", limit: 1 })).item;
      ctx.signal.throwIfAborted();
      if (!record || record.status !== "pending" || own && record.spaceId !== own.id) continue;
      count++; characters += record.contentLength ?? record.content?.length ?? 0;
      if (count >= LIMITS.candidateCount || characters >= LIMITS.candidateCharacters) break;
    }
    continuation = result.nextOffset == null ? null : { offset: result.nextOffset, snapshot: result.snapshot, at: result.at };
    // Once the candidate budget is exhausted, further rows cannot admit new
    // automatic candidates. Keep this check bounded even for pre-existing data.
  } while (continuation && count < LIMITS.candidateCount && characters < LIMITS.candidateCharacters);
  const kept = [], versions = []; let omitted = 0;
  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i];
    if (additions.includes(operation)) {
      const length = operation.record.content.length;
      if (operation.record.expiresAt <= Date.now() || count >= LIMITS.candidateCount || characters + length > LIMITS.candidateCharacters) { omitted++; continue; }
      count++; characters += length;
    }
    kept.push(operation); versions.push(before[i]);
  }
  return { operations: kept, before: versions, omitted };
}

module.exports = { VERSION, LIMITS, admission, protected: protectedRecord, candidateBudget };
