"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const { createUnifiedMemoryRepository } = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs"));
const { open, close } = require("../plugins/memory/storage.cjs");
const { migrate } = require("../plugins/memory/unified-migration.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-unified-")), db = new DatabaseSync(path.join(root, "host.sqlite"));
const scope = { channelId: "bot", chatId: "onebot:private:owner" };
const actor = { ...scope, id: "plugin:memory", permissions: ["read", "write", "manage", "forget"].map(name => `memory:${name}`) };
const repo = createUnifiedMemoryRepository(db);
const storage = open(path.join(root, "plugin"));
const ctx = { dataRoot: path.join(root, "plugin"), message: { chatId: scope.chatId }, principal: { channelId: scope.channelId }, signal: new AbortController().signal,
  api: { memory: async ({ chatId, ...input }) => repo.memory(actor, input), sources: async () => ({ item: null }) } };
(async () => {
  try {
    const first = storage.memoryRepository.save(scope, { id: "old", content: "旧正文", source: "manual", revision: 1 }, 0);
    const runId = storage.dreamRepository.runs.start(scope, { trigger: "manual", cutoff: Date.now(), upper: 0 });
    storage.dreamRepository.rollback.track(scope, runId, () => storage.memoryRepository.save(scope, { ...first, content: "修改后的正文" }, first.revision));
    storage.dreamRepository.runs.finish(scope, runId, "completed");
    const body = "手写完整正文🙂\n".repeat(5000);
    const operation = storage.documentService.queue({ ...scope, ownerId: "host" }, { artifactId: "manual-note", relativePath: "notes/manual.md",
      kind: "note", title: "手写内容", content: body, expectedHash: "new", sourceIds: [] });
    await storage.documentService.apply(operation.opId);
    storage.memoryRepository.save(scope, { id: "erased-fact", content: "遗忘的摘要", sourceIds: ["erased-source"] }, 0);
    const erasedFile = storage.documentService.queue({ ...scope, ownerId: "host" }, { artifactId: "erased-file", relativePath: "notes/erased.md",
      kind: "fact", title: "遗忘记录的文件", content: "遗忘记录的完整文件，不应成为独立笔记", expectedHash: "new", sourceIds: [] });
    await storage.documentService.apply(erasedFile.opId);
    const erasedHash = storage.db.prepare("SELECT target_hash FROM channel_document_writes WHERE op_id=?").get(erasedFile.opId).target_hash;
    storage.documentService.queue({ ...scope, ownerId: "host" }, { artifactId: "erased-file", relativePath: "notes/erased.md",
      kind: "fact", title: "已遗忘记录的待写回修改", content: "尚未写回的遗忘内容也不能重新导入", expectedHash: erasedHash, sourceIds: [] });
    storage.db.prepare("UPDATE channel_memories SET entry_json=json_set(entry_json,'$.documentRef',json(?)) WHERE channel_id=? AND chat_id=? AND id='erased-fact'")
      .run(JSON.stringify({ artifactId: "erased-file", ownerId: "host", relativePath: "notes/erased.md" }), scope.channelId, scope.chatId);
    storage.db.prepare("INSERT INTO channel_memory_exclusions VALUES(?,?,?,?)").run(scope.channelId, scope.chatId,
      require("../plugins/memory/storage.cjs").hash("遗忘的摘要"), JSON.stringify(["erased-source"]));
    const result = await migrate(ctx, storage, scope); assert.equal(result.migrated, 2);
    const memories = repo.memory(actor, { action: "search", mode: "history" }).items;
    const fact = memories.find(item => item.preview === "修改后的正文"), note = memories.find(item => item.preview.startsWith("手写完整正文"));
    assert(fact && note); assert.equal(note.kind, "experience");
    assert.equal(repo.memory(actor, { action: "read", id: fact.id }).item.content, "修改后的正文", "legacy zero timestamps mean unspecified, not expired");
    assert.equal(repo.memory(actor, { action: "read", id: fact.id, revision: 1 }).item.content, "旧正文");
    let offset = 0, full = "";
    do { const page = repo.memory(actor, { action: "read", id: note.id, revision: note.revision, offset, limit: 32000 }).item;
      full += page.content; offset = page.nextOffset; } while (offset !== null);
    assert.equal(full, body.trim());
    assert.deepEqual(await migrate(ctx, storage, scope), result);
    assert.equal(repo.memory(actor, { action: "search", mode: "history" }).items.length, 2);
    assert(fs.existsSync(path.join(result.backupFolder, "legacy-memory.sqlite")));
    assert.equal(storage.memoryRepository.get(scope, "old").content, "修改后的正文");
    const runtime = require("../plugins/memory/unified-runtime.cjs");
    ctx.input = { action: "rollbackPreview", runId }; const preview = await runtime.manage(ctx);
    assert(preview.token, JSON.stringify(preview)); assert.equal(preview.changes[0].beforeRevision, 1);
    ctx.input = { action: "rollback", runId, token: preview.token };
    const memoryApi = ctx.api.memory; let lostRollbackReceipt = false;
    ctx.api.memory = async input => { const value = await memoryApi(input);
      if (input.action === "batch" && input.requestKey.startsWith("rollback:") && !lostRollbackReceipt) { lostRollbackReceipt = true; throw Error("rollback response lost"); }
      return value;
    };
    await assert.rejects(runtime.manage(ctx), /rollback response lost/);
    await runtime.manage(ctx);
    assert.equal(repo.memory(actor, { action: "read", id: fact.id }).item.content, "旧正文");
    assert.equal((await runtime.manage(ctx)).alreadyRolledBack, true);
    assert.equal(storage.db.prepare("SELECT 1 FROM plugin_meta WHERE key=?").get(`plus:rollback:${scope.chatId}:${runId}`), undefined, "reconciled rollback removes its saved operation bodies");
    assert.equal(storage.memoryRepository.get(scope, "old").content, "修改后的正文", "compensation never writes back to the legacy body");
    const collisionScope = { ...scope, chatId: "onebot:private:collision" }, collisionActor = { ...actor, chatId: collisionScope.chatId };
    storage.memoryRepository.save(collisionScope, { id: "same-id", content: "旧事实", source: "manual" }, 0);
    storage.memoryRepository.save(collisionScope, { id: "corrected-fact", content: "新事实", source: "manual", changeType: "correction", supersedes: { id: "same-id", revision: 1 } }, 0);
    storage.dreamRepository.saveRecord(collisionScope, { id: "same-id", kind: "goal", content: "独立目标", status: "active", source: "manual" }, 0);
    storage.dreamRepository.saveRecord(collisionScope, { id: "next-goal", kind: "goal", content: "目标进展", status: "active", source: "manual", relatedIds: ["same-id"] }, 0);
    await migrate({ ...ctx, message: { chatId: collisionScope.chatId }, api: { ...ctx.api,
      memory: async ({ chatId, ...input }) => repo.memory(collisionActor, input) } }, storage, collisionScope);
    const migrated = repo.memory(collisionActor, { action: "search", mode: "history" }).items;
    const oldFact = migrated.find(item => item.preview === "旧事实"), newFact = migrated.find(item => item.preview === "新事实");
    const oldGoal = migrated.find(item => item.preview === "独立目标"), nextGoal = migrated.find(item => item.preview === "目标进展");
    assert.equal(newFact.relations[0].id, oldFact.id, "old fact IDs and matter IDs belong to different namespaces");
    assert.equal(nextGoal.relations[0].id, oldGoal.id);
    const plain = repo.memory(actor, { action: "create", requestKey: "rollback-kind", record: { content: "普通事实", kind: "fact", status: "active" } });
    repo.memory(actor, { action: "revise", id: plain.id, expectedRevision: 1, requestKey: "kind-change", changeType: "edit",
      patch: { kind: "matter", subtype: "goal", progress: "active", activityId: "old-activity" } });
    const kindRun = storage.dreamRepository.runs.start(scope, { trigger: "manual", cutoff: Date.now(), upper: 0 });
    require("../plugins/memory/unified-state.cjs").put(storage, `plus:undo:${scope.chatId}:${kindRun}`, [{ id: plain.id, beforeRevision: 1, afterRevision: 2 }]);
    ctx.input = { action: "rollbackPreview", runId: kindRun }; const kindPreview = await runtime.manage(ctx);
    ctx.input = { action: "rollback", runId: kindRun, token: kindPreview.token }; await runtime.manage(ctx);
    const restoredKind = repo.memory(actor, { action: "read", id: plain.id }).item;
    assert.equal(restoredKind.kind, "fact"); assert.equal(restoredKind.progress, null); assert.equal(restoredKind.subtype, null); assert.equal(restoredKind.activityId, null);
    console.log("Unified memory migration: full standalone document, old revisions, zero timestamps, stable mapping, repeat import and preserved backup passed.");
  } finally {
    close(); db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("openbot-memory-unified-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
