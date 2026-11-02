"use strict";

const { hash } = require("../../context/channel-dream-repository.cjs");
const { ASSESS_PROMPT, DreamOutputError, parseResult, nextRun } = require("./channel-dream-analysis.cjs");
const { lexicalRanks } = require("./channel-memory-retrieval.cjs");
const { createMemoryWriter, sourceMetadata, sourceVersion, activeFact, factKey } = require("./channel-memory-write.cjs");

function usable(event, cutoff) {
  return event && !event.routeBlocked && event.networkStatus !== "error"
    && event.source !== "channel_group_repeat" && Number(event.createdAt || 0) <= cutoff
    && ["in", "out", "inbound", "outbound"].includes(event.direction)
    && typeof event.content === "string" && !!event.content.trim();
}
function project(event, offset = 0, length = 4000) {
  return { id: event.id, senderId: String(event.sender?.id || ""),
    senderName: String(event.sender?.name || "").slice(0, 100),
    role: ["out", "outbound"].includes(event.direction) ? "bot" : "member",
    createdAt: Number(event.createdAt || 0), content: event.content.slice(offset, offset + length),
    createdAtIso: new Date(Number(event.createdAt || 0)).toISOString(),
    offset, hasMore: offset + length < event.content.length,
    source: event.source || "chat", sourceVersion: sourceVersion(event), provenance: event.provenance || null, noteRefs: event.noteRefs || [] };
}

