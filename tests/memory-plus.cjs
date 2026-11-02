"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const { createUnifiedMemoryRepository } = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs"));
const runtime = require("../plugins/memory/unified-runtime.cjs"), followups = require("../plugins/memory/unified-followup.cjs");
const { current, save, get, put } = require("../plugins/memory/unified-state.cjs"), { close } = require("../plugins/memory/storage.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-plus-")), db = new DatabaseSync(path.join(root, "host.sqlite"));
const chatId = "onebot:private:owner", scope = { channelId: "bot", chatId };
const actor = { ...scope, id: "plugin:memory", permissions: ["read", "write", "manage", "forget"].map(name => `memory:${name}`) };
const source = { id: "m1", seq: 1, chatId, version: "v1", observedAt: Date.now(), createdAt: Date.now(), content: "我喜欢拿铁咖啡。浏览任务已经完成比较。",
  direction: "in", source: "chat", sender: { id: "owner", name: "主人" }, hasMore: false };
const repo = createUnifiedMemoryRepository(db, { source: () => source });
const work = require(path.join(host, "electron/lib/context/conversation-activity-repository.cjs")).createConversationActivityRepository(db);
let generated = 0, published = 0, agentRuns = 0, failPublish = false, output;
const ctx = { dataRoot: path.join(root, "plugin"), plugin: { namespace: "bot" }, principal: { channelId: "bot", senderId: "owner" }, message: { id: "m1", chatId, content: "拿铁咖啡" },
  hook: { requestId: "turn-1", messages: [], inputMessages: [] }, config: {}, input: { chatId }, signal: new AbortController().signal,
  api: {
    getCapabilities: async () => ({ features: { unifiedMemory: true, persistentContextItems: true, visibleContextItems: true, sourceHead: true }, dataRestoreId: "" }),
    avatars: async input => ({ avatar: work.declareAvatar(actor, input) }),
    activities: async input => input.action === "create" ? { activity: work.create(actor, input) } : input.action === "append" ? work.append(actor, input.id, input)
      : input.action === "read" ? { activity: work.requireActivity(actor, input.id) } : input.action === "history" ? { events: work.history(actor, input.id, input.after) }
      : { subscriptions: [] },
    memory: async ({ chatId: requested, ...input }) => repo.memory({ ...actor, chatId: requested || chatId }, input),
    sources: async input => input.action === "scopes" ? { scopes: [{ chatId }] } : input.action === "read" ? { item: { ...source, content: source.content.slice(input.offset || 0) } }
      : { items: (input.after || 0) < 1 ? [source] : [], upper: 1, nextCursor: null },
    generate: async input => { generated++; const request = JSON.parse(input.prompt); return { text: JSON.stringify(request.dimension === "usage"
      ? { outcomes: request.candidates.map(item => ({ id: item.id, revision: item.revision, outcome: "used", quote: "你喜欢拿铁。" })), maintenance: [] } : output), modelId: "fixture" }; },
    runAgent: async () => { agentRuns++; return { taskId: "followup-task", status: "completed", summary: "复查有新进展", data: { meaningfulChange: true, reply: "有一项新进展" } }; },
    publishConversationEvent: async () => { published++; if (failPublish) throw Error("offline"); return { id: "event-1", state: "pending" }; },
  } };
