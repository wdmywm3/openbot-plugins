"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createHash } = require("node:crypto"), { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const { createUnifiedMemoryRepository } = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs"));
const organizer = require("../plugins/memory/unified-organizer.cjs"), dream = require("../plugins/memory/unified-dream.cjs");
const { open, close } = require("../plugins/memory/storage.cjs"), { get, save } = require("../plugins/memory/unified-state.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-organizer-")), db = new DatabaseSync(":memory:");
const scope = { channelId: "one", chatId: "onebot:group:g" };
const messages = Array.from({ length: 350 }, (_, index) => ({ id: `message-${index + 1}`, seq: index + 1,
  version: createHash("sha256").update(String(index)).digest("hex"), createdAt: 1000 + index,
  direction: index % 7 === 0 ? "out" : "in", source: index % 11 === 0 ? "tool_result" : "chat",
  sender: { id: index % 7 === 0 ? "bot" : "alice", name: index % 7 === 0 ? "Bot" : "阿明", isBot: index % 7 === 0 },
  content: index === 1 ? "我希望你以后回答简短一些。" : "好，今天一起聊聊。" }));
const repo = createUnifiedMemoryRepository(db, { source: (_scope, id) => messages.find(item => item.id === id),
  ownerAllowed: (who, kind, ownerId) => kind === "chat" && (who.chatId === ownerId || who.managementChats?.includes(ownerId)) });
