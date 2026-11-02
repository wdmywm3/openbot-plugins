"use strict";

const DAY = 86_400_000;
const INITIAL_RECALL_SCORE = 1;
const AUTO_RECALL_THRESHOLD = 1;
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const text = (value, max = 500) => String(value || "").trim().slice(0, max);

function normalizeMemory(raw, now = Date.now()) {
  const retention = raw.retention === "long_term" ? "long_term" : "short_term";
  const createdAt = number(raw.createdAt, now) || now;
  const { confirmedHitCount, provisionalHitCount, knowledgeDocumentId, knowledgeCollection, ...fields } = raw;
  return {
    ...fields,
    // Old host knowledge copies are archival provenance, not resources owned by
    // this plugin. Imported facts now use the plugin's own document lifecycle.
    ...(knowledgeDocumentId ? { legacyKnowledge: { documentId: knowledgeDocumentId, collection: knowledgeCollection || "" } } : {}),
    id: text(raw.id, 200),
    content: text(raw.content),
    createdByUserId: text(raw.createdByUserId, 128),
    createdByUserName: text(raw.createdByUserName, 100),
    subjectId: text(raw.subjectId, 128),
    sourceMessageId: text(raw.sourceMessageId, 200),
    referenceMessageIds: [...new Set((raw.referenceMessageIds || []).map(id => text(id, 200)))].filter(Boolean).slice(-20),
    retention,
    revision: Math.max(1, number(raw.revision, 1)),
    createdAt,
    updatedAt: number(raw.updatedAt),
    expiresAt: Math.max(0, number(raw.expiresAt)),
    strength: clamp(number(raw.strength, retention === "long_term" ? 0.85 : 0.6), 0, 1),
    strengthAt: number(raw.strengthAt, number(raw.updatedAt) || createdAt),
    lastUsedAt: number(raw.lastUsedAt),
    retrievedCount: Math.max(0, number(raw.retrievedCount, Array.isArray(raw.referenceMessageIds) ? raw.referenceMessageIds.length : 0)),
    usedCount: Math.max(0, number(raw.usedCount)),
    useScore: Math.max(0, number(raw.useScore, number(confirmedHitCount) + number(provisionalHitCount))),
    retrievalErrorCount: Math.max(0, number(raw.retrievalErrorCount)),
    misappliedCount: Math.max(0, number(raw.misappliedCount)),
    contradictedCount: Math.max(0, number(raw.contradictedCount)),
    pinned: raw.pinned === true,
    invalidatedAt: Math.max(0, number(raw.invalidatedAt)),
    reviewStatus: raw.reviewStatus === "pending" ? "pending" : "confirmed",
    validFrom: Math.max(0, number(raw.validFrom)),
    validTo: Math.max(0, number(raw.validTo)),
  };
}

function memoryRecallScore(memory) {
  return INITIAL_RECALL_SCORE + number(memory.useScore) - number(memory.retrievalErrorCount);
}
// Compatibility name for older callers. Neither time nor legacy retention affects this score.
const memoryStrength = memoryRecallScore;
const memoryAutoRecall = (memory, now = Date.now()) => memoryAvailable(memory, now)
  && memoryRecallScore(memory) >= AUTO_RECALL_THRESHOLD;

function memoryAvailable(memory, now = Date.now()) {
  return memoryHistoryAvailable(memory) && memory.reviewStatus !== "pending"
    && (!memory.supersededBy || memory.supersededBy.changeType === "change" && memory.supersededBy.effectiveAt > now)
    && (!memory.validFrom || memory.validFrom <= now) && (!memory.validTo || memory.validTo > now)
    && (!memory.expiresAt || memory.expiresAt > now);
}

function memoryHistoryAvailable(memory, { includePending = false } = {}) {
  return !!memory?.id && !!memory.content && !memory.invalidatedAt && !memory.sourceRevoked
    && !memory.documentUnavailable && !memory.documentPending && (includePending || memory.reviewStatus !== "pending");
}

function memoryTime(value, label = "fact time") {
  if (value === undefined || value === null || value === "" || value === 0) return 0;
  const parsed = typeof value === "number" ? value : typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}; use an ISO timestamp with timezone`);
  return parsed;
}

function applyMemoryUse(memory, outcome, now = Date.now()) {
  // Accept the earlier outcomes when replaying existing assessment records.
  if (["used", "unopposed", "supported"].includes(outcome)) return {
    ...memory,
    usedCount: memory.usedCount + 1,
    useScore: memory.useScore + 1,
    lastUsedAt: now,
  };
  if (outcome === "retrieval_error") return { ...memory, retrievalErrorCount: memory.retrievalErrorCount + 1 };
  if (outcome === "contradicted") return {
    ...memory,
    contradictedCount: memory.contradictedCount + 1,
    invalidatedAt: now,
  };
  // A wrong application does not prove the remembered fact itself is false.
  if (outcome === "misapplied") return { ...memory, usedCount: memory.usedCount + 1, misappliedCount: memory.misappliedCount + 1 };
  return memory;
}

function searchTokens(value) {
  const normalized = text(value, 4000).normalize("NFKC").toLowerCase();
  const tokens = normalized.match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) || [];
  return [...new Set(tokens.flatMap(token => {
    if (!/\p{Script=Han}/u.test(token)) return [token];
    const chars = [...token];
    return chars.length === 1 ? chars : chars.slice(0, -1).map((char, i) => char + chars[i + 1]);
  }))];
}

module.exports = { DAY, INITIAL_RECALL_SCORE, AUTO_RECALL_THRESHOLD, normalizeMemory, memoryRecallScore,
  memoryAutoRecall, memoryStrength, memoryAvailable, memoryHistoryAvailable, memoryTime, applyMemoryUse, searchTokens };