(async () => {
  try {
    await runtime.initialize(ctx);
    const { storage } = current(ctx);
    output = { facts: [{ kind: "preference", content: "主人喜欢拿铁咖啡", subjectId: "owner", evidence: [{ id: "m1", quote: "我喜欢拿铁咖啡。" }] }], topics: [], style: null,
      records: [{ kind: "experience", content: "浏览任务已经完成比较", evidence: [{ id: "m1", quote: "浏览任务已经完成比较。" }] }] };
    ctx.input = { chatId, dream: true };
    const done = await runtime.process(ctx); assert.equal(done.saved, 2); assert.equal(generated, 1);
    assert.equal(storage.db.prepare("SELECT count(*) AS n FROM channel_memories").get().n, 0, "no fact body is written back to legacy plugin storage");
    assert.equal(storage.db.prepare("SELECT count(*) AS n FROM channel_dream_records").get().n, 0);
    assert.equal(get(storage, `plus:plan:${chatId}`), null, "committed proposal body is removed from strategy checkpoint");
    const all = repo.memory(actor, { action: "search" }).items;
    assert.equal(all.length, 2); assert(all.some(item => item.kind === "experience"));
    const recalled = await runtime.beforeModel(ctx); assert(recalled.contextItems.some(item => all.some(record => record.id === item.memory?.id)));
    ctx.hook = { requestId: "turn-1", answerMessageId: "answer", text: "你喜欢拿铁。" }; await runtime.replyDelivered(ctx);
    const turn = get(storage, `plus:turn:${chatId}:turn-1`); assert.equal(turn.delivered, true); assert.equal(turn.used, undefined);
    await runtime.process(ctx); assert.equal(generated, 2, "actual delivered answer is evaluated once independently of Dream");
    assert.equal(get(storage, `plus:turn:${chatId}:turn-1`).assessed, true);
    await runtime.process(ctx); assert.equal(generated, 2, "no new material or unassessed answer means no empty model call");
    ctx.input = { chatId, action: "rollbackPreview", runId: done.runId }; const preview = await runtime.manage(ctx);
    ctx.input = { ...ctx.input, action: "rollback", token: preview.token }; await runtime.manage(ctx);
    assert.equal(repo.memory(actor, { action: "search" }).items.length, 0);
    assert.equal(repo.memory(actor, { action: "search", mode: "history" }).items.length, 2);

    const item = repo.memory(actor, { action: "create", requestKey: "followup", record: { content: "复查最新进展", kind: "matter", subtype: "followup", progress: "active", status: "active",
      attributes: { nextReviewAt: Date.now() - 1000 } } });
    const record = repo.memory(actor, { action: "read", id: item.id }).item;
    const fingerprint = require("../plugins/memory/storage.cjs").hash(JSON.stringify([record.id, record.revision, record.attributes.nextReviewAt]));
    save(storage, scope, { settingsOverride: { enabled: true } });
    put(storage, `plus:followup:${item.id}`, { fingerprint, attempt: 0 });
    ctx.input = { chatId, id: item.id, fingerprint, attempt: 0 };
    failPublish = true; await assert.rejects(followups.execute(ctx, storage, scope), /offline/);
    assert.equal(agentRuns, 1); assert(get(storage, `plus:followup:${item.id}`).receipt);
    failPublish = false; const completed = await followups.execute(ctx, storage, scope);
    assert.equal(completed.completed, true); assert.equal(agentRuns, 1, "notification retry does not repeat the completed research");
    assert.equal(published, 2); assert.equal(completed.eventId, "event-1");
    await followups.execute(ctx, storage, scope); assert.equal(published, 2);
    const quick = repo.memory(actor, { action: "create", requestKey: "quick-followup", record: { content: "快速复查", kind: "matter", subtype: "followup", progress: "active", status: "active", attributes: { nextReviewAt: Date.now() - 1000 } } });
    let starts = 0;
    ctx.api.jobs = async input => {
      if (input.action === "start") { starts++; await followups.execute({ ...ctx, input: input.input }, storage, scope); return { id: `quick-job-${starts}` }; }
      return { status: "completed", result: { completed: true } };
    };
    const quickRecord = repo.memory(actor, { action: "read", id: quick.id }).item;
    await followups.admit(ctx, storage, scope, quickRecord);
    assert.equal(get(storage, `plus:followup:${quick.id}`).completed, true, "fast completion before jobs.start returns must not be overwritten by admission");
    put(storage, `plus:followup:${quick.id}`, { ...get(storage, `plus:followup:${quick.id}`), paused: true });
    repo.memory(actor, { action: "revise", id: quick.id, expectedRevision: quick.revision, requestKey: "paused-edit", changeType: "edit", patch: { content: "改写暂停中的复查" } });
    const startsBefore = starts;
    await followups.admit(ctx, storage, scope, repo.memory(actor, { action: "read", id: quick.id }).item);
    assert.equal(starts, startsBefore, "editing a record cannot silently clear its restored/manual pause");
    assert.equal(get(storage, `plus:followup:${quick.id}`).paused, true);

    const delayed = repo.memory(actor, { action: "create", requestKey: "late-followup", record: { content: "等待模型的复查", kind: "matter", subtype: "followup", progress: "active", status: "active", attributes: { nextReviewAt: Date.now() - 1000 } } });
    ctx.api.jobs = async () => ({ id: `queued-${++starts}` });
    await followups.admit(ctx, storage, scope, repo.memory(actor, { action: "read", id: delayed.id }).item);
    const oldAttempt = get(storage, `plus:followup:${delayed.id}`), originalAgent = ctx.api.runAgent;
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    ctx.api.runAgent = async () => { entered.resolve(); return release.promise; };
    const oldExecution = followups.execute({ ...ctx, input: { id: delayed.id, fingerprint: oldAttempt.fingerprint, attempt: oldAttempt.attempt } }, storage, scope);
    await entered.promise;
    repo.memory(actor, { action: "revise", id: delayed.id, expectedRevision: delayed.revision, requestKey: "new-followup-input", changeType: "edit", patch: { content: "新的复查目标" } });
    await followups.admit(ctx, storage, scope, repo.memory(actor, { action: "read", id: delayed.id }).item);
    const newAttempt = get(storage, `plus:followup:${delayed.id}`);
    release.resolve({ taskId: "old-research", status: "completed", summary: "旧目标的结果", data: { meaningfulChange: true, reply: "不能通知的旧结果" } });
    assert.equal((await oldExecution).skipped, true);
    assert.deepEqual(get(storage, `plus:followup:${delayed.id}`), newAttempt, "late research cannot populate or overwrite a new revision's checkpoint");
    ctx.api.runAgent = originalAgent;
    repo.memory({ ...actor, explicitForget: true }, { action: "forget", id: item.id, expectedRevision: item.revision, requestKey: "forget-followup-parent", reason: "遗忘这个事项" });
    assert.throws(() => repo.memory(actor, { action: "read", id: completed.memoryId }), error => error.code === "MEMORY_NOT_FOUND", "a derived research report cannot remain readable after its parent is forgotten");
    const discarded = repo.memory(actor, { action: "create", requestKey: "forget-plan-source", record: { content: "不要再次提炼这段内容", status: "active" } });
    repo.memory({ ...actor, explicitForget: true }, { action: "forget", id: discarded.id, expectedRevision: discarded.revision, reason: "用户遗忘", requestKey: "forget-plan" });
    const runId = storage.dreamRepository.runs.start(scope, { trigger: "manual", cutoff: Date.now(), upper: 1 });
    put(storage, `plus:plan:${chatId}`, { runId, after: 1, operations: [
      { action: "create", record: { content: "不要再次提炼这段内容", status: "active" } },
      { action: "create", record: { content: "另一条仍然有效的提案", status: "active" } },
    ], before: [null, null], links: [], topics: [], style: null });
    save(storage, scope, { job: { runId, trigger: "manual", prepared: true, limit: 12 } });
    const memory = ctx.api.memory; let lost = false;
    ctx.api.memory = async input => { const value = await memory(input); if (input.action === "create" && input.record.content === "另一条仍然有效的提案" && !lost) { lost = true; throw Error("response lost"); } return value; };
    ctx.input = { dream: true, trigger: "manual" };
    await assert.rejects(runtime.process(ctx), /response lost/);
    assert.equal(get(storage, `plus:plan:${chatId}`).individual, true);
    const resumed = await runtime.process(ctx); assert.equal(resumed.saved, 1); assert.equal(resumed.skipped, 1);
    assert.equal(repo.memory(actor, { action: "search", query: "另一条仍然有效的提案" }).items.length, 1, "individual retry reuses the accepted receipt");
    assert.equal(repo.memory(actor, { action: "search", query: "不要再次提炼" }).items.length, 0);
    const replayRun = storage.dreamRepository.runs.start(scope, { trigger: "manual", cutoff: Date.now(), upper: 1 });
    const replayOperations = ["提交后遗忘的提案", "提交后保留的提案"].map(content => ({ action: "create", record: { content, status: "active" } }));
    put(storage, `plus:plan:${chatId}`, { runId: replayRun, after: 1, operations: replayOperations, before: [null, null], links: [], topics: [], style: null });
    save(storage, scope, { job: { runId: replayRun, trigger: "manual", prepared: true, limit: 12 } });
    const committed = await ctx.api.memory({ action: "batch", chatId, operations: replayOperations, requestKey: `dream:${replayRun}:1` });
    repo.memory({ ...actor, explicitForget: true }, { action: "forget", id: committed.items[0].id, expectedRevision: 1, requestKey: "forget-after-batch", reason: "用户遗忘" });
    const replayed = await runtime.process(ctx);
    assert.equal(replayed.saved, 1); assert.equal(replayed.skipped, 1);
    assert.equal(get(storage, `plus:plan:${chatId}`), null, "a committed batch with a later forgotten item still reconciles its checkpoint");
    repo.memory(actor, { action: "create", requestKey: "paused-global-followup", record: { content: "停止后不应启动的复查", kind: "matter", subtype: "followup", progress: "active", status: "active", attributes: { nextReviewAt: Date.now() - 1000 } } });
    const queuedActions = [];
    ctx.api.jobs = async input => {
      if (input.action === "list") return { jobs: [{ id: "running-followup", action: "followup", status: "running" }] };
      queuedActions.push(input); return { id: "queued", status: "queued" };
    };
    ctx.input = { chatId, action: "stop" }; await runtime.manage(ctx);
    assert(queuedActions.some(input => input.action === "cancel" && input.id === "running-followup"), "stop cancels follow-up jobs as well as processing jobs");
    queuedActions.length = 0;
    await runtime.recover(ctx);
    assert(!queuedActions.some(input => input.actionId === "followup"), "global pause prevents recovery from admitting new follow-ups");
    const longBody = repo.memory(actor, { action: "create", requestKey: "long-tail-text", record: { content: "这是背景资料。".repeat(6000) + "火星温室的供水阀门编号为 HX-73。", status: "active" } });
    const textRecall = await require("../plugins/memory/unified-retrieval.cjs").search(ctx, storage, scope, "HX-73");
    assert(textRecall.records.some(item => item.id === longBody.id && item.content.includes("HX-73")), "text fallback must find and present matching passages beyond the catalog preview and first body page");
    const passage = textRecall.records.find(item => item.id === longBody.id);
    assert(passage.read.offset > 32000); assert.equal(passage.truncated, true);
    assert((await ctx.api.memory({ ...passage.read, limit: 600 })).item.content.includes("HX-73"), "the excerpt carries a readable versioned offset");
    const readableMemory = ctx.api.memory;
    ctx.api.memory = async input => {
      if (input.action === "read" && input.id === longBody.id) throw Object.assign(Error("source access revoked"), { code: "MEMORY_NOT_FOUND" });
      return readableMemory(input);
    };
    assert.equal((await require("../plugins/memory/unified-retrieval.cjs").search(ctx, storage, scope, "HX-73")).records.length, 0, "revocation between search and reading never falls back to the matching preview");
    ctx.api.memory = readableMemory;
    save(storage, scope, { paused: false });
    const stopped = repo.memory(actor, { action: "create", requestKey: "stop-running-review", record: { content: "运行中停止的复查", kind: "matter", subtype: "followup", progress: "active", status: "active", attributes: { nextReviewAt: Date.now() - 1000 } } });
    await followups.admit(ctx, storage, scope, repo.memory(actor, { action: "read", id: stopped.id }).item);
    const stoppedAttempt = get(storage, `plus:followup:${stopped.id}`), stoppedEntered = Promise.withResolvers(), stoppedRelease = Promise.withResolvers();
    ctx.api.runAgent = async () => { stoppedEntered.resolve(); return stoppedRelease.promise; };
    const stoppedRun = followups.execute({ ...ctx, input: { id: stopped.id, fingerprint: stoppedAttempt.fingerprint, attempt: stoppedAttempt.attempt } }, storage, scope);
    await stoppedEntered.promise;
    ctx.input = { chatId, action: "stop" }; await runtime.manage(ctx);
    const publicationsBeforeStop = published;
    stoppedRelease.resolve({ taskId: "stopped-research", status: "completed", summary: "停止后返回的结果", data: { meaningfulChange: true, reply: "停止后不应通知" } });
    assert.equal((await stoppedRun).skipped, true);
    assert.equal(published, publicationsBeforeStop, "late model results cannot publish after global stop");
    const visible = Array.from({ length: 9 }, (_, index) => repo.memory(actor, { action: "create", requestKey: `visible-batch-${index}`, record: { content: `可见资料 ${index}`, status: "active" } }));
    const assessmentKey = `plus:turn:${chatId}:visible-batch`;
    put(storage, assessmentKey, { delivered: true, answerMessageId: "batch-answer", memories: visible.map(item => ({ id: item.id, revision: item.revision })) });
    storage.db.prepare("INSERT OR REPLACE INTO plugin_answers VALUES(?,?,?)").run(chatId, "batch-answer", "本次没有采用这些资料。");
    const inspected = [];
    ctx.api.generate = async input => { const value = JSON.parse(input.prompt); assert(value.candidates.length <= 8); inspected.push(...value.candidates.map(item => item.id));
      return { text: JSON.stringify({ outcomes: value.candidates.map(item => ({ id: item.id, revision: item.revision, outcome: "not_used" })), maintenance: [] }) }; };
    for (let iteration = 0; !get(storage, assessmentKey).assessed && iteration < 10; iteration++) await require("../plugins/memory/unified-assessment.cjs").assess(ctx, storage, scope);
    assert.equal(get(storage, assessmentKey).assessed, true);
    assert.equal(inspected.length, 9); assert.equal(new Set(inspected).size, 9, "bounded adoption batches evaluate all visible references once");
    console.log("Memory Plus: host-only writes, source-backed extraction, current recall, actual delivery tracking, no empty work, compensating rollback and durable follow-up publication passed.");
  } finally {
    close(); db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("openbot-memory-plus-")); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