const actor = { ...scope, id: "plugin:memory", manage: true, permissions: ["memory:read", "memory:write", "memory:manage"], canReadChat: () => true };
const storage = open(root), calls = []; let failAfterCommit = false, failed = false, paused = false, changedPolicy = false;
const ctx = { signal: new AbortController().signal, principal: { ...scope, source: "lifecycle" }, api: {
  sources: async input => {
    if (input.action === "read") return { item: messages.find(item => item.id === input.id) };
    const upper = input.upper ?? messages.at(-1).seq, rows = messages.filter(item => item.seq > input.after && item.seq <= upper);
    return { items: rows.slice(0, input.limit), upper, nextCursor: rows.length > input.limit ? rows[input.limit - 1].seq : null };
  },
  memory: async ({ chatId, ...input }) => repo.memory(actor, input),
  runAgent: async request => {
    calls.push(request); assert.deepEqual(request.tools, ["plugin__memory__organize"]);
    if (changedPolicy) { changedPolicy = false; throw Object.assign(Error("changed model policy"), { code: "AGENT_TASK_CHANGED" }); }
    const batch = JSON.parse(request.continuation.content), source = batch.messages.find(item => item.text.includes("回答简短"));
    assert(batch.messages.length > 12 || calls.length > 1);
    assert(batch.messages.every(item => item.version === undefined && item.observedAt === undefined));
    if (paused) save(storage, scope, { paused: true });
    const invoke = input => organizer.tool({ ...ctx, input: { ticket: batch.ticket, ...input } }, storage, scope);
    const result = { facts: [], topics: [], records: [{ kind: "experience", content: "我记得一起聊天", evidence: [] }] };
    if (source) {
      await invoke({ operation: "search", query: "回答简短" });
      result.facts.push({ kind: "preference", subjectId: "alice", profileSection: "communication", content: "阿明希望回答简短一些。", evidence: [{ id: source.id, quote: source.text }] });
    } else result.records = [];
    const receipt = await invoke({ operation: "commit", result }); assert.equal(receipt.ok, true);
    assert.deepEqual(await invoke({ operation: "commit", result }), receipt, "duplicate tool call reuses the committed receipt");
    if (failAfterCommit && !failed) { failed = true; throw Error("provider response lost"); }
    return { taskId: request.taskId, status: "completed", summary: "done" };
  },
} };
(async () => {
  try {
    const collected = await organizer.collect(ctx, scope, 0);
    assert(collected.messages.length > 100, "short messages are packed by token budget, not twelve per request");
    assert(collected.materials.every(item => item.source === "chat"));
    assert(collected.messages.some(item => item.role === "bot"), "real bot speech remains context");
    failAfterCommit = true;
    await assert.rejects(dream.run(ctx, storage, scope), /response lost/);
    const prior = get(storage, `plus:state:${scope.chatId}`).cursor;
    assert(prior > 12, "committed progress survives a later provider failure");
    const result = await dream.run(ctx, storage, scope); assert(result.completed);
    assert.equal(calls[0].taskId, calls.at(-1).taskId);
    assert.deepEqual(calls[0].continuation, calls[1].continuation, "retry uses exactly the same pending batch");
    const memories = repo.memory(actor, { action: "search" }).items;
    assert.equal(memories.length, 1); assert.equal(memories[0].kind, "preference");
    const record = repo.memory(actor, { action: "read", id: memories[0].id }).item;
    assert.equal(record.attributes.profile.section, "communication"); assert.deepEqual(record.subjectRefs, ["alice"]);
    assert.equal(record.category, "profile");
    assert.equal(record.sources[0].id, "message-2");
    const before = calls.length; await dream.run(ctx, storage, scope); assert.equal(calls.length, before, "no new material makes no model request");
    messages.push({ ...messages[1], id: "later", seq: 351, content: "我希望你以后回答简短一些。" });
    await dream.run(ctx, storage, scope); assert.equal(calls.at(-1).taskId, calls[0].taskId, "next scheduled run retains the organizer session");
    assert.equal(repo.memory(actor, { action: "search" }).items.length, 1, "repeated evidence updates the same preference");
    assert.equal(repo.memory(actor, { action: "read", id: record.id }).item.sources.length, 2);
    const current = repo.memory(actor, { action: "read", id: record.id }).item;
    const correction = { ...messages[1], chatId: scope.chatId, id: "correction", content: "以后请详细说明，不再要求简短。" };
    const revised = await dream.plan(ctx, scope, { facts: [], topics: [], revisions: [{ supersedes: { id: current.id, revision: current.revision },
      changeType: "correction", content: "阿明希望详细说明。", evidence: [{ id: correction.id, quote: correction.content }] }] }, [correction], [current]);
    assert.equal(revised.operations.length, 1); assert.equal(revised.operations[0].patch.attributes.profile.section, "communication");
    assert.equal(revised.operations[0].id, current.id, "group preference corrections keep the member and profile category");
    const wrong = { facts: [{ kind: "fact", subjectId: "other", profileSection: "identity", content: "别人的身份", evidence: [{ id: messages[1].id, quote: messages[1].content }] }], topics: [] };
    await assert.rejects(dream.plan(ctx, scope, wrong, [messages[1]], []), /本人/);
    messages.push({ ...messages[1], id: "last-receipt", seq: 352 }); failed = false;
    await assert.rejects(dream.run(ctx, storage, scope), /response lost/);
    assert.equal(get(storage, `plus:state:${scope.chatId}`).job, null);
    assert.equal(await require("../plugins/memory/unified-scheduling.cjs").due(ctx, storage, scope), "continuation", "final receipt retries without waiting for tomorrow");
    const queued = [], sourceApi = ctx.api.sources;
    ctx.dataRoot = root; ctx.plugin = { namespace: scope.channelId };
    ctx.api.sources = input => input.action === "scopes" ? Promise.resolve({ scopes: [{ chatId: scope.chatId }] }) : sourceApi(input);
    ctx.api.jobs = async input => input.action === "start" ? (queued.push(input), { id: String(queued.length) }) : { jobs: [] };
    save(storage, scope, { retryAt: 0 });
    await require("../plugins/memory/unified-runtime.cjs").recover(ctx);
    assert(queued.some(item => item.input?.mode === "dream"), "polling queues an unfinished final receipt even with no new source messages");
    await dream.run(ctx, storage, scope);
    const oldTask = calls.at(-1).taskId;
    messages.push({ ...messages[1], id: "new-policy", seq: 353 }); changedPolicy = true;
    await dream.run(ctx, storage, scope);
    assert.notEqual(calls.at(-1).taskId, oldTask); assert.equal(calls.at(-1).continuation.sequence, 1);
    assert.equal(repo.memory(actor, { action: "search" }).items.length, 1, "policy changes do not duplicate committed memory");
    messages.push({ ...messages[1], id: "pause", seq: 354 }); paused = true;
    await assert.rejects(dream.run(ctx, storage, scope), /暂停/);
    assert(get(storage, `plus:state:${scope.chatId}`).cursor < 354, "pause prevents uncommitted progress and writes");
    const legacy = repo.memory(actor, { action: "create", requestKey: "legacy-profile", record: { content: "已有的个人偏好", kind: "preference", status: "active", subjectRefs: ["alice"] } });
    const event = repo.memory(actor, { action: "create", requestKey: "event-fact", record: { content: "这次下载了模型", kind: "fact", status: "active", subjectRefs: ["alice"] } });
    const elsewhere = { ...actor, chatId: "onebot:group:elsewhere" };
    const remote = repo.memory(elsewhere, { action: "create", requestKey: "other-profile", record: { content: "另一群的偏好", kind: "preference", status: "active", subjectRefs: ["alice"] } });
    ctx.api.memorySpace = async input => repo.memorySpace(actor, input);
    const foreign = repo.memory(elsewhere, { action: "read", id: remote.id }).item;
    repo.memorySpace({ ...elsewhere, managementChats: [scope.chatId], permissions: [...elsewhere.permissions, "memory:share"] }, { action: "grant", spaceId: foreign.spaceId,
      targetSpaceId: record.spaceId, recordIds: [foreign.id], capabilities: ["read", "write"], requestKey: "shared-profile" });
    assert(repo.memory(actor, { action: "read", id: foreign.id }).item, "fixture grants actual cross-chat access");
    await assert.rejects(dream.plan(ctx, scope, { facts: [], topics: [] }, [], [foreign]), /其他聊天/);
    const migration = require("../plugins/memory/unified-profile-migration.cjs"), modelCalls = calls.length;
    await migration.classify(ctx, storage, scope);
    const categorized = repo.memory(actor, { action: "read", id: legacy.id }).item;
    assert.equal(categorized.category, "profile"); assert.equal(categorized.content, "已有的个人偏好");
    assert.equal(repo.memory(actor, { action: "read", id: event.id }).item.category, undefined, "event facts do not become personality traits");
    assert.equal(repo.memory(elsewhere, { action: "read", id: remote.id }).item.category, undefined, "another chat is never rewritten");
    await migration.classify(ctx, storage, scope);
    assert.equal(repo.memory(actor, { action: "read", id: legacy.id }).item.revision, categorized.revision);
    assert.equal(calls.length, modelCalls, "classifying existing preference records needs no model");
    console.log("Memory organizer: large bounded batches, chat-only inputs, persistent conversation, tool receipts, interrupted retry, no duplicate writes, profile evidence and pause passed.");
  } finally { close(); db.close(); assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith("openbot-organizer-")); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