function createChannelDreamService({ repository, memories, analyze, readAnswer, migrate = () => {},
  containsSecret = () => false, eligible = () => true, isBusy = () => false, now = Date.now,
  allowEvent = () => true, onRecords = async () => {}, documents = null, maxCalls = 8, timeoutMs = 90_000,
  readSource = (scope, id) => repository.source(scope, id, Number.MAX_SAFE_INTEGER), rankFacts, rankRecords }) {
  let running = null, runningScope = null, controller = null, timer = null, analysisSerial = 0, callLimit = Infinity, paused = false, ticking = null;
  const writer = createMemoryWriter({ repository: memories, documents, containsSecret, now, readSource });
  const commit = (scope, fn) => repository.transaction(() => repository.rollback
    ? repository.rollback.track(scope, repository.state(scope).job?.runId, fn) : fn());
  const change = (scope, counts, detail) => {
    const id = repository.state(scope).job?.runId;
    if (id) repository.runs?.change(scope, id, counts, detail);
  };
  async function call(scope, system, input) {
    if (isBusy(scope)) throw new Error("正在回复消息或执行任务，稍后继续整理");
    if (!eligible(scope)) throw new Error("当前聊天已停用整理");
    if (analysisSerial >= callLimit) throw Object.assign(new Error("本轮整理进度已保存"), { code: "DREAM_YIELD" });
    analysisSerial += 1;
    const foreground = new AbortController();
    const monitor = setInterval(() => {
      if (isBusy(scope) || !eligible(scope)) foreground.abort(new Error("正在回复消息或设置已更改，稍后继续整理"));
    }, 500);
    monitor.unref?.();
    const signal = AbortSignal.any([controller.signal, foreground.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const snapshot = repository.state(scope).job;
      const readMaterial = raw => {
        signal.throwIfAborted();
        const args = typeof raw === "string" ? JSON.parse(raw) : raw;
        const id = String(args?.id || "");
        const entry = repository.source(scope, id, snapshot.upper, snapshot.cutoff);
        if (!entry || !allowed(scope, entry, snapshot.cutoff)) throw new Error("材料不存在或不在当前可读范围");
        const offset = Math.max(0, Math.min(entry.content.length, Math.floor(Number(args.offset) || 0)));
        const limit = Math.max(1, Math.min(12000, Math.floor(Number(args.limit) || 6000)));
        const page = project(entry, offset, limit);
        input.messages?.push(page);
        return { ...page, nextOffset: page.hasMore ? offset + page.content.length : null };
      };
      const trace = (kind, payload) => snapshot.runId ? repository.runs?.trace(scope, snapshot.runId, kind, payload) : 0;
      const result = await analyze({ scope, system, input, signal, readMaterial, trace });
      signal.throwIfAborted();
      if (!eligible(scope)) throw new Error("当前聊天已停用整理");
      return result;
    } finally { clearInterval(monitor); }
  }
  const allowed = (scope, event, cutoff) => usable(event, cutoff)
    && allowEvent(scope, event) && !containsSecret(event.content) && !memories.excluded(scope, "", [event.id]);
  const coordinator = require("./channel-dream-coordinator.cjs").createDreamCoordinator({ repository, invoke: call, containsSecret, allowSource: allowed, rankRecords });
  function commitRecords(scope, entries) {
    for (const entry of entries || []) {
      if (entry.sourceIds.some(id => memories.excluded(scope, "", [id]))) continue;
      const previous = repository.getRecord(scope, entry.id);
      if (Number(previous?.revision || 0) !== entry.expectedRevision || (previous?.canceledByTaskControl || previous?.closedByUser) && ["active", "waiting"].includes(entry.status)) continue;
      if (previous && ["title", "content", "status", "nextReviewAt", "sourceIds", "evidence", "relatedIds", "noteRefs"]
        .every(key => JSON.stringify(previous[key]) === JSON.stringify(entry[key]))) continue;
      const { expectedRevision, ...record } = entry;
      const saved = repository.saveRecord(scope, documents ? documents.stage(scope, { ...record, documentRef: previous?.documentRef }) : record, expectedRevision);
      const kind = { episode: "经历", goal: "目标", question: "待解问题", followup: "跟进事项" }[saved.kind];
      change(scope, { records: 1 }, `${previous ? "更新" : "新增"}${kind}：${saved.title}\n${saved.content}\n状态：${saved.status}`);
    }
  }
  function context(scope, state, selected) {
    const ids = [...new Set([...(state.pending || []).flatMap(t => t.sourceIds), ...(state.tail || [])])].slice(-8);
    const selectedIds = new Set(selected.map(e => e.id));
    return ids.filter(id => !selectedIds.has(id)).map(id => repository.source(scope, id, state.job.upper, state.job.cutoff))
      .filter(e => allowed(scope, e, state.job.cutoff)).map(e => ({ ...project(e, 0, 600), contextOnly: true }));
  }
  function chunk(scope, state, budget) {
    const messages = [], sources = [], deferred = [];
    let cursor = state.cursor, offset = state.offset || 0, used = 0;
    // A cursor refers to the last fully consumed event. Offset refers to the next.
    for (const event of repository.page(scope, cursor, state.job.upper)) {
      if (event.createdAt > state.job.cutoff) { deferred.push(event); cursor = event.seq; offset = 0; continue; }
      const latest = repository.source(scope, event.id, state.job.upper, state.job.cutoff);
      if (latest.seq !== event.seq) { cursor = event.seq; offset = 0; continue; }
      sources.push({ ...event, continuation: offset > 0 });
      if (!allowed(scope, event, state.job.cutoff)) { cursor = event.seq; offset = 0; continue; }
      const length = Math.min(4000, budget - used);
      if (length <= 0) break;
      const overlap = Math.min(offset, 300);
      const message = project(event, offset - overlap, length + overlap);
      messages.push(message);
      used += message.content.length - overlap;
      if (message.hasMore) { offset += message.content.length - overlap; break; }
      cursor = event.seq; offset = 0;
      if (used >= budget) break;
    }
    return { messages, sources, deferred, cursor, offset };
  }
  async function extract(scope, state, budget) {
    const selected = chunk(scope, state, budget);
    const reconcile = () => {
      for (const event of selected.deferred) repository.defer(scope, event);
      for (const event of selected.sources) {
        const previous = !event.continuation && repository.source(scope, event.id, event.seq - 1);
        if (event.deleted || previous) memories.invalidateSource(scope, event.id, event);
        if (event.deleted || !allowed(scope, event, state.job.cutoff) || (previous && previous.content !== event.content)) {
          repository.removeDerived(scope, [event.id]);
        }
      }
    };
    if (!selected.messages.length) {
      return commit(scope, () => {
        reconcile();
        return repository.saveState(scope, { ...repository.state(scope), cursor: selected.cursor, offset: selected.offset });
      });
    }
    const query = selected.messages.map(m => m.content).join("\n");
    const candidates = rankFacts ? await rankFacts(scope, query, memories.list(scope))
      : lexicalRanks(query, memories.list(scope), now()).filter(row => row.lexicalScore > 0).slice(0, 20).map(row => row.entry);
    const existing = candidates.map(entry => ({ entry })).map(row => ({
        id: row.entry.id, revision: row.entry.revision, content: row.entry.content, subjectId: row.entry.subjectId,
        createdByUserId: row.entry.createdByUserId, fact: activeFact(row.entry), sourceIds: row.entry.sourceIds,
        validFrom: row.entry.validFrom, validTo: row.entry.validTo,
      }));
    const input = { cutoff: state.job.cutoff, cutoffIso: new Date(state.job.cutoff).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      existing, messages: [...context(scope, state, selected.messages), ...selected.messages] };
    const result = await coordinator.analyze(scope, state, input);
    return commit(scope, () => {
      reconcile();
      // Re-read after await: an explicit style reset/lock or forgetting a fact wins.
      const live = repository.state(scope);
      if (!live.job || live.job.upper !== state.job.upper || !live.settings.enabled) throw new Error("整理任务已取消");
      const revisionTargets = new Set((result.revisions || []).map(item => item.supersedes.id));
      for (const revision of result.revisions || []) {
        if (!existing.some(entry => entry.id === revision.supersedes.id && entry.revision === revision.supersedes.revision)) {
          throw new DreamOutputError("修订引用了本次未提供的记忆或版本");
        }
        if (!revision.sourceIds.some(id => selected.messages.some(message => message.id === id))) continue;
        const saved = writer.revise(scope, { ...revision, sourceMessageId: revision.sourceIds[0],
          sources: revision.sourceIds.map(id => sourceMetadata(input.messages.find(message => message.id === id))) }, "dream");
        if (saved.memory) change(scope, { memories: 1 }, `${saved.status === "needs_confirmation" ? "保留待确认修订" : "关联记忆修订"}：${saved.memory.id}`);
      }
      for (const correction of result.invalidations) {
        if (revisionTargets.has(correction.id)) continue;
        const prior = existing.find(m => m.id === correction.id && m.revision === correction.revision);
        if (!prior) throw new DreamOutputError("纠错引用了本次未提供的记忆");
        const author = prior.subjectId || prior.createdByUserId;
        if (author && correction.evidence.some(e => input.messages.some(m => m.id === e.id && m.senderId === author && m.role === "member"))) {
          if (memories.invalidateFact(scope, correction.id, correction.revision, correction.evidence)) change(scope, { invalidated: 1 }, `根据纠正证据撤销记忆：${correction.id}`);
        }
      }
      for (const fact of result.facts) {
        if ((result.revisions || []).some(revision => revision.content === fact.content
          || revision.fact && fact.fact && factKey(revision.fact) === factKey(fact.fact))) continue;
        if (!fact.sourceIds.some(id => selected.messages.some(m => m.id === id))) continue;
        if (memories.excluded(scope, fact.content, fact.sourceIds)) continue;
        const id = `dream-${hash(JSON.stringify([fact.content, fact.sourceIds.slice().sort()])).slice(0, 32)}`;
        const source = input.messages.find(m => m.id === fact.sourceIds[0]);
        const entry = { ...fact, id, createdAt: now(), sourceMessageId: fact.sourceIds[0],
          sources: fact.sourceIds.map(id => sourceMetadata(input.messages.find(m => m.id === id))),
          createdByUserId: source.senderId, createdByUserName: source.senderName,
          origin: "dream", sourceRevoked: false, invalidatedAt: 0, retention: "short_term", expiresAt: 0 };
        const saved = writer.propose(scope, entry, "dream");
        if (saved.status === "created") change(scope, { memories: 1 }, `新增记忆：${entry.content}`);
      }
      const topics = result.topics.filter(t => !t.sourceIds.some(id => memories.excluded(scope, "", [id])));
      for (const topic of topics) repository.putTopic(scope, topic);
      change(scope, { materials: selected.messages.length, topics: topics.length });
      commitRecords(scope, result.records);
      const pending = [...(live.pending || []), ...topics.filter(t => t.status === "open")]
        .filter(t => state.job.cutoff - t.to < 7 * 86_400_000
          && !topics.some(done => done.status === "closed" && done.title === t.title));
      const unique = [...new Map(pending.map(t => [t.title, t])).values()].slice(-8);
      let style = live.style, styleVersion = live.styleVersion;
      if (require("./channel-dream-settings.cjs").isPrivateDreamScope(scope) && result.style && !live.styleLocked && live.styleVersion === state.styleVersion
        && !result.style.evidence.some(e => memories.excluded(scope, "", [e.id]))) {
        const sources = result.style.evidence.map(e => input.messages.find(m => m.id === e.id)).filter(m => m?.role === "member");
        const required = /(?:^|:)group:/.test(scope.chatId) ? 2 : 1;
        if (new Set(sources.map(m => m.senderId).filter(Boolean)).size >= required
          && JSON.stringify(result.style.values) !== JSON.stringify(style?.values)) {
          style = { ...result.style, updatedAt: now() }; styleVersion += 1;
          change(scope, { style: 1 }, `调整本聊天的交流偏好：${JSON.stringify(style.values)}`);
        }
      }
      return repository.saveState(scope, { ...live, job: { ...live.job, analysis: null }, cursor: selected.cursor, offset: selected.offset,
        pending: unique, tail: selected.messages.slice(-3).map(m => m.id),
        style, styleVersion, error: "", chunkChars: 12000 });
    });
  }
  async function assess(scope, state) {
    const turn = memories.pendingAssessments(scope, 1, state.job.upper, state.job.cutoff)[0];
    if (!turn) return false;
    const answer = await readAnswer(scope, turn);
    const question = repository.source(scope, turn.sourceMessageId, state.job.upper, state.job.cutoff);
    // Missing/deleted/edited answers cannot earn credit; retry only with new evidence.
    if (typeof answer !== "string" || hash(answer) !== turn.answerHash || !allowed(scope, question, state.job.cutoff)
      || !turn.candidates.length) {
      memories.completeAssessment(scope, turn.turnId, state.job.upper);
      return true;
    }
    const after = Math.max(question.seq, turn.assessedSeq || 0);
    const candidateOffset = turn.candidateOffset || 0;
    const candidates = turn.candidates.slice(candidateOffset, candidateOffset + 20);
    const previousOutcomes = (turn.previousOutcomes || []).filter(o => candidates.some(m => m.id === o.id && m.revision === o.revision));
    const rows = repository.page(scope, after, state.job.upper, 20);
    const scanned = rows.length === 20 ? rows.at(-1).seq : state.job.upper;
    // Every intervening page is visited. Keep prior decision evidence available,
    // otherwise a later empty page could accidentally undo an earlier correction.
    const previousRefs = [...new Set(previousOutcomes.flatMap(o => o.evidenceRefs))];
    const oldEvidence = previousRefs.filter(id => id !== turn.answerMessageId)
      .map(id => repository.source(scope, id, state.job.upper, state.job.cutoff)).filter(e => allowed(scope, e, state.job.cutoff));
    const nearby = [...new Map([project(question, 0, 4000),
      ...oldEvidence.map(e => project(e, 0, 1000)),
      ...rows.filter(e => allowed(scope, e, state.job.cutoff)).map(e => project(e, 0, 1000))].map(e => [e.id, e])).values()];
    const result = parseResult(await call(scope, ASSESS_PROMPT, {
      answerId: turn.answerMessageId, answer: answer.slice(0, 12000),
      candidates: candidates.map(m => ({ id: m.id, revision: m.revision, content: m.content })),
      previousOutcomes, evidence: nearby, answerTruncated: answer.length > 12000,
    }));
    if (!Array.isArray(result.outcomes) || result.outcomes.length !== candidates.length) throw new DreamOutputError("记忆评估不完整");
    const seen = new Set(), usedContents = new Set((turn.previousOutcomes || [])
      .filter(o => o.outcome === "used" && !candidates.some(m => m.id === o.id && m.revision === o.revision))
      .map(o => turn.candidates.find(m => m.id === o.id && m.revision === o.revision)?.content).filter(Boolean));
    const refs = new Set([turn.answerMessageId, ...nearby.map(e => e.id)]);
    for (const outcome of result.outcomes) {
      const candidate = candidates.find(m => m.id === outcome.id && m.revision === outcome.revision);
      if (!candidate || seen.has(outcome.id) || !["used", "not_used", "retrieval_error", "misapplied", "contradicted", "uncertain"].includes(outcome.outcome)
        || !Array.isArray(outcome.evidenceRefs) || outcome.evidenceRefs.length > 10
        || outcome.evidenceRefs.some(ref => !refs.has(ref))) throw new DreamOutputError("记忆评估证据不匹配");
      seen.add(outcome.id);
      if (outcome.outcome === "not_used" && !outcome.evidenceRefs.length) outcome.evidenceRefs = [turn.answerMessageId];
      if (outcome.outcome === "used") {
        if (!outcome.evidenceRefs.includes(turn.answerMessageId) || answer.length > 12000) outcome.outcome = "uncertain";
        else if (usedContents.has(candidate.content)) outcome.outcome = "not_used";
        else usedContents.add(candidate.content);
      }
      if (["retrieval_error", "misapplied", "contradicted"].includes(outcome.outcome)
        && !outcome.evidenceRefs.some(ref => ref !== turn.answerMessageId)) outcome.outcome = "uncertain";
    }
    commit(scope, () => {
      memories.applyDreamAssessment(scope, turn.turnId, result.outcomes.filter(o => o.outcome !== "uncertain"));
      change(scope, { assessments: result.outcomes.length }, `记忆使用评估：${JSON.stringify(result.outcomes)}`);
      if (candidateOffset + candidates.length < turn.candidates.length) {
        memories.advanceAssessmentCandidates(scope, turn.turnId, candidateOffset + candidates.length);
      } else memories.completeAssessment(scope, turn.turnId, scanned);
    });
    return true;
  }
  async function runScope(scope, trigger) {
    commit(scope, () => {
      for (const entry of memories.list(scope, { includeExpired: true })) {
        if (!require("./channel-dream-settings.cjs").isPrivateDreamScope(scope) && entry.origin === "dream" && entry.kind !== "fact" && !entry.factPolicyReviewed) {
          memories.save(scope, { ...entry, invalidatedAt: now(), sourceRevoked: true, factPolicyReviewed: true }, entry.revision);
          change(scope, { invalidated: 1 }, `撤销不再适用的记忆：${entry.id}`);
          repository.requeueSources(scope, entry.sourceIds || [entry.sourceMessageId]);
          continue;
        }
        if ((entry.expiresAt && entry.expiresAt <= now())
          || (!entry.pinned && entry.invalidatedAt && now() - entry.invalidatedAt > 30 * 86_400_000)) {
          memories.remove(scope, entry.id);
          change(scope, { removed: 1 }, `清理已到期或长期失效的记忆：${entry.id}`);
          repository.removeDerived(scope, entry.sourceIds || [entry.sourceMessageId]);
        }
      }
    });
    let state = repository.begin(scope, trigger), calls = 0;
    callLimit = analysisSerial + maxCalls;
    try {
      while (calls < maxCalls) {
        controller.signal.throwIfAborted();
        if (!eligible(scope) || isBusy(scope)) break;
        const more = repository.page(scope, state.cursor, state.job.upper, 1).length > 0;
        if (more) {
          calls += 1;
          try { state = await extract(scope, state, state.chunkChars || 12000); await onRecords(scope); }
          catch (error) {
            if (!(error instanceof DreamOutputError) || (state.chunkChars || 12000) <= 500) throw error;
            if (state.job.runId) repository.runs?.trace(scope, state.job.runId, "dream_rejected", { text: `${error.message}；本次返回未保存，缩小资料范围后继续` });
            state = repository.saveState(scope, { ...repository.state(scope), chunkChars: Math.floor((state.chunkChars || 12000) / 2) });
          }
          continue;
        }
        if (!state.job.reflectionDone) {
          const reflected = await coordinator.reflect(scope, state);
          state = commit(scope, () => {
            commitRecords(scope, reflected);
            const live = repository.state(scope);
            return repository.saveState(scope, { ...live, job: { ...live.job, reflectionDone: true } });
          });
          await onRecords(scope);
        }
        calls += 1;
        if (await assess(scope, state)) continue;
        // Scores change only with assessed use or correction, never elapsed time.
        await onRecords(scope);
        state = repository.transaction(() => {
          const result = repository.saveState(scope, { ...repository.state(scope), job: null, error: "", failures: 0,
            lastRun: now(), lastTrigger: state.job.trigger || "scheduled",
            nextRun: state.job.trigger === "idle" && state.job.scheduledFor > 0 ? state.job.scheduledFor : nextRun(state.settings, now()),
            lastCutoff: state.job.cutoff });
          if (state.job.runId) repository.runs?.finish(scope, state.job.runId, "completed");
          return result;
        });
        return state;
      }
      return repository.saveState(scope, { ...repository.state(scope), nextRun: now() + 60_000 });
    } catch (error) {
      state = repository.state(scope);
      if (error.code === "DREAM_YIELD") return repository.saveState(scope, { ...state, nextRun: now() + 60_000 });
      const failures = (state.failures || 0) + 1;
      repository.saveState(scope, { ...state, failures, error: String(error.message || error).slice(0, 300),
        nextRun: now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(6, failures - 1)) });
      throw error;
    }
  }
  function run(scope, trigger = "manual") {
    if (paused) return Promise.reject(new Error("正在整理数据，梦境已暂停"));
    if (running) return Promise.reject(new Error("已有记忆整理正在进行"));
    if (!eligible(scope) || !repository.state(scope).settings.enabled) return Promise.reject(new Error("当前聊天已停用整理"));
    controller = new AbortController();
    runningScope = scope;
    running = Promise.resolve().then(async () => {
      migrate(scope);
      await documents?.prepare(scope);
      const state = repository.begin(scope, trigger);
      const id = repository.runs?.start(scope, state.job);
      if (id && !state.job.runId) repository.runs.enableRollback(scope, id);
      if (id) repository.saveState(scope, { ...state, job: { ...state.job, runId: id } });
      try {
        const result = await runScope(scope, trigger);
        if (id && result.job) repository.runs.finish(scope, id, "suspended");
        return result;
      } catch (error) {
        if (id) repository.runs.finish(scope, id, controller.signal.aborted || isBusy(scope) ? "interrupted" : "failed", String(error.message || error).slice(0, 1000));
        throw error;
      }
    }).finally(() => { running = null; runningScope = null; controller = null; callLimit = Infinity; });
    return running;
  }
  async function tickOnce() {
    if (paused || running) return;
    await documents?.recover();
    if (paused) return;
    const scopes = repository.scopes().filter(scope => eligible(scope) && repository.state(scope).settings.enabled)
      .sort((a, b) => repository.state(a).nextRun - repository.state(b).nextRun);
    for (const scope of scopes) {
      const state = repository.state(scope);
      if (!state.nextRun && !state.job) repository.saveState(scope, { ...state, nextRun: nextRun(state.settings, now()) });
    }
    const due = scopes.flatMap(scope => {
      const state = repository.state(scope);
      if (isBusy(scope)) return [];
      if (state.nextRun <= now()) return [{ scope, trigger: state.job?.trigger || "scheduled", at: state.nextRun }];
      const activity = repository.activity?.(scope);
      const idleAt = activity?.at + state.settings.idleMinutes * 60000;
      return !state.job && state.settings.idleMinutes > 0 && activity?.seq > state.cursor && idleAt <= now()
        ? [{ scope, trigger: "idle", at: idleAt }] : [];
    }).sort((a, b) => a.at - b.at);
    for (const { scope, trigger } of due.slice(0, 50)) {
      if (paused || running) break;
      if (isBusy(scope)) continue;
      const before = analysisSerial;
      await run(scope, trigger);
      if (analysisSerial !== before) break;
    }
  }
  function tick() {
    if (paused) return Promise.resolve();
    return ticking || (ticking = tickOnce().finally(() => { ticking = null; }));
  }
  async function pause() {
    paused = true;
    if (timer) clearInterval(timer);
    timer = null; controller?.abort(new Error("正在整理数据，稍后继续梦境"));
    await Promise.allSettled([running, ticking].filter(Boolean));
  }
  return {
    run, tick, pause,
    isRunning: scope => runningScope?.channelId === scope.channelId && runningScope?.chatId === scope.chatId,
    async cancel(scope) {
      if (runningScope?.channelId !== scope.channelId || runningScope?.chatId !== scope.chatId) return;
      controller?.abort(new Error("主人已暂停本聊天的 Dream"));
      await Promise.allSettled([running].filter(Boolean));
    },
    start() {
      if (timer) return;
      paused = false;
      timer = setInterval(() => { tick().catch(error => console.warn("[dream]", error.message)); }, 60_000);
      timer.unref?.();
    },
    stop: pause,
    get busy() { return !!running; },
  };
}

module.exports = { createChannelDreamService, usable };
