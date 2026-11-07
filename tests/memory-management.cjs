"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const runtime = require("../plugins/memory/unified-runtime.cjs"), { current, put, state, save } = require("../plugins/memory/unified-state.cjs");
const { close } = require("../plugins/memory/storage.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-management-"));
const scope = { channelId: "bot", chatId: "onebot:group:team" }, canceled = [], jobs = [];
const ctx = { dataRoot: root, principal: { channelId: scope.channelId }, input: { chatId: scope.chatId }, signal: new AbortController().signal,
  api: { sources: async () => ({ scopes: [{ chatId: scope.chatId, name: "测试群", privatePayload: "x".repeat(100000) }] }),
    jobs: async input => {
      if (input.action === "cancel") { canceled.push(input.id); jobs.find(job => job.id === input.id).status = "canceled"; return {}; }
      const visible = jobs.filter(job => !input.statuses || input.statuses.includes(job.status));
      let offset = 0;
      if (input.cursor) { offset = visible.findIndex(job => job.id === input.cursor) + 1; assert(offset > 0, "canceling a page must not invalidate the next page cursor"); }
      const page = visible.slice(offset, offset + 50);
      return { jobs: page, nextCursor: visible.length > offset + 50 ? page.at(-1).id : null };
    } } };
(async () => {
  try {
    const { storage } = current(ctx), runs = storage.dreamRepository.runs;
    const saved = [];
    for (let i = 0; i < 25; i++) {
      const id = runs.start(scope, { trigger: "manual", cutoff: Date.now(), upper: i });
      runs.change(scope, id, { memories: 1 }); runs.finish(scope, id, "completed"); saved.push(id);
      const empty = runs.start(scope, { trigger: "idle", cutoff: Date.now(), upper: i }); runs.finish(scope, empty, "completed");
    }
    const failure = runs.start(scope, { trigger: "manual", cutoff: Date.now(), upper: 0 }); runs.finish(scope, failure, "failed", "保留错误记录");
    const first = runs.list(scope, { meaningfulOnly: true }); assert.equal(first.items.length, 20); assert(first.items.some(run => run.id === failure));
    const second = runs.list(scope, { meaningfulOnly: true, offset: first.nextOffset }); assert.equal(second.items.length, 6); assert.equal(second.nextOffset, null);
    assert([...first.items, ...second.items].every(run => run.id === failure || saved.includes(run.id)), "successful empty scans do not consume list positions");
    assert.equal(runs.list(scope).items.length, 20, "raw journals are preserved for direct inspection");

    const body = "大段原始资料🙂\n".repeat(12000), detailRun = saved[0];
    for (let i = 0; i < 24; i++) runs.trace(scope, detailRun, "dream_input", { text: body, arguments: body, callSeq: 1 });
    ctx.input = { ...ctx.input, action: "readRun", runId: detailRun };
    const details = await runtime.manage(ctx); assert(Buffer.byteLength(JSON.stringify(details)) < 65536);
    const event = details.events.find(event => event.kind === "dream_input"); assert(event.nextOffset > 0);
    let restored = event.text, offset = event.nextOffset;
    while (offset != null) {
      const chunk = await runtime.manage({ ...ctx, input: { ...ctx.input, action: "readRunEvent", eventSeq: event.seq, offset } });
      assert(Buffer.byteLength(JSON.stringify(chunk)) < 65536); restored += chunk.text; offset = chunk.nextOffset;
    }
    assert.equal(restored, body, "paged details preserve the whole original text");
    await assert.rejects(runtime.manage({ ...ctx, input: { ...ctx.input, action: "readRunEvent", runId: saved[1], eventSeq: event.seq } }), /不属于/);

    for (let i = 0; i < 25; i++) {
      put(storage, `plus:followup:${i}`, { chatId: scope.chatId, memoryId: String(i), recordRevision: 1, paused: true, report: body });
      put(storage, `plus:maintenance:${i}`, { chatId: scope.chatId, id: String(i), proposalId: String(i), target: "long_term", status: "pending", reason: "有用的长期偏好", privatePayload: body });
    }
    jobs.push({ id: "busy", action: "process", status: "queued", progress: { text: body }, error: body });
    ctx.input = { chatId: scope.chatId };
    const page = await runtime.list(ctx); assert.equal(page.busy, true); assert(Buffer.byteLength(JSON.stringify(page)) < 65536);
    assert.equal(page.maintenance.length, 10); assert.equal(page.maintenanceNextOffset, 10);
    assert.equal(page.followups.length, 20); assert.equal(page.followupsNextOffset, 20);
    assert(!JSON.stringify(page).includes("大段原始资料"), "list responses exclude job progress and follow-up report bodies");
    const next = await runtime.list({ ...ctx, input: { chatId: scope.chatId, maintenanceOffset: page.maintenanceNextOffset, followupOffset: page.followupsNextOffset } });
    assert.equal(next.followups.length, 5); assert.equal(next.followupsNextOffset, null);
    assert(!next.maintenance.some(item => page.maintenance.some(old => old.id === item.id)));

    const originalSources = ctx.api.sources, reason = "理".repeat(1000);
    let discoveries = 0;
    ctx.api.sources = async () => { discoveries++; return { scopes: Array.from({ length: 150 }, (_, i) => ({ chatId: `onebot:group:${i}`, name: "名".repeat(100) })) }; };
    for (let i = 0; i < 25; i++) put(storage, `plus:maintenance:${i}`, { chatId: scope.chatId, id: String(i), proposalId: String(i), target: "long_term", status: "pending", reason });
    jobs.length = 0; jobs.push(...Array.from({ length: 50 }, (_, i) => ({ id: String(i).padStart(64, "0"), action: "process", status: "queued", progress: { text: body } })));
    const large = await runtime.list(ctx); assert(Buffer.byteLength(JSON.stringify(large)) < 61440, "all sections together remain below the page transport limit");
    assert(large.chats.length < 150); assert(large.chatsNextOffset > 0); assert(large.maintenance.length < 10);
    const allChats = [...large.chats]; let chatOffset = large.chatsNextOffset;
    while (chatOffset != null) {
      const part = await runtime.list({ ...ctx, input: { chatsOnly: true, chatOffset } });
      assert(Buffer.byteLength(JSON.stringify(part)) < 61440); allChats.push(...part.chats); chatOffset = part.chatsNextOffset;
    }
    assert.equal(allChats.length, 150); assert.equal(new Set(allChats.map(item => item.chatId)).size, 150); assert(allChats.every(item => item.name === "名".repeat(100)));
    const beforeRefresh = discoveries, allProposals = [];
    let maintenanceOffset = 0;
    do {
      const part = await runtime.list({ ...ctx, input: { chatId: scope.chatId, includeChats: false, maintenanceOffset } });
      assert(Buffer.byteLength(JSON.stringify(part)) < 61440); assert(!Object.hasOwn(part, "chats"));
      allProposals.push(...part.maintenance); maintenanceOffset = part.maintenanceNextOffset;
    } while (maintenanceOffset != null);
    assert.equal(discoveries, beforeRefresh, "routine refreshes and section paging do not rediscover every chat");
    assert.equal(allProposals.length, 25); assert.equal(new Set(allProposals.map(item => item.proposalId)).size, 25);
    assert(allProposals.every(item => item.reason === reason), "byte paging never truncates maintenance explanations");
    ctx.api.sources = originalSources;

    const pendingKey = `plus:rollback:${scope.chatId}:${detailRun}`, pendingChanges = saved.map(id => ({ id, beforeRevision: 1, afterRevision: 2, before: { content: body } }));
    put(storage, pendingKey, { token: "pending-preview", changes: pendingChanges, operations: [] });
    const preview = await runtime.manage({ ...ctx, input: { chatId: scope.chatId, action: "rollbackPreview", runId: detailRun } });
    assert(Buffer.byteLength(JSON.stringify(preview)) < 65536); assert.equal(preview.changes.length, saved.length);
    assert(preview.changes.every(item => !Object.hasOwn(item, "before")), "pending rollback previews never transfer saved record bodies");
    const manyChanges = Array.from({ length: 501 }, (_, i) => ({ id: `mem-${i}`, beforeRevision: 1, afterRevision: 2, before: { content: "旧正文".repeat(1000) } }));
    put(storage, pendingKey, { token: "large-preview", changes: manyChanges, operations: [] });
    let previewOffset = 0, previewSnapshot; const shown = [];
    do {
      const part = await runtime.manage({ ...ctx, input: { chatId: scope.chatId, action: "rollbackPreview", runId: detailRun, offset: previewOffset, previewSnapshot } });
      assert(Buffer.byteLength(JSON.stringify(part)) < 65536); assert.equal(part.token, "large-preview");
      assert(!previewSnapshot || part.previewSnapshot === previewSnapshot); previewSnapshot = part.previewSnapshot;
      shown.push(...part.changes); previewOffset = part.nextOffset;
    } while (previewOffset != null);
    assert.equal(shown.length, 501); assert.equal(new Set(shown.map(item => item.id)).size, 501);
    put(storage, pendingKey, { token: "changed-preview", changes: manyChanges, operations: [] });
    await assert.rejects(runtime.manage({ ...ctx, input: { chatId: scope.chatId, action: "rollbackPreview", runId: detailRun, offset: 100, previewSnapshot } }), /预览已变化/);

    const legacy = require("../plugins/memory/unified-legacy-rollback.cjs"), convert = legacy.convert;
    try {
      const conflicts = Array.from({ length: 101 }, (_, i) => `${i}：${"冲突".repeat(500)}`);
      legacy.convert = async () => ({ changes: [], conflicts });
      const errors = []; let offset = 0, snapshot;
      do {
        const part = await runtime.manage({ ...ctx, input: { chatId: scope.chatId, action: "rollbackPreview", runId: "legacy-conflicts", offset, previewSnapshot: snapshot } });
        assert.equal(part.available, false); assert(!part.token); assert(Buffer.byteLength(JSON.stringify(part)) < 65536);
        errors.push(...part.conflicts); snapshot = part.previewSnapshot; offset = part.nextOffset;
      } while (offset != null);
      assert.deepEqual(errors, conflicts, "every conflict remains readable across bounded preview pages");
    } finally { legacy.convert = convert; }

    jobs.length = 0;
    jobs.push(...Array.from({ length: 65 }, (_, i) => ({ id: String(i), action: i % 2 ? "followup" : "process", status: "queued" })), { id: "other", action: "import", status: "queued" });
    ctx.input = { chatId: scope.chatId, action: "stop" }; await runtime.manage(ctx);
    assert.equal(new Set(canceled).size, 65); assert(!canceled.includes("other")); assert.equal(state(storage, scope).paused, true);

    const abort = new AbortController(), stoppedId = runs.start(scope, { trigger: "manual", cutoff: Date.now(), upper: 0 });
    save(storage, scope, { paused: false, job: { runId: stoppedId, trigger: "manual" } }); abort.abort(Error("用户停止"));
    await assert.rejects(require("../plugins/memory/unified-organizer.cjs").run({ ...ctx, signal: abort.signal }, storage, scope), /用户停止/);
    assert.equal(runs.get(scope, stoppedId).status, "paused"); assert.equal(state(storage, scope).error, ""); assert.equal(state(storage, scope).failures, 0);
    console.log("Memory management: empty-run filtering, stable pagination, bounded detail/list payloads, lossless event paging, all queued cancellations, and stop without failure passed.");
  } finally { close(); assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith("openbot-memory-management-")); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
