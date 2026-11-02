"use strict";

const { createHash } = require("node:crypto");
const { normalizeMemory, memoryTime, memoryHistoryAvailable } = require("./channel-memory-policy.cjs");
const { isPrivateDreamScope } = require("./channel-dream-settings.cjs");
const digest = value => createHash("sha256").update(String(value)).digest("hex");
const unique = values => [...new Set(values.filter(Boolean))];
const sourceVersion = event => digest(JSON.stringify([event.content, event.sender?.id || event.senderId || "",
  event.direction || event.role, event.source || "chat", event.provenance || null]));

// This is a projection of one complete fact, never an instruction or a score.
function factProjection(raw, content) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Memory fact must be an object");
  const text = (key, max) => {
    if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > max) throw new Error(`Invalid memory fact ${key}`);
    return raw[key].trim();
  };
  const conditions = raw.conditions ?? [];
  if (!Array.isArray(conditions) || conditions.length > 8 || conditions.some(v => typeof v !== "string" || !v.trim() || v.length > 160)) throw new Error("Invalid memory fact conditions");
  const assertion = raw.assertion || "reported";
  if (!["self", "reported", "observed"].includes(assertion)) throw new Error("Invalid memory fact assertion");
  return { subjectId: text("subjectId", 128), facet: text("facet", 80), value: text("value", 300),
    conditions: unique(conditions.map(v => v.trim())).sort(), assertion, contentHash: digest(content) };
}
const factKey = fact => fact ? digest(JSON.stringify([fact.subjectId, fact.facet, fact.value, fact.conditions, fact.assertion])) : "";
const activeFact = entry => entry.fact?.contentHash === digest(entry.content) ? entry.fact : null;

function sourceMetadata(event) {
  return { id: event.id, createdAt: event.createdAt, senderId: event.sender?.id || event.senderId || "",
    kind: event.source || "chat", provenance: event.provenance || null, version: event.sourceVersion || sourceVersion(event) };
}

