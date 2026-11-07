"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const { createUnifiedMemoryRepository } = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs"));
const { open, close } = require("../plugins/memory/storage.cjs");
const { get, put, state, save } = require("../plugins/memory/unified-state.cjs");
const maintenance = require("../plugins/memory/unified-maintenance.cjs"), scheduling = require("../plugins/memory/unified-scheduling.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-maintenance-")), db = new DatabaseSync(":memory:");
const storage = open(root), sourceRows = new Map();
const actor = chatId => ({ channelId: "one", chatId, id: "plugin:memory", permissions: ["memory:read", "memory:write", "memory:manage"], canReadChat: id => id === chatId });
let time = Date.now();
const repo = createUnifiedMemoryRepository(db, { now: () => ++time, source: (scope, id) => sourceRows.get(JSON.stringify([scope.chatId, id])) });
let request = 0, modelCalls = 0, handler, batchWrapper;
const ctx = { dataRoot: root, plugin: { id: "memory", namespace: "one" }, principal: { channelId: "one", source: "lifecycle" }, signal: new AbortController().signal,
  api: { memory: async ({ chatId, ...input }) => batchWrapper ? batchWrapper(chatId, input) : repo.memory(actor(chatId), input),
    memorySpace: async ({ chatId, ...input }) => repo.memorySpace(actor(chatId), input),
    generate: async input => { modelCalls++; assert.equal(input.usageCategory, "memory"); assert(Buffer.byteLength(input.prompt) <= maintenance.MAX_PROMPT_BYTES); const data = JSON.parse(input.prompt); assert.equal(data.dimension, "maintenance"); assert(data.records.length <= maintenance.PAGE);
      assert(!input.systemPrompt.includes("永久遗忘或安排复查") || input.systemPrompt.includes("不得"));
      return { text: JSON.stringify(await handler(data)) }; } } };
