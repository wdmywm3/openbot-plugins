"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const db = new DatabaseSync(":memory:"), repo = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs")).createUnifiedMemoryRepository(db);
const { current, get, put } = require("../plugins/memory/unified-state.cjs"), { close } = require("../plugins/memory/storage.cjs");
const assessment = require("../plugins/memory/unified-assessment.cjs"), runtime = require("../plugins/memory/unified-runtime.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-usage-"));
const scope = { channelId: "bot", chatId: "onebot:private:alice" }, wrong = { ...scope, chatId: "onebot:private:bob" };
const actor = { ...scope, id: "plugin:memory", permissions: ["read", "write", "manage"].map(key => `memory:${key}`) };
let generated = 0, reports = 0, lost = false, restore = "";
const ctx = { dataRoot: root, principal: { ...scope, source: "channel", role: "member", senderId: "alice" }, signal: new AbortController().signal,
  input: { chatId: scope.chatId }, api: {
    getCapabilities: async () => ({ dataRestoreId: restore, features: { memoryUsage: true, unifiedMemory: true, persistentContextItems: true, sourceHead: true, visibleContextItems: true } }),
    memory: async input => {
      if (input.action === "recordUsage") reports++;
      const result = repo.memory({ ...actor, chatId: input.chatId }, input);
      if (input.action === "recordUsage" && lost) throw Error("提交后回执丢失");
      return result;
    }, sources: async () => ({ item: null }),
    generate: async input => { generated++; const candidates = JSON.parse(input.prompt).candidates;
      return { text: JSON.stringify({ outcomes: candidates.map(item => ({ id: item.id, revision: item.revision, outcome: "used", quote: "喜欢拿铁" })), maintenance: [] }) }; },
  } };
(async () => {
  try {
    const { storage } = current(ctx), item = repo.memory(actor, { action: "create", requestKey: "note", record: { content: "喜欢拿铁", status: "active" } });
    const scoreKey = `plus:score:${item.id}:${item.revision}`, marker = `plus:usage-synced:${item.id}:${item.revision}`;
    put(storage, scoreKey, { selected: 4, used: 3, misapplied: 1 });
    await assessment.syncUsage(ctx, storage, wrong); assert.equal(get(storage, marker), null, "a chat without read authority cannot mark another chat's score synced");
    await assessment.syncUsage(ctx, storage, scope); assert.equal(repo.memory(actor, { action: "read", id: item.id }).item.successfulRecallCount, 3);
    const firstMarker = get(storage, marker), before = reports;
    await assessment.syncUsage(ctx, storage, scope); assert.equal(reports, before); assert.equal(generated, 0, "old private scores migrate without calling a model");
    const turnKey = `plus:turn:${scope.chatId}:answer`;
    put(storage, turnKey, { delivered: true, answerMessageId: "answer", memories: [{ id: item.id, revision: item.revision }] });
    storage.db.prepare("INSERT INTO plugin_answers VALUES(?,?,?)").run(scope.chatId, "answer", "你喜欢拿铁");
    lost = true; assert.equal((await assessment.assess(ctx, storage, scope)).assessed, 1);
    assert.equal(get(storage, turnKey).assessed, true); assert.equal(get(storage, marker), firstMarker);
    assert.equal(repo.memory(actor, { action: "read", id: item.id }).item.successfulRecallCount, 4);
    await assessment.assess(ctx, storage, scope); assert.equal(generated, 1, "a reporting failure never repeats an already committed model assessment");
    lost = false; await assessment.syncUsage(ctx, storage, scope);
    assert.notEqual(get(storage, marker), firstMarker); assert.equal(repo.memory(actor, { action: "read", id: item.id }).item.successfulRecallCount, 4, "a lost receipt retry does not double count usage");
    put(storage, `plus:usage-cursor:${scope.chatId}`, "some-old-key");
    restore = "restored-copy"; await runtime.initialize(ctx);
    assert.equal(get(storage, marker), null); assert.equal(get(storage, `plus:usage-cursor:${scope.chatId}`), null, "restore invalidates both reporting checkpoints");
    assert.deepEqual(get(storage, scoreKey), { selected: 5, used: 4, misapplied: 1, updatedAt: get(storage, scoreKey).updatedAt });
    await assessment.syncUsage(ctx, storage, scope); assert(get(storage, marker));
    assert.equal(repo.memory(actor, { action: "read", id: item.id }).item.successfulRecallCount, 4);
    console.log("Memory usage sync: legacy counts, cross-chat authority, idempotent receipt retry, no repeated assessment, and restore invalidation passed.");
  } finally { close(); db.close(); assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith("openbot-memory-usage-")); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
