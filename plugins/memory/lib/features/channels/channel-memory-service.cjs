"use strict";

const { createHash } = require("node:crypto");
const { normalizeMemory, memoryRecallScore, memoryAutoRecall, memoryAvailable, memoryTime } = require("./channel-memory-policy.cjs");
const { createMemoryRetrieval } = require("./channel-memory-retrieval.cjs");
const { createMemoryWriter, factProjection, activeFact, digest, factKey, sourceMetadata, sourceVersion } = require("./channel-memory-write.cjs");

function createChannelMemoryService(deps) {
  let retrieval, documentAdapter;
  const {
    channelMemoryEntries, channelStorageRepository, resolveChannel, unpackArgs,
    profileText, makeId, containsSecretPattern, normalizePlatformRole, vectorIndex,
  } = deps;
  function context(args) {
    const params = unpackArgs(args);
    const channel = resolveChannel(params.channelId || params.channelName || params.name);
    if (!channel) throw new Error("Bot not found");
    const scope = { channelId: channel.id, chatId: String(params.chatId || "").trim() };
    if (!scope.chatId) throw new Error("memory requires the current chatId");
    // This read performs the one-time migration before any writes or retrieval.
    channelMemoryEntries(channel, scope.chatId);
    const repository = channelStorageRepository?.memoryRepository;
    if (!repository) throw new Error("Memory storage is unavailable");
    return { params, channel, scope, repository };
  }
  const publicMemory = entry => ({
    ...entry, referenceCount: entry.useScore,
    recallScore: memoryRecallScore(entry), automaticRecall: memoryAutoRecall(entry),
  });
  function checkEdit(entry, params) {
    const role = normalizePlatformRole(params.requesterRole);
    if (entry.createdByUserId !== String(params.requesterUserId || "") && !["admin", "owner"].includes(role)) {
      throw new Error("Only the member who requested this memory or a group admin can change it");
    }
  }
  function contentOf(params) {
    const content = profileText(params.content, 500);
    if (!content) throw new Error("Memory content is required");
    if (containsSecretPattern(content) || /-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/i.test(content)) throw new Error("Memory cannot store credentials or private keys");
    return content;
  }
  const documents = () => channelStorageRepository?.documentService && (documentAdapter ||= require("./channel-dream-documents.cjs").createDreamDocuments({ storage: channelStorageRepository }));
  const readSource = (scope, id) => channelStorageRepository?.getEvent?.(scope.channelId, scope.chatId, id)
    || channelStorageRepository?.dreamRepository?.source(scope, id, Number.MAX_SAFE_INTEGER);
  const liveSourcesAvailable = (scope, entry) => (entry.sources || []).every(source => {
    if (!source.version) return true;
    const live = readSource(scope, source.id);
    return live && !live.deleted && !live.routeBlocked && sourceVersion(live) === source.version;
  });
  const writer = repository => createMemoryWriter({ repository, documents: documents(), readSource, containsSecret: containsSecretPattern });
  function provenance(scope, params) {
    if (params.sourceQuote !== undefined && (typeof params.sourceQuote !== "string" || params.sourceQuote.length > 1000)) throw new Error("Memory evidence must be an excerpt of at most 1000 characters");
    if (params.sourceQuote && (containsSecretPattern(params.sourceQuote) || /-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/i.test(params.sourceQuote))) throw new Error("Memory cannot store credentials or private keys");
    const event = params.sourceMessageId && readSource(scope, params.sourceMessageId);
    if (event && (event.deleted || event.routeBlocked)) throw new Error("Memory source is no longer available");
    if (params.sourceQuote && (!event || !event.content.includes(params.sourceQuote))) throw new Error("Memory evidence does not match the source");
    const sourceMessageId = String(event?.id || params.sourceMessageId || "");
    return { sourceMessageId, sourceIds: [sourceMessageId].filter(Boolean),
      sources: event ? [sourceMetadata(event)] : [],
      evidence: event && params.sourceQuote ? [{ id: event.id, quote: params.sourceQuote, offset: event.content.indexOf(params.sourceQuote) }] : [] };
  }
  function execute(args) {
    const current = context(args);
    const run = () => documents() ? documents().prepare(current.scope).then(() => executeScoped(current)) : executeScoped(current);
    return current.params.sourceMessageId && channelStorageRepository?.flush ? channelStorageRepository.flush().then(run) : run();
  }
  function written(scope, action, entry, status = "updated") {
    const expectedHash = entry.documentPending || entry.documentUnavailable ? entry.writeIdentity?.contentHash : digest(entry.content);
    const receipt = live => {
      if (!live || live.invalidatedAt || live.sourceRevoked) return { ok: false, action, status: "rejected", memoryId: entry.id, reason: "changed_before_receipt" };
      const pending = live.documentUnavailable || live.documentPending;
      if (!pending && expectedHash && digest(live.content) !== expectedHash) return { ok: false, action, status: "rejected", memoryId: entry.id, reason: "changed_before_receipt" };
      if (live.reviewStatus === "pending") return { ok: false, action, status: pending ? "pending" : "needs_confirmation",
        memoryId: live.id, revision: live.revision, memory: publicMemory(live), reason: live.pendingReason };
      if (live.supersededBy && (live.supersededBy.changeType !== "change" || live.supersededBy.effectiveAt <= Date.now())) {
        return { ok: false, action, status: "rejected", memoryId: live.id, reason: "superseded" };
      }
      return { ok: !pending, action, status: pending ? "pending" : status === "pending" ? "existing" : status,
        memoryId: live.id, revision: live.revision, memory: publicMemory(live),
        ...(pending ? { message: "笔记尚未写回，暂不能确认已记住；恢复写回后再检查此记忆。" } : {}) };
    };
    if (!documents()) return receipt(entry);
    return documents().prepare(scope).then(() => {
      const live = channelStorageRepository.memoryRepository.get(scope, entry.id);
      return receipt(live);
    });
  }
  function executeScoped({ params, channel, scope, repository }) {
    const action = String(params.action || "recall").trim().toLowerCase();
    const now = Date.now();
    const entries = repository.list(scope).filter(entry => require("./channel-dream-settings.cjs").isPrivateDreamScope(scope)
      || entry.kind !== "preference" && (entry.origin !== "dream" || entry.kind === "fact"));
    if (action === "remember") {
      const content = contentOf(params);
      const createdByUserId = String(params.requesterUserId || "").trim();
      if (!createdByUserId) throw new Error("Memory requires a bound requester");
      const profile = channelStorageRepository.getIdentityProfile?.(channel.id, scope.chatId, "member", createdByUserId);
      const value = normalizeMemory({
        id: makeId("channel-memory"), content, createdByUserId,
        createdByUserName: profileText(profile?.preferredAddress || params.requesterUserName, 100),
        // Authorship is not the subject of the remembered statement.
        subjectId: "", fact: params.fact, sourceMessageId: String(params.sourceMessageId || ""),
        validFrom: memoryTime(params.validFrom, "validFrom"), validTo: memoryTime(params.validTo, "validTo"),
        ...provenance(scope, params), origin: "manual",
        createdAt: now, expiresAt: 0, retention: "short_term",
      }, now);
      const result = writer(repository).propose(scope, value, "tool");
      return result.memory ? written(scope, action, result.memory, result.status) : { ok: false, action, ...result };
    }
    if (action === "revise") {
      const content = contentOf(params), proof = provenance(scope, params);
      const result = writer(repository).revise(scope, { content, ...proof, fact: params.fact,
        supersedes: params.supersedes, changeType: params.changeType, validFrom: params.validFrom, validTo: params.validTo,
        reviewStatus: params.reviewStatus }, "tool", { requesterUserId: String(params.requesterUserId || ""),
        canEdit: entry => { checkEdit(entry, params); return true; } });
      return result.memory ? written(scope, action, result.memory, result.status) : { ok: false, action, ...result };
    }
    if (action === "history") {
      const query = profileText(params.query, 160), limit = Math.max(1, Math.min(20, Math.floor(Number(params.limit) || 8)));
      const offset = Number.isSafeInteger(params.offset) && params.offset > 0 ? params.offset : 0;
      const at = memoryTime(params.at, "history at");
      let rows = repository.history(scope, { id: String(params.memoryId || ""), includePending: params.includePending === true })
        .filter(entry => liveSourcesAvailable(scope, entry))
        .filter(entry => require("./channel-dream-settings.cjs").isPrivateDreamScope(scope)
          || entry.kind !== "preference" && (entry.origin !== "dream" || entry.kind === "fact"));
      if (query) rows = require("./channel-memory-retrieval.cjs").lexicalRanks(query, rows, now).filter(row => row.lexicalScore > 0).map(row => row.entry);
      if (at) rows = rows.filter(entry => (!entry.validFrom || entry.validFrom <= at) && (!entry.validTo || entry.validTo > at));
      return { ok: true, action, query, at, memories: rows.slice(offset, offset + limit).map(publicMemory), count: Math.min(limit, Math.max(0, rows.length - offset)),
        offset, nextOffset: offset + limit < rows.length ? offset + limit : null,
        message: "Historical and pending records are labeled; corrected values and unconfirmed proposals are not current facts." };
    }
    if (action === "recall") {
      const query = profileText(params.query, 160);
      const limit = Math.max(1, Math.min(20, Math.floor(Number(params.limit) || 8)));
      const offset = Number.isSafeInteger(params.offset) && params.offset > 0 ? params.offset : 0;
      // Only the host supplies automatic=true. Agent queries can search every valid note.
      const automatic = params.automatic === true;
      const searchable = automatic ? entries.filter(entry => memoryAutoRecall(entry, now)) : entries;
      const respond = (ranked, mode, fallbackReason = "") => {
        const current = ranked.filter(entry => {
          const live = repository.get(scope, entry.id);
          return live?.revision === entry.revision && memoryAvailable(live) && liveSourcesAvailable(scope, live)
            && (!automatic || memoryAutoRecall(live));
        });
        const page = current.slice(offset, offset + limit);
        repository.recordRecall(scope, String(params.turnId || ""), String(params.sourceMessageId || ""), page);
        return { ok: true, action, query, count: page.length, memories: page.map(publicMemory),
          continuity: channelStorageRepository.dreamRepository?.records(scope, { query, limit, includeClosed: true }) || [],
          retrievalMode: mode, fallbackReason, offset, nextOffset: offset + limit < current.length ? offset + limit : null };
      };
      if (!query) return respond(automatic ? [] : searchable.slice().reverse(), "list");
      retrieval ||= createMemoryRetrieval({ index: vectorIndex, repository });
      return retrieval.rank(scope, query, searchable, searchable.length, { ...params.retrievalContext, automatic })
        .then(result => respond(result.entries, result.mode, result.fallbackReason));
    }
    const entry = repository.get(scope, String(params.memoryId || "").trim());
    if (!entry) throw new Error("Memory was not found in the current chat");
    checkEdit(entry, params);
    if (params.expectedRevision !== undefined && params.expectedRevision !== entry.revision) throw new Error("Memory changed; read it again before updating");
    if (action === "update") {
      const content = contentOf(params);
      if (content === entry.content) return written(scope, action, entry, "existing");
      const proof = provenance(scope, params), fact = factProjection(params.fact, content);
      if (containsSecretPattern(JSON.stringify(fact || {}))) throw new Error("Memory cannot store credentials or private keys");
      if (fact?.assertion === "self" && !proof.sources.some(source => source.senderId === fact.subjectId)) throw new Error("Memory subject does not match its source speaker");
      const updated = repository.transaction(() => {
        repository.exclude(scope, entry);
        channelStorageRepository.dreamRepository?.removeDerived(scope, entry.sourceIds || [entry.sourceMessageId]);
        const value = {
        ...entry, content, sourceMessageId: String(params.sourceMessageId || ""),
        ...proof, fact, subjectId: fact?.subjectId || "", captureMethods: ["tool"],
        writeIdentity: { contentHash: digest(content), factKey: factKey(fact) },
        sourceRevoked: false, correctionEvidence: [], origin: "manual",
        updatedByUserId: String(params.requesterUserId || ""), updatedByUserName: profileText(params.requesterUserName, 100),
        updatedAt: now, referenceMessageIds: [], knowledgeDocumentId: "", knowledgeCollection: "",
        retrievedCount: 0, usedCount: 0, useScore: 0, misappliedCount: 0, contradictedCount: 0,
        retrievalErrorCount: 0, invalidatedAt: 0, lastUsedAt: 0,
        strength: entry.retention === "long_term" ? 0.85 : 0.6, strengthAt: now,
        };
        return repository.save(scope, documents() ? documents().stage(scope, value, "memory") : value, entry.revision);
      });
      return written(scope, action, updated);
    }
    if (action === "promote") {
      return { ok: true, action, memory: publicMemory(entry), message: "记忆已统一保存，不再区分普通和长期；此操作不改变使用分或有效期。" };
    }
    if (action === "forget") {
      const family = repository.revisionFamily(scope, entry.id);
      for (const related of family) checkEdit(related, params);
      repository.transaction(() => {
        for (const related of family) {
          documents()?.revoke(scope, related);
          repository.remove(scope, related.id);
          channelStorageRepository.dreamRepository?.removeDerived(scope, related.sourceIds || [related.sourceMessageId]);
        }
      });
      const result = { ok: true, action, memoryId: entry.id, forgotten: true, forgottenIds: family.map(item => item.id) };
      return documents() ? Promise.all(family.map(related => documents().forget(scope, related))).then(() => result) : result;
    }
    throw new Error(`Unknown memory action: ${action}`);
  }
  function recordDelivery(args) {
    const { params, scope, repository } = context(args);
    repository.recordDelivery(scope, String(params.turnId || ""), {
      sessionId: String(params.sessionId || ""), answerMessageId: String(params.answerMessageId || ""),
      answerHash: createHash("sha256").update(String(params.answer || "")).digest("hex"),
    });
    return { ok: true, pendingAssessment: true };
  }
  async function capture(args) {
    const { params, channel, scope, repository } = context(args);
    const eligible = () => channel.enabled !== false && deps.memoryCaptureAllowed?.(channel, scope) !== false
      && !deps.conversationBlocked?.(channel, { chatId: scope.chatId })
      && channelStorageRepository.dreamRepository?.state(scope).settings.enabled
      && !channelStorageRepository.dreamRepository?.rollback?.pending(scope);
    if (!eligible()) return null;
    await channelStorageRepository.flush?.();
    const { preferredAddress } = require("./channel-memory-rules.cjs");
    const value = preferredAddress(scope, readSource(scope, params.sourceMessageId));
    if (!value || containsSecretPattern(value.content)) return null;
    await documents()?.prepare(scope);
    if (!eligible()) return null;
    // A different existing address needs an explicit revision, never latest-message-wins.
    if (repository.list(scope).some(entry => activeFact(entry)?.facet === "preferred_address" && entry.subjectId === value.subjectId
      && entry.fact.value !== value.fact.value)) return null;
    const result = writer(repository).propose(scope, value, "rule");
    return result.memory ? written(scope, "remember", result.memory, result.status) : { ok: false, action: "remember", ...result };
  }
  return { execute, recordDelivery, capture };
}

module.exports = { createChannelMemoryService };
