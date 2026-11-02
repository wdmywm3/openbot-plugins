"use strict";
// Plugin-owned policy tests. The public host APIs below are test doubles;
// transactional host repositories and real workers remain in test:integration.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const runtime = require("../plugins/memory/unified-runtime.cjs");
const scheduling = require("../plugins/memory/unified-scheduling.cjs");
const material = require("../plugins/memory/unified-material-policy.cjs");
const { candidates } = require("../plugins/memory/unified-candidates.cjs");
const { current, state, save, get, put } = require("../plugins/memory/unified-state.cjs");
const { close } = require("../plugins/memory/storage.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-standalone-"));
const chatId = "onebot:private:owner", source = { id: "message", version: "v1", chatId, content: "我喜欢茶", direction: "in", event: { type: "message" } };
const jobs = [], writes = []; let generated = 0, head = { upper: 1, observedAt: 0 }, now = Date.UTC(2026, 10, 1, 12), passed = 0;
const realNow = Date.now;
const ctx = { dataRoot: root, plugin: { namespace: "bot" }, principal: { channelId: "bot", senderId: "owner" },
  message: { id: "message", chatId }, input: { chatId }, config: {}, signal: new AbortController().signal,
  api: {
    getCapabilities: async () => ({ features: { unifiedMemory: true, persistentContextItems: true, visibleContextItems: true, sourceHead: true } }),
    sources: async input => input.action === "head" ? head : input.action === "read" ? { item: source } : { scopes: [{ chatId }], items: [], upper: 0, nextCursor: null },
    memory: async input => { if (input.action === "search") return { items: [], nextOffset: null };
      if (input.action === "changes") return { items: [], upper: 0, nextCursor: null };
      if (input.action === "read") return { item: { id: input.id, revision: 1, content: "已保存", nextOffset: null } };
      writes.push(input); return { ok: true, id: "mem-new", revision: 1 }; },
    jobs: async input => { jobs.push(input); return input.action === "list" ? { jobs: [] } : { id: `job-${jobs.length}` }; },
    generate: async () => { generated++; throw Error("unexpected model call"); },
  } };