const scopeFor = suffix => ({ channelId: "one", chatId: `onebot:group:${suffix}` });
function create(scope, content, fields = {}, who = actor(scope.chatId)) { return repo.memory(who, { action: "create", requestKey: `setup-${++request}`, record: { content, kind: "fact", status: "active", tier: "working", ...fields } }); }
function read(scope, id) { return repo.memory(actor(scope.chatId), { action: "read", mode: "history", id }).item; }
function enabled(scope) { save(storage, scope, { settingsOverride: { enabled: true }, paused: false, maintenanceFailures: 0, maintenanceRetryAt: 0 }); }
const keep = record => ({ id: record.id, revision: record.revision, action: "keep", reason: "有明确的持续交流用途，现状仍然有效" });
async function drain(scope, options) { let result; for (let i = 0; i < 30; i++) { result = await maintenance.run(ctx, storage, scope, options); if (!result.pending) return result; } assert.fail("maintenance did not finish its bounded pages"); }
(async () => {
  try {
    const scope = scopeFor("quality"); enabled(scope);
    const noise = create(scope, "今天下载了RVC但尚未测试");
    const stable = create(scope, "长期协助部署时需要知道显存为6GB", { status: "pending", expiresAt: Date.now() + 86400000,
      attributes: { retention: { version: 1, basis: "stable", reason: "后续持续部署协助须按6GB显存选择可用方案", protected: false } } });
    const expired = create(scope, "候选到期不应反复占用整理", { status: "pending", expiresAt: Date.now() - 1000 });
    const boundary = create(scope, "明确要求不得把本人用于生成素材", { attributes: { retention: { basis: "boundary", protected: true } } });
    const longterm = create(scope, "长期偏好很少召回仍须保留", { tier: "long_term" });
    const matter = create(scope, "尚未解决的重要事项", { kind: "matter", progress: "waiting" });
    const manual = create(scope, "人工保存的临时资料也不能擅自清理", {}, { ...actor(scope.chatId), id: "desktop:owner" });
    const manualEdit = create(scope, "原自动内容后来由用户人工修订");
    repo.memory({ ...actor(scope.chatId), id: "desktop:owner" }, { action: "revise", id: manualEdit.id, expectedRevision: 1, changeType: "edit", requestKey: "manual-edit", patch: { content: "人工修订后的原自动记录须保留" } });
    const imported = create(scope, "迁移资料保留人工核对", { attributes: { legacy: { id: "old" } } });
    const unfrequent = create(scope, "有后续用途的低频事实");
    put(storage, `plus:score:${unfrequent.id}:1`, { selected: 30, used: 0, misapplied: 0 });
    handler = async data => ({ decisions: data.records.map(record => record.id === noise.id ? { ...keep(record), action: "archive", basis: "low_value", reason: "一次性下载未测试状态，没有明确后续任务或持续用途" }
      : record.id === stable.id ? { ...keep(record), action: "promote", basis: "stable", tier: "long_term", reason: "后续持续部署协助需要该稳定硬件条件" } : keep(record)) });
    await drain(scope);
    assert.equal(read(scope, noise.id).status, "archived", "old automatic low-value records are recoverably archived");
    assert.equal(read(scope, expired.id).status, "archived");
    const promoted = read(scope, stable.id); assert.equal(promoted.status, "active"); assert.equal(promoted.tier, "long_term"); assert.equal(promoted.expiresAt, null);
    for (const record of [boundary, longterm, matter, manual, manualEdit, imported, unfrequent]) assert.equal(read(scope, record.id).status, "active", "protected/manual/unfinished/low-frequency useful records remain");
    assert(!maintenance.pending(storage, scope));

    const onlyExpired = scopeFor("only-expired"); enabled(onlyExpired); const oldCandidate = create(onlyExpired, "过期候选无需模型重判", { status: "pending", expiresAt: Date.now() - 1 });
    const beforeExpired = modelCalls; await drain(onlyExpired); assert.equal(modelCalls, beforeExpired); assert.equal(read(onlyExpired, oldCandidate.id).status, "archived");
    const empty = scopeFor("empty"); enabled(empty); const beforeEmpty = modelCalls; await drain(empty); assert.equal(modelCalls, beforeEmpty, "no records makes no model request");

    const merge = scopeFor("merge"); enabled(merge);
    const fact = { subjectId: "alice", facet: "显存", value: "6GB", conditions: [], assertion: "self" };
    for (const id of ["one", "two"]) sourceRows.set(JSON.stringify([merge.chatId, id]), { id, version: "v1", content: "6GB", deleted: false });
    const first = create(merge, "阿明的显存为6GB", { subjectRefs: ["alice"], attributes: { fact }, sources: [{ chatId: merge.chatId, id: "one", version: "v1", quote: "6GB" }] });
    const duplicate = create(merge, "阿明表示自己有6GB显存", { subjectRefs: ["alice"], attributes: { fact }, sources: [{ chatId: merge.chatId, id: "two", version: "v1", quote: "6GB" }] });
    handler = async data => ({ decisions: data.records.map(record => record.id === duplicate.id ? { ...keep(record), action: "merge", targetId: first.id, targetRevision: 1, reason: "同一人同一显存事实合并原话来源" } : keep(record)) });
    await drain(merge); assert.equal(read(merge, duplicate.id).status, "archived"); assert.equal(read(merge, first.id).sources.length, 2); assert.equal(read(merge, first.id).content, "阿明的显存为6GB");

    const manyDuplicates = scopeFor("many-duplicates"); enabled(manyDuplicates);
    const oldFact = create(manyDuplicates, "同一结构事实的最早一份", { subjectRefs: ["alice"], attributes: { fact } });
    const duplicateIds = [];
    for (let index = 0; index < 30; index++) duplicateIds.push(create(manyDuplicates, `重复事实改写 ${index}`, { subjectRefs: ["alice"], attributes: { fact } }).id);
    handler = async data => ({ decisions: data.records.map(keep) });
    await drain(manyDuplicates); assert.equal(read(manyDuplicates, oldFact.id).status, "active");
    assert.equal(read(manyDuplicates, oldFact.id).revision, 1, "duplicate removal without additional evidence does not manufacture target revisions");
    assert(duplicateIds.every(id => read(manyDuplicates, id).status === "archived"), "structured duplicates merge across pages and shared target revisions advance with each receipt");

    const ongoing = scopeFor("ongoing"); enabled(ongoing);
    const developing = create(ongoing, "正在协助的部署事项候选", { status: "pending", expiresAt: Date.now() + 86400000 });
    handler = async data => ({ decisions: data.records.map(record => ({ ...keep(record), action: "promote", basis: "ongoing", tier: "long_term", reason: "尚在发展的部署协助只保留工作阶段" })) });
    await drain(ongoing); assert.equal(read(ongoing, developing.id).status, "active"); assert.equal(read(ongoing, developing.id).tier, "working", "model requests cannot promote an ongoing transient state into permanent memory");

    const retry = scopeFor("retry"); enabled(retry); const retried = create(retry, "该旧临时片段经评估无持续用途");
    handler = async data => ({ decisions: data.records.map(record => ({ ...keep(record), action: "archive", basis: "low_value", reason: "一次性状态没有持续协助场景" })) });
    let lost = false; batchWrapper = async (chatId, input) => { const value = repo.memory(actor(chatId), input); if (input.action === "batch" && !lost) { lost = true; throw Error("receipt lost"); } return value; };
    const beforeRetry = modelCalls; await assert.rejects(maintenance.run(ctx, storage, retry), /receipt lost/);
    assert(get(storage, maintenance.cycleKey(retry)).decisions); assert(!JSON.stringify(get(storage, maintenance.cycleKey(retry))).includes("该旧临时片段"), "checkpoint retains decisions, not a second body");
    await drain(retry); batchWrapper = null; assert.equal(modelCalls, beforeRetry + 1, "receipt retries do not repeat the model review"); assert.equal(read(retry, retried.id).revision, 2);

    const canceled = scopeFor("canceled"); enabled(canceled); const cancellationTarget = create(canceled, "取消时不能迟到写入");
    const started = Promise.withResolvers(), release = Promise.withResolvers(), abort = new AbortController();
    handler = async data => { started.resolve(); await release.promise; return { decisions: data.records.map(record => ({ ...keep(record), action: "archive", basis: "low_value", reason: "一次性资料不再有明确用途" })) }; };
    const executing = maintenance.run({ ...ctx, signal: abort.signal }, storage, canceled); await started.promise; abort.abort(Error("stop")); release.resolve();
    await assert.rejects(executing, /stop/); assert.equal(read(canceled, cancellationTarget.id).revision, 1);

    const revised = scopeFor("revised"); enabled(revised); const changed = create(revised, "模型核对期间被用户修订");
    handler = async data => { repo.memory(actor(revised.chatId), { action: "revise", id: changed.id, expectedRevision: 1, changeType: "edit", requestKey: "user-change", patch: { content: "用户修订后的有效内容" } });
      return { decisions: data.records.map(record => ({ ...keep(record), action: "archive", basis: "low_value", reason: "旧片段没有持续用途" })) }; };
    await drain(revised); assert.equal(read(revised, changed.id).status, "active"); assert.equal(read(revised, changed.id).content, "用户修订后的有效内容");

    const clock = scopeFor("clock"); enabled(clock); save(storage, clock, { nextRun: Date.now() + 100000, maintenanceNextRun: Date.now() - 1 });
    const noSources = { ...ctx, api: { ...ctx.api, sources: async () => ({ upper: 0, observedAt: 0 }) } };
    assert.equal(await scheduling.due(noSources, storage, clock), "scheduled", "idle's later nextRun cannot postpone the daily maintenance deadline");
    save(storage, clock, { paused: true }); assert.equal(await scheduling.due(noSources, storage, clock), "");
    save(storage, clock, { paused: false, settingsOverride: { enabled: false } }); assert.equal(await scheduling.due(noSources, storage, clock), "");

    const payloadScope = scopeFor("payload"); enabled(payloadScope);
    const quote = "来源原话".repeat(200);
    const references = Array.from({ length: 30 }, (_, index) => { const id = `bounded-source-${index}`;
      sourceRows.set(JSON.stringify([payloadScope.chatId, id]), { id, version: "v1", content: quote, deleted: false });
      return { chatId: payloadScope.chatId, id, version: "v1", quote }; });
    for (let index = 0; index < 8; index++) create(payloadScope, "长段有条件资料".repeat(500), { sources: references });
    handler = async data => ({ decisions: data.records.map(keep) }); const beforeLarge = modelCalls;
    await drain(payloadScope); assert(modelCalls > beforeLarge + 1, "large source/body combinations are split into bounded review calls");
    const afterLarge = modelCalls; await drain(payloadScope); assert.equal(modelCalls, afterLarge, "unchanged reviewed versions reuse their decision instead of spending tokens daily");

    const capacity = scopeFor("capacity"); enabled(capacity);
    for (let index = 0; index < 129; index++) create(capacity, `有用的现有工作记忆 ${index}`);
    const overflowing = create(capacity, "容量已满的相关候选", { status: "pending", expiresAt: Date.now() + 86400000 });
    handler = async data => ({ decisions: data.records.map(record => record.id === overflowing.id ? { ...keep(record), action: "promote", basis: "ongoing", tier: "working", reason: "确有后续协助场景但须遵守工作记忆总预算" } : keep(record)) });
    await drain(capacity); assert.equal(read(capacity, overflowing.id).status, "pending", "promotion respects the existing working-record capacity");

    const foreign = scopeFor("foreign"); enabled(foreign); const foreignRecord = create(foreign, "其他群的记录不能成为合并目标");
    const isolation = scopeFor("isolation"); enabled(isolation); create(isolation, "本群待评估记录");
    handler = async data => ({ decisions: data.records.map(record => ({ ...keep(record), action: "merge", targetId: foreignRecord.id, targetRevision: 1, reason: "伪造跨群合并目标" })) });
    await assert.rejects(maintenance.run(ctx, storage, isolation), /同一主体/); assert.equal(read(foreign, foreignRecord.id).revision, 1);

    console.log("Memory maintenance: separate daily deadline, no-input sweeps, candidate promotion/expiry, legacy noise archive, protected records, sourced merge, receipt retry, cancellation, and version recheck passed.");
  } finally { close(); db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith("openbot-memory-maintenance-")); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
