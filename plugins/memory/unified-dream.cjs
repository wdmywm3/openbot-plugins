"use strict";
const { randomUUID } = require("node:crypto");
const { get, put, state, save, catalog, readMemory, hash } = require("./unified-state.cjs");
const { parseResult, validateExtraction, nextRun } = require("./lib/features/channels/channel-dream-analysis.cjs");
const { isPrivateDreamScope } = require("./lib/features/channels/channel-dream-settings.cjs");
const running = new Map();
const materialPolicy = require("./unified-material-policy.cjs");
const containsSecret = value => /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----|\b(?:sk|sess)-[A-Za-z0-9_-]{20,}|(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*["']?[^\s"']{12,}/i.test(String(value));
const reviewPolicy = require("./unified-review-policy.cjs");
function proof(items, materials) {
  if (!Array.isArray(items) || !items.length || items.length > 10) throw Error("整理结果缺少原文依据");
  return items.map(item => {
    const source = materials.find(entry => entry.id === item?.id && typeof item.quote === "string" && item.quote.trim() && item.quote.length <= 1000 && entry.content.includes(item.quote));
    if (!source) throw Error("整理结果引用了未读或不匹配的原文");
    return { chatId: source.chatId, id: source.id, version: source.version, quote: item.quote };
  });
}
function recordFields(item, materials, privateChat, { scope, previous } = {}) {
  if (!item || !["experience", "matter"].includes(item.kind) || !privateChat && item.kind !== "experience"
    || typeof item.content !== "string" || !item.content.trim() || item.content.length > 16000 || containsSecret(item.content)) throw Error("经历或事项格式无效");
  if (item.kind === "matter" && !["goal", "question", "followup"].includes(item.subtype)) throw Error("事项子类型无效");
  const sources = proof(item.evidence, materials);
  if (item.kind === "matter" && !reviewPolicy.peerEvidence(sources, materials, scope)) throw Error("事项需要当前私聊对话方的原消息依据");
  if (item.kind === "experience" && sources.some(ref => materials.find(entry => entry.id === ref.id)?.source === "task_report")
    && !/报告/.test(item.content)) throw Error("任务报告不能改写成亲自观察的经历");
  if (item.kind === "matter" && item.progress !== undefined && !["active", "waiting", "completed", "canceled", "closed"].includes(item.progress)) throw Error("事项进度无效");
  if (item.kind !== "matter" && reviewPolicy.changed(item)) throw Error("经历不能安排自动复查");
  const attributes = reviewPolicy.attributes(item, previous?.attributes);
  if (reviewPolicy.changed(item)) {
    if (item.subtype !== "followup" && reviewPolicy.KEYS.some(key => attributes[key])) throw Error("自动复查需要 followup 事项");
    if (!reviewPolicy.peerEvidence(proof(item.reviewEvidence || item.evidence, materials), materials, scope)) throw Error("复查设置需要当前私聊对话方的明确原消息依据");
  }
  return { content: item.content, kind: item.kind, ...(item.kind === "matter" ? { subtype: item.subtype,
    progress: item.progress || "active", ...(scope?.chatId ? { subjectRefs: [scope.chatId.split(":private:")[1]] } : {}) } : {}),
    status: "active", tier: "working", sources, attributes };
}
async function analyze(ctx, storage, scope, messages, existing, upper, trace) {
  const materials = messages.map(item => ({ ...item, chatId: scope.chatId, senderId: item.sender?.id || "" }));
  const { system, context } = require("./unified-dream-prompts.cjs").build(ctx, storage, scope);
  let prompt = JSON.stringify({ context, messages: materials, existing: existing.slice(0, 60) });
  const history = [];
  for (let round = 0; round < 12; round++) {
    ctx.signal.throwIfAborted();
    trace("dream_input", { text: prompt, contextText: system });
    const response = await ctx.api.generate({ prompt, systemPrompt: system, messages: history, maxTokens: 6000 });
    trace("dream_output", { text: response.text, modelId: response.modelId });
    const parsed = parseResult(response.text);
    if (!parsed.readMaterial) return { parsed, materials };
    const request = parsed.readMaterial;
    if (!messages.some(item => item.id === request.id) || !Number.isSafeInteger(request.offset) || request.offset < 0) throw Error("补读请求不属于本批资料");
    const result = await ctx.api.sources({ action: "read", chatId: scope.chatId, id: request.id, upper, offset: request.offset,
      limit: Math.min(6000, Math.max(1, Number(request.limit) || 6000)) });
    if (!result.item || !materialPolicy.admit(result.item)) throw Error("补读资料已不可用于整理");
    materials.push({ ...result.item, chatId: scope.chatId, senderId: result.item.sender?.id || "" });
    history.push({ role: "user", content: prompt }, { role: "assistant", content: response.text });
    prompt = JSON.stringify({ material: result.item });
  }
  throw Error("补读次数已达上限，保留检查点后继续");
}
async function plan(ctx, scope, parsed, materials, existing) {
  const result = validateExtraction(parsed, materials, containsSecret), privateChat = isPrivateDreamScope(scope);
  const operations = [], before = [], known = new Map(existing.map(item => [item.id, item]));
  const full = [];
  for (const item of existing) {
    const record = await readMemory(ctx, scope, item.id); if (record) full.push(record);
  }
  const reserved = new Set([...result.revisions.map(item => item.supersedes.id), ...result.invalidations.map(item => item.id), ...(parsed.updates || []).map(item => item.id)]);
  const add = require("./unified-candidates.cjs").candidates(full, operations, before, reserved);
  const validateWatch = async record => {
    const id = record.attributes.watchActivityId; if (!id) return;
    if (!ctx.api.activities) throw Error("当前宿主不支持工作事项订阅");
    await ctx.api.activities({ action: "read", chatId: scope.chatId, id });
  };
  for (const item of result.facts) {
    if (!privateChat && item.kind === "preference") continue;
    const sources = proof(item.evidence, materials);
    if (!materialPolicy.factsAllowed(sources, materials)) continue;
    if (item.kind === "preference" && !reviewPolicy.peerEvidence(sources, materials, scope)) continue;
    const subjectId = item.subjectId || (item.kind === "preference" ? scope.chatId.split(":private:")[1] : "");
    if (item.kind === "preference" && subjectId !== scope.chatId.split(":private:")[1]) continue;
    if (item.kind === "preference" && item.fact && item.fact.subjectId !== subjectId) continue;
    add({ content: item.content, kind: item.kind, tier: "working", status: "active",
      subjectRefs: subjectId ? [subjectId] : [], conditions: item.fact?.conditions || [], sources,
      validFrom: item.validFrom || null, validTo: item.validTo || null, attributes: item.fact ? { fact: item.fact } : {} });
  }
  for (const item of result.revisions) {
    const old = known.get(item.supersedes.id);
    if (!old || old.revision !== item.supersedes.revision) throw Error("修订目标版本不在本次读取范围");
    const sources = item.reviewStatus === "pending" && !item.evidence?.length ? [] : proof(item.evidence, materials);
    if (["fact", "preference"].includes(old.kind) && sources.length && !materialPolicy.factsAllowed(sources, materials)) continue;
    if (old.kind === "preference" && (!privateChat || !reviewPolicy.peerEvidence(sources, materials, scope)
      || item.fact && item.fact.subjectId !== scope.chatId.split(":private:")[1])) continue;
    if (item.reviewStatus === "pending") {
      operations.push({ action: "create", record: { content: item.content, kind: old.kind, status: "pending", tier: old.tier,
        sources, attributes: { suggestedRevisionOf: { id: old.id, revision: old.revision }, changeType: item.changeType } } }); before.push(null); continue;
    }
    operations.push({ action: "revise", id: old.id, expectedRevision: old.revision, changeType: item.changeType,
      patch: { content: item.content, sources, validFrom: item.validFrom || null, validTo: item.validTo || null,
        ...(item.fact ? { conditions: item.fact.conditions || [], attributes: { fact: item.fact } } : {}) } }); before.push({ id: old.id, revision: old.revision });
  }
  for (const item of result.invalidations) {
    const old = known.get(item.id); if (!old || old.revision !== item.revision) throw Error("失效目标版本已变化");
    const sources = proof(item.evidence, materials);
    if (["fact", "preference"].includes(old.kind) && !materialPolicy.factsAllowed(sources, materials)) continue;
    if (old.kind === "preference" && (!privateChat || !reviewPolicy.peerEvidence(sources, materials, scope))) continue;
    operations.push({ action: "transition", id: old.id, expectedRevision: old.revision, reason: "原始资料明确纠正", patch: { status: "invalidated" } }); before.push({ id: old.id, revision: old.revision });
  }
  if (parsed.records != null && (!Array.isArray(parsed.records) || parsed.records.length > 20)) throw Error("经历或事项条目过多");
  for (const item of parsed.records || []) {
    if (!privateChat && item.kind === "matter") continue;
    const record = recordFields(item, materials, privateChat, { scope });
    if (item.relatedIds != null && (!Array.isArray(item.relatedIds) || item.relatedIds.length > 20 || item.relatedIds.some(id => typeof id !== "string" || !known.has(id)))) throw Error("关联记忆不在本次读取范围");
    await validateWatch(record);
    add(record);
  }
  if (parsed.updates != null && (!Array.isArray(parsed.updates) || parsed.updates.length > 10)) throw Error("事项更新过多");
  for (const item of parsed.updates || []) {
    const old = known.get(item.id); if (!old || old.revision !== item.revision) throw Error("事项更新版本已变化");
    const actual = await readMemory(ctx, scope, old.id);
    if (!actual || actual.kind !== "matter") throw Error("事项不可自动接续");
    if (item.reopen !== undefined && typeof item.reopen !== "boolean") throw Error("事项重新开启标记无效");
    const reopening = reviewPolicy.terminal(actual.progress) && ["active", "waiting"].includes(item.progress);
    if (reopening && (item.reopen !== true || !reviewPolicy.peerEvidence(proof(item.evidence, materials), materials, scope))) throw Error("已结束事项需要本人明确重新开启");
    // A finished task's old subscription is never resurrected by reopening it.
    const previous = reopening ? { ...actual, attributes: reviewPolicy.attributes({ nextReviewAt: null }, actual.attributes) } : actual;
    const record = recordFields({ ...actual, ...item, kind: "matter" }, materials, privateChat, { scope, previous });
    await validateWatch(record);
    operations.push({ action: "revise", id: old.id, expectedRevision: old.revision, changeType: "edit",
      patch: { content: record.content, subtype: record.subtype, progress: record.progress, sources: record.sources, attributes: record.attributes } }); before.push({ id: old.id, revision: old.revision });
  }
  return { operations, before, style: privateChat && result.style && reviewPolicy.peerEvidence(proof(result.style.evidence, materials), materials, scope) ? result.style : null, topics: result.topics,
    links: (parsed.records || []).filter(item => privateChat || item.kind !== "matter").map(item => ({ content: item.content, relatedIds: item.relatedIds || [] })) };
}
async function commit(ctx, storage, scope, job) {
  ctx.signal.throwIfAborted();
  const settings = state(storage, scope);
  if (settings.paused || job.trigger !== "manual" && !settings.settings.enabled) throw Error("整理已暂停，保留检查点等待明确恢复");
  const prepared = get(storage, `plus:plan:${scope.chatId}`);
  if (!prepared || prepared.runId !== job.runId) throw Error("整理检查点缺失");
  const obsolete = new Set(["MEMORY_FORGOTTEN_SOURCE", "MEMORY_SOURCE", "MEMORY_CONFLICT", "MEMORY_NOT_FOUND"]);
  let result;
  if (!prepared.individual) try {
    result = prepared.operations.length ? await ctx.api.memory({ action: "batch", chatId: scope.chatId, operations: prepared.operations,
      requestKey: `dream:${job.runId}:${prepared.after}` }) : { ok: true, items: [] };
  } catch (error) {
    if (!obsolete.has(error.code)) throw error;
    // The rejected batch is atomic. Persist the fallback mode before individually admitting independent proposals.
    prepared.individual = true; put(storage, `plus:plan:${scope.chatId}`, prepared);
  }
  const skipped = [];
  if (prepared.individual) {
    result = { ok: true, items: [] };
    for (let index = 0; index < prepared.operations.length; index++) {
      ctx.signal.throwIfAborted();
      try { result.items.push(await ctx.api.memory({ ...prepared.operations[index], chatId: scope.chatId,
        requestKey: `dream-item:${hash(`${job.runId}:${prepared.after}:${index}`)}` })); }
      catch (error) { if (!obsolete.has(error.code)) throw error; result.items.push(null); skipped.push({ index, code: error.code }); }
    }
  }
  result.items = (result.items || []).map((item, index) => {
    if (item?.forgotten) { skipped.push({ index, code: "forgotten" }); return null; }
    if (item?.ok === false) throw Error("记忆提交回执无效");
    return item;
  });
  // A replayed batch reports ok=false when one of its already committed records was subsequently forgotten.
  // Reconcile the remaining receipts without recreating the forgotten item or retrying the whole batch forever.
  if (!result.ok && !(result.replayed && skipped.some(item => item.code === "forgotten"))) throw Error("这批记录未能提交");
  for (const link of prepared.links || []) {
    const index = prepared.operations.findIndex(operation => operation.action === "create" && operation.record.content === link.content);
    if (index < 0 || !result.items[index]) continue;
    let current = result.items[index];
    for (const targetId of link.relatedIds) try { current = await ctx.api.memory({ action: "relate", chatId: scope.chatId, id: current.id,
      expectedRevision: current.revision, targetId, kind: "related", requestKey: `dream-link:${hash(`${job.runId}:${prepared.after}:${index}:${targetId}`)}` }); }
    catch (error) { if (!obsolete.has(error.code)) throw error; skipped.push({ index, targetId, code: error.code }); }
    result.items[index] = current;
  }
  ctx.signal.throwIfAborted();
  storage.db.exec("SAVEPOINT plus_commit");
  try {
  const auditKey = `plus:undo:${scope.chatId}:${job.runId}`;
  const audit = get(storage, auditKey, []);
  for (let i = 0; i < result.items.length; i++) {
    const item = result.items[i];
    if (!item) continue;
    if (!audit.some(old => old.id === item.id && old.afterRevision === item.revision)) audit.push({ id: item.id, afterRevision: item.revision,
      beforeRevision: prepared.before[i]?.revision || null });
  }
  put(storage, auditKey, audit);
  const live = state(storage, scope);
  const pending = prepared.after < job.upper;
  save(storage, scope, { cursor: prepared.after, checkpointAt: Date.now(), job: pending ? { ...job, prepared: false } : null,
    ...(!pending ? { lastRun: Date.now(), nextRun: nextRun(live.settings, Date.now()) } : {}), error: "", failures: 0,
    ...(prepared.style && !live.styleLocked ? { style: { ...prepared.style, updatedAt: Date.now() } } : {}) });
  put(storage, `plus:topics:${scope.chatId}`, prepared.topics);
  const savedCount = result.items.filter(Boolean).length;
  storage.dreamRepository.runs.change(scope, job.runId, { memories: savedCount }, "通过宿主接口提交记忆变更");
  if (skipped.length) storage.dreamRepository.runs.trace(scope, job.runId, "proposals_skipped", { text: JSON.stringify(skipped) });
  if (!pending) storage.dreamRepository.runs.finish(scope, job.runId, "completed");
  // Never keep a second mutable copy of committed memory bodies in a strategy checkpoint.
  storage.db.prepare("DELETE FROM plugin_meta WHERE key=?").run(`plus:plan:${scope.chatId}`);
  storage.db.exec("RELEASE plus_commit");
  return { completed: !pending, pending, saved: savedCount, skipped: skipped.length, runId: job.runId };
  } catch (error) { storage.db.exec("ROLLBACK TO plus_commit; RELEASE plus_commit"); throw error; }
}
async function batch(ctx, storage, scope, trigger) {
    let live = state(storage, scope), job = live.job;
    try {
    if (job?.prepared) return await commit(ctx, storage, scope, job);
    const page = await ctx.api.sources({ action: "changes", chatId: scope.chatId, after: live.cursor || 0,
      ...(job?.upper != null ? { upper: job.upper } : {}), limit: job?.limit || 12 });
    if (!page.items.length) {
      if (job?.runId) storage.dreamRepository.runs.finish(scope, job.runId, "completed");
      save(storage, scope, { cursor: Math.max(live.cursor || 0, Number.isSafeInteger(page.upper) ? page.upper : 0),
        checkpointAt: Date.now(), lastRun: Date.now(), job: null, nextRun: nextRun(live.settings, Date.now()) });
      return { completed: true, saved: 0, idle: true };
    }
    const after = page.items.at(-1).seq;
    const messages = page.items.filter(materialPolicy.admit);
    job ||= { runId: randomUUID(), trigger, cutoff: Date.now(), upper: page.upper, limit: 12 };
    job.runId = storage.dreamRepository.runs.start(scope, job); save(storage, scope, { job });
      const all = await catalog(ctx, scope);
      const query = messages.map(item => item.content || "").filter(Boolean).join("\n").slice(-4000);
      const related = query ? await require("./unified-retrieval.cjs").search(ctx, storage, scope, query, 40, { raw: true }) : { records: [] };
      const candidates = new Map(related.records.map(item => [item.id, item]));
      for (const item of all) if (!candidates.has(item.id)) candidates.set(item.id, item);
      const existing = [...candidates.values()].slice(0, 60);
      const prepared = messages.length ? await (async () => {
        const response = await analyze(ctx, storage, scope, messages, existing, job.upper,
          (kind, payload) => storage.dreamRepository.runs.trace(scope, job.runId, kind, payload));
        return plan(ctx, scope, response.parsed, response.materials, existing);
      })() : { operations: [], before: [], topics: [], style: null };
      put(storage, `plus:plan:${scope.chatId}`, { ...prepared, runId: job.runId, after });
      save(storage, scope, { job: { ...job, prepared: true } });
      return await commit(ctx, storage, scope, job);
    } catch (error) {
      live = state(storage, scope);
      const failures = (live.failures || 0) + 1;
      save(storage, scope, { error: String(error.message || error), failures, retryAt: Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(failures, 6)),
        job: live.job?.prepared ? live.job : job ? { ...job, limit: Math.max(1, Math.floor((job.limit || 12) / 2)) } : null });
      if (job?.runId) storage.dreamRepository.runs.finish(scope, job.runId, "failed", String(error.message || error)); throw error;
    }
}
async function run(ctx, storage, scope, trigger = "manual") {
  const key = `${storage.root}:${scope.chatId}`;
  if (running.has(key)) throw Error("当前聊天正在整理");
  const task = (async () => {
    let result, saved = 0, skipped = 0;
    // One bounded job drains up to four pages, retaining its fixed upper watermark.
    for (let page = 0; page < 4; page++) {
      ctx.signal.throwIfAborted();
      result = await batch(ctx, storage, scope, trigger); saved += result.saved || 0; skipped += result.skipped || 0;
      if (!result.pending) break;
      if (state(storage, scope).paused) break;
    }
    return { ...result, saved, skipped };
  })();
  running.set(key, task);
  try { return await task; } finally { running.delete(key); }
}
module.exports = { run, running, plan, recordFields, containsSecret };