function createMemoryWriter({ repository, documents = null, readSource, containsSecret = () => false, now = Date.now }) {
  function revise(scope, raw, method, authority = {}) {
    if (!["tool", "dream"].includes(method)) throw new Error("Memory revisions require a tool request or Dream evidence");
    const previous = raw.supersedes;
    if (!previous || typeof previous.id !== "string" || !previous.id.trim() || previous.id.length > 200
      || !Number.isSafeInteger(previous.revision) || previous.revision < 1) throw new Error("A revision requires the exact previous memory id and revision");
    if (!["correction", "change"].includes(raw.changeType)) throw new Error("Revision changeType must be correction or change");
    if (raw.reviewStatus !== undefined && !["confirmed", "pending"].includes(raw.reviewStatus)) throw new Error("Invalid revision reviewStatus");
    const content = String(raw.content || "").trim(), fact = factProjection(raw.fact, content);
    if (!content || content.length > 500 || containsSecret(content + JSON.stringify([fact, raw.evidence || []]))
      || /-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/i.test(content)) throw new Error("Invalid or sensitive memory revision content");
    const validFrom = memoryTime(raw.validFrom, "validFrom"), validTo = memoryTime(raw.validTo, "validTo");
    if (validFrom && validTo && validFrom >= validTo) throw new Error("Fact validity must end after it starts");
    const sourceIds = unique([...(raw.sourceIds || []), raw.sourceMessageId]);
    const id = `revision-${digest(JSON.stringify([previous.id, previous.revision, raw.changeType, content, fact, validFrom, validTo,
      sourceIds.slice().sort(), raw.sources || [], raw.evidence || []])).slice(0, 40)}`;
    const rejected = reason => ({ status: "rejected", reason, memory: null });
    return repository.transaction(() => {
      const old = repository.get(scope, previous.id);
      if (!old || old.revision !== previous.revision) return rejected("version_changed");
      if (method === "tool" && !authority.canEdit?.(old)) throw new Error("Memory revision is not authorized for this requester");
      if (old.sourceRevoked || old.invalidatedAt || old.documentPending || old.documentUnavailable
        || repository.excluded(scope, old.content, old.sourceIds || [old.sourceMessageId]) || repository.excluded(scope, content, sourceIds)) return rejected("source_or_memory_unavailable");
      const existing = repository.get(scope, id);
      if (old.supersededBy && old.supersededBy.id !== id) return rejected("already_superseded");
      // The evidence must still be the same original source at commit time.
      const sources = new Map();
      for (const source of raw.sources || []) {
        const live = readSource?.(scope, source.id);
        if (!source.version || !live || live.deleted || live.routeBlocked || sourceVersion(live) !== source.version) return rejected("source_changed");
        sources.set(source.id, live);
      }
      const proof = raw.evidence || [];
      if (!Array.isArray(proof) || proof.length > 10) throw new Error("Invalid revision evidence");
      for (const item of proof) {
        const source = sources.get(item.id);
        if (!source || typeof item.quote !== "string" || !item.quote.trim() || item.quote.length > 1000
          || !String(source.content || "").includes(item.quote)) return rejected("evidence_changed");
      }
      const oldFact = activeFact(old), subjectId = fact?.subjectId || old.subjectId || old.createdByUserId;
      const originalSpeaker = event => ["in", "inbound"].includes(event.direction) && !event.sender?.isBot
        && (!event.source || ["chat", "qq", "onebot", "qqbot"].includes(event.source));
      const evidenceFrom = sender => proof.some(item => {
        const source = sources.get(item.id);
        return originalSpeaker(source) && String(source.sender?.id || source.senderId || "") === sender;
      });
      let pendingReason = raw.reviewStatus === "pending" ? "evidence_requires_confirmation" : "";
      if (!proof.length || !evidenceFrom(method === "tool" ? String(authority.requesterUserId || "") : String(old.subjectId || old.createdByUserId || ""))) pendingReason ||= "author_evidence_required";
      if (fact?.assertion === "self" && !evidenceFrom(fact.subjectId)) pendingReason ||= "subject_evidence_required";
      // Omitting the new projection cannot discard an already known subject,
      // attribute or condition and turn a local exception into a replacement.
      if (oldFact && !fact) pendingReason ||= "fact_scope_requires_confirmation";
      if (old.subjectId && subjectId !== old.subjectId || oldFact && fact && (oldFact.facet !== fact.facet
        || JSON.stringify(oldFact.conditions) !== JSON.stringify(fact.conditions))) pendingReason ||= "fact_scope_requires_confirmation";
      if (raw.changeType === "change" && !validFrom) pendingReason ||= "change_time_required";
      if (!isPrivateDreamScope(scope) && (old.kind === "preference" || raw.kind === "preference")) return rejected("scope_policy");
      if (existing) {
        if (existing.documentPending || existing.documentUnavailable) return { status: "pending", memory: existing };
        if (!memoryHistoryAvailable(existing, { includePending: true })) return rejected("revision_unavailable");
        if (existing.reviewStatus !== "pending" || pendingReason) return { status: existing.reviewStatus === "pending" ? "needs_confirmation" : "existing", memory: existing };
      }
      const value = normalizeMemory({ ...raw, id, content, fact, subjectId, sourceIds, sources: raw.sources || [], evidence: proof,
        createdByUserId: old.createdByUserId, createdByUserName: old.createdByUserName,
        kind: old.kind || raw.kind || "fact", origin: method === "dream" ? "dream" : "manual", captureMethods: [method],
        createdAt: existing?.createdAt || now(), retention: old.retention, expiresAt: 0,
        reviewStatus: pendingReason ? "pending" : "confirmed", pendingReason, changeType: raw.changeType,
        supersedes: { id: old.id, revision: old.revision }, validFrom, validTo,
        writeIdentity: { contentHash: digest(content), factKey: factKey(fact) }, sourceRevoked: false, invalidatedAt: 0 }, now());
      const saved = repository.save(scope, documents ? documents.stage(scope, value, "memory") : value, existing?.revision || 0);
      if (!pendingReason) {
        repository.save(scope, { ...old, supersededBy: { id: saved.id, revision: saved.revision, changeType: raw.changeType,
          effectiveAt: raw.changeType === "change" ? validFrom : now() },
          ...(raw.changeType === "change" ? { validTo: validFrom } : {}) }, old.revision);
      }
      return { status: pendingReason ? "needs_confirmation" : "updated", memory: saved };
    });
  }
  function propose(scope, raw, method) {
    if (!["rule", "tool", "dream"].includes(method)) throw new Error("Unknown memory proposal method");
    const content = String(raw.content || "").trim();
    if (!content || content.length > 500) throw new Error("Memory content must contain 1 to 500 characters");
    const fact = factProjection(raw.fact, content);
    const validFrom = memoryTime(raw.validFrom, "validFrom"), validTo = memoryTime(raw.validTo, "validTo");
    if (validFrom && validTo && validFrom >= validTo) throw new Error("Fact validity must end after it starts");
    if (containsSecret(content + JSON.stringify(fact || {})) || /-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/i.test(content)) throw new Error("Memory cannot store credentials or private keys");
    const sourceIds = unique([...(raw.sourceIds || []), raw.sourceMessageId]);
    const rejected = reason => ({ status: "rejected", reason, memory: null });
    return repository.transaction(() => {
      if (repository.excluded(scope, content, sourceIds)) return rejected("forgotten");
      if (!isPrivateDreamScope(scope) && (raw.kind === "preference" || method === "rule" || method === "dream" && raw.kind !== "fact")) return rejected("scope_policy");
      // Check again at commit, after any document I/O or model call.
      for (const source of raw.sources || []) {
        if (!readSource || !source.version) continue;
        const live = readSource(scope, source.id);
        if (!live || live.deleted || live.routeBlocked || sourceVersion(live) !== source.version) return rejected("source_changed");
      }
      if (fact?.assertion === "self" && !(raw.sources || []).some(source => source.senderId === fact.subjectId)) return rejected("subject_evidence_mismatch");
      const key = factKey(fact), hash = digest(content);
      const candidates = repository.list(scope, { includeExpired: true });
      const existing = candidates.find(entry => {
        if (entry.id === raw.id && entry.sourceRevoked && raw.sources?.length && raw.sources.every(source => source.version)) return false;
        const sameSubject = (entry.subjectId || entry.createdByUserId) === (fact?.subjectId || raw.subjectId || raw.createdByUserId);
        const pending = entry.documentPending || entry.documentUnavailable;
        return sameSubject && (entry.validFrom || 0) === validFrom && (entry.validTo || 0) === validTo
          && (entry.content === content || key && key === factKey(activeFact(entry))
          || pending && (entry.writeIdentity?.contentHash === hash || key && entry.writeIdentity?.factKey === key));
      });
      if (existing) {
        if (existing.invalidatedAt || existing.sourceRevoked || existing.expiresAt && existing.expiresAt <= now()) return rejected("inactive_fact");
        if (existing.documentPending || existing.documentUnavailable) return { status: "pending", memory: existing };
        const merge = (a, b, identity) => [...new Map([...(a || []), ...(b || [])].map(value => [identity(value), value])).values()];
        const changedSources = new Set((raw.sources || []).filter(source => (existing.sources || [])
          .some(oldSource => oldSource.id === source.id && oldSource.version !== source.version)).map(source => source.id));
        const value = { ...existing,
          sourceIds: unique([...(existing.sourceIds || []), existing.sourceMessageId, ...sourceIds]),
          sources: merge(existing.sources, raw.sources, v => v.id),
          evidence: merge((existing.evidence || []).filter(proof => !changedSources.has(proof.id)), raw.evidence, v => JSON.stringify([v.id, v.quote, v.offset])),
          captureMethods: unique([...(existing.captureMethods || []), method]),
          writeIdentity: { contentHash: digest(existing.content), factKey: factKey(activeFact(existing)) },
        };
        if (JSON.stringify(value) === JSON.stringify(existing)) return { status: "existing", memory: existing };
        const saved = repository.save(scope, documents ? documents.stage(scope, value, "memory") : value, existing.revision);
        return { status: "existing", memory: saved };
      }
      const old = repository.get(scope, raw.id);
      if (old && !old.sourceRevoked) return rejected("version_changed");
      if (old?.sourceRevoked && (!raw.sources?.length || raw.sources.some(source => !source.version))) return rejected("unverified_source");
      const value = normalizeMemory({ ...raw, content, fact, validFrom, validTo, subjectId: fact?.subjectId || raw.subjectId || "",
        sourceIds, captureMethods: [method], writeIdentity: { contentHash: hash, factKey: key },
        sourceRevoked: false, invalidatedAt: 0 }, now());
      return { status: "created", memory: repository.save(scope, documents ? documents.stage(scope, value, "memory") : value, old?.revision || 0) };
    });
  }
  return { propose, revise };
}

module.exports = { createMemoryWriter, factProjection, activeFact, factKey, digest, sourceVersion, sourceMetadata };