async function check(name, action) { await action(); passed++; console.log(`Memory standalone passed: ${name}`); }
async function manage(input) { return runtime.manage({ ...ctx, input: { chatId, ...input } }); }
(async () => {
  Date.now = () => now;
  try {
    await check("required capabilities fail explicitly", async () => {
      await assert.rejects(runtime.initialize({ ...ctx, api: { ...ctx.api, getCapabilities: async () => ({ features: {} }) } }), /新版 OpenBot/);
      assert.equal(writes.length, 0);
    });
    await runtime.initialize(ctx);
    await check("settings schedule from save time without model work", async () => {
      await manage({ action: "settings", settings: { enabled: true, schedule: "hourly", idleMinutes: 30 } });
      assert(state(current(ctx).storage, current(ctx).scope).nextRun > now); assert.equal(generated, 0);
      assert.equal((await runtime.process({ ...ctx, input: { chatId, mode: "dream" } })).reason, "not_due");
    });
    await check("pause survives storage restart and enabled settings resume", async () => {
      await manage({ action: "stop" }); close();
      assert.equal((await runtime.list(ctx)).paused, true);
      assert.equal((await runtime.process({ ...ctx, input: { chatId, mode: "dream" } })).reason, "paused");
      await manage({ action: "settings", settings: { enabled: true } });
      assert.equal((await runtime.list(ctx)).paused, false);
    });
    await check("index-only processing never invokes the model", async () => {
      assert.deepEqual(await runtime.process({ ...ctx, input: { chatId, mode: "index" } }), { index: { mode: "text" } });
      assert.equal(generated, 0); assert.equal(writes.length, 0);
    });
    await check("idle follows latest source and foreground completion", async () => {
      const { storage, scope } = current(ctx);
      save(storage, scope, { nextRun: now + 7200000 });
      head = { upper: 10, observedAt: now - 60000 };
      assert.equal(await scheduling.due(ctx, storage, scope), "");
      head.observedAt = now - 3600000;
      assert.equal(await scheduling.due(ctx, storage, scope), "idle");
      scheduling.activity(storage, scope, "first", true); scheduling.activity(storage, scope, "second", true);
      scheduling.activity(storage, scope, "first", false);
      assert.equal(scheduling.active(storage, scope), true);
      assert.equal(await scheduling.due(ctx, storage, scope), "");
      scheduling.activity(storage, scope, "second", false);
      assert.equal(await scheduling.due(ctx, storage, scope), "");
      now += 31 * 60000;
      assert.equal(await scheduling.due(ctx, storage, scope), "idle");
    });
    await check("cross-chat input is rejected before work", async () => {
      await assert.rejects(runtime.process({ ...ctx, input: { chatId: "onebot:private:other", mode: "index" } }), /当前聊天/);
    });
    await check("manual run explicitly resumes and queues one job", async () => {
      await manage({ action: "stop" }); const before = jobs.length;
      await manage({ action: "run" });
      const queued = jobs.slice(before).filter(item => item.action === "start");
      assert.equal(queued.length, 1); assert.equal(queued[0].input.dream, true); assert.equal(queued[0].chatId, chatId);
      assert.equal((await runtime.list(ctx)).paused, false);
    });
    await check("unavailable and undelivered sources are excluded", () => {
      for (const key of ["deleted", "routeBlocked", "memoryExcluded"]) assert.equal(material.admit({ ...source, [key]: true }), false, key);
      for (const networkStatus of ["failed", "unknown"]) assert.equal(material.admit({ ...source, direction: "out", networkStatus }), false);
      assert.equal(material.admit(source), true); assert.equal(material.admit({ ...source, direction: "out", networkStatus: "sent" }), true);
    });
    await check("notifications and task reports cannot support personal facts", () => {
      const allowed = item => material.factsAllowed([{ id: item.id }], [item]);
      assert.equal(allowed(source), true);
      assert.equal(allowed({ ...source, event: { type: "notice" } }), false);
      assert.equal(allowed({ ...source, source: "task_report" }), false);
    });
    await check("equivalent candidates combine evidence without merging subjects or conditions", () => {
      const operations = [], before = [], add = candidates([], operations, before);
      const record = { content: "喜欢茶", kind: "preference", subjectRefs: ["owner"], conditions: ["早上"], sources: [{ id: "a", version: "v1" }] };
      add(structuredClone(record)); add({ ...record, sources: [{ id: "b", version: "v1" }] });
      assert.equal(operations.length, 1); assert.deepEqual(operations[0].record.sources.map(item => item.id), ["a", "b"]);
      add({ ...record, subjectRefs: ["other"] }); add({ ...record, conditions: ["晚上"] }); assert.equal(operations.length, 3);
    });
    await check("existing long content uses revisions to add evidence", () => {
      const operations = [], before = [], record = { id: "mem-existing", revision: 7, content: "长经历".repeat(700), sources: [{ id: "a", version: "v1" }] };
      candidates([record], operations, before)({ ...record, sources: [{ id: "b", version: "v1" }] });
      assert.equal(operations.length, 1); assert.equal(operations[0].action, "revise"); assert.equal(operations[0].expectedRevision, 7);
      assert.equal(operations[0].patch.sources.length, 2);
    });
    await check("compatibility writes use host memory and current evidence", async () => {
      const result = await runtime.memory({ ...ctx, input: { action: "remember", content: "主人喜欢茶" } });
      assert.equal(result.ok, true); assert.equal(writes.at(-1).action, "create"); assert.equal(writes.at(-1).record.sources[0].version, "v1");
      const { storage } = current(ctx);
      assert.equal(storage.db.prepare("SELECT count(*) AS count FROM channel_memories").get().count, 0);
      source.deleted = true;
      await assert.rejects(runtime.memory({ ...ctx, input: { action: "remember", content: "不得恢复" } }), /原始消息已不可用/);
      source.deleted = false;
      await assert.rejects(runtime.memory({ ...ctx, input: { action: "forget", id: "mem-existing" } }), /永久遗忘请使用宿主/);
    });
    await check("explicit cutover drops unfinished work but preserves memories and disabled settings", async () => {
      await manage({ action: "settings", settings: { enabled: false } });
      const { storage, scope } = current(ctx), beforeWrites = writes.length;
      save(storage, scope, { job: { upper: 90, prepared: true } }); put(storage, `plus:plan:${chatId}`, { operations: [{ action: "create" }] });
      head = { upper: 77, observedAt: now };
      await manage({ action: "startFromNow", requestKey: "cutover-one" });
      const page = await runtime.list(ctx);
      assert.equal(page.checkpoint.cursor, 77); assert.equal(page.pending, false); assert.equal(page.settings.enabled, false);
      assert.equal(writes.length, beforeWrites); assert.equal(get(storage, `plus:plan:${chatId}`), null);
      close(); assert.equal((await runtime.list(ctx)).checkpoint.cursor, 77, "cutover persists across storage restart");
    });
    await check("cutover retry does not skip messages received after the first request", async () => {
      head.upper = 78;
      const receipt = await manage({ action: "startFromNow", requestKey: "cutover-one" });
      assert.equal(receipt.chats[0].cursor, 77); assert.equal((await runtime.list(ctx)).checkpoint.cursor, 77);
    });
    await check("running jobs and source failures leave checkpoints unchanged", async () => {
      await assert.rejects(runtime.manage({ ...ctx, input: { chatId, action: "startFromNow", requestKey: "busy" }, api: { ...ctx.api,
        jobs: async () => ({ jobs: [{ action: "process", status: "running" }] }) } }), /请先暂停/);
      await assert.rejects(runtime.manage({ ...ctx, input: { chatId, action: "startFromNow", requestKey: "failed-head" }, api: { ...ctx.api,
        sources: async () => { throw Error("source temporarily unavailable"); } } }), /temporarily unavailable/);
      assert.equal((await runtime.list(ctx)).checkpoint.cursor, 77);
    });
    await check("idle checks and completed empty scans share the committed cursor", async () => {
      await manage({ action: "settings", settings: { enabled: true, schedule: "hourly", idleMinutes: 5 } });
      const { storage, scope } = current(ctx); head = { upper: 78, observedAt: now - 600000 };
      assert.equal(await scheduling.due(ctx, storage, scope), "idle"); assert.equal(state(storage, scope).cursor, 77);
      const empty = { ...ctx, input: { chatId, mode: "dream" }, api: { ...ctx.api,
        sources: async input => input.action === "head" ? head : { items: [], upper: 78, nextCursor: null } } };
      await runtime.process(empty); assert.equal((await runtime.list(ctx)).checkpoint.cursor, 78);
      assert.equal(await scheduling.due(ctx, storage, scope), ""); assert.equal(generated, 0);
    });
    await check("instance cutover validates all source heads before changing any chat", async () => {
      const other = "onebot:group:second", scoped = { ...ctx, message: {}, input: { action: "startFromNow", requestKey: "instance-failure" }, api: { ...ctx.api,
        sources: async input => input.action === "scopes" ? { scopes: [{ chatId }, { chatId: other }] } : input.chatId === other ? { upper: 9 } : { upper: -1 } } };
      await assert.rejects(runtime.manage(scoped), /起点未修改/);
      assert.equal((await runtime.list(ctx)).checkpoint.cursor, 78);
      const success = await runtime.manage({ ...scoped, input: { action: "startFromNow", requestKey: "instance-success" }, api: { ...scoped.api,
        sources: async input => input.action === "scopes" ? { scopes: [{ chatId }, { chatId: other }] } : { upper: input.chatId === other ? 9 : 80 } } });
      assert.equal(success.chats.length, 2); assert.equal((await runtime.list(ctx)).checkpoint.cursor, 80);
      assert.equal(state(current(ctx).storage, { channelId: "bot", chatId: other }).cursor, 9);
    });
    await check("concurrent instance retry keeps the first committed cutover", async () => {
      let release, entered; const waiting = new Promise(resolve => { entered = resolve; });
      const scoped = { ...ctx, message: {}, input: { action: "startFromNow", requestKey: "concurrent-instance" }, api: { ...ctx.api,
        sources: async input => input.action === "scopes" ? { scopes: [{ chatId }] } : { upper: 81 } } };
      const delayed = runtime.manage({ ...scoped, api: { ...scoped.api, sources: async input => {
        if (input.action === "scopes") { entered(); await new Promise(resolve => { release = resolve; }); return { scopes: [{ chatId }] }; }
        return { upper: 82 };
      } } });
      await waiting; const first = await runtime.manage(scoped); release(); const retry = await delayed;
      assert.deepEqual(retry, first); assert.equal((await runtime.list(ctx)).checkpoint.cursor, 81);
    });
    console.log(`Memory standalone: ${passed}/${passed} plugin policy checks passed; host API doubles, real plugin SQLite, no host checkout.`);
  } finally {
    Date.now = realNow; close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith("openbot-memory-standalone-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
