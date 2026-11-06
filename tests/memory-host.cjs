"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const host = path.resolve(process.env.OPENBOT_HOST_ROOT || path.join(__dirname, "../../openbot"));
const { createPluginProcessRuntime } = require(path.join(host, "electron/lib/plugins/plugin-process.cjs"));
const { createConversationSourceRepository } = require(path.join(host, "electron/lib/context/conversation-source-repository.cjs"));
const { createPluginSources } = require(path.join(host, "electron/lib/plugins/plugin-sources.cjs"));
const { createPluginRetrieval } = require(path.join(host, "electron/lib/plugins/plugin-retrieval.cjs"));
const { createSharedModels } = require(path.join(host, "electron/lib/features/retrieval/shared-models.cjs"));
const { createLocalEmbeddingIndex } = require(path.join(host, "electron/lib/features/retrieval/local-embedding-index.cjs"));
const { createVectorCollections } = require(path.join(host, "electron/lib/features/retrieval/vector-collections.cjs"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-plugin-")), packageRoot = path.resolve(__dirname, "../plugins/memory");
let processRuntime, models, vectors, db;
const watchdog = setTimeout(() => { throw Error("Memory plugin integration timed out"); }, 90000);
(async () => {
  try {
    db = new DatabaseSync(path.join(root, "host.sqlite"));
    db.exec("CREATE TABLE channel_events(channel_id TEXT,chat_id TEXT,event_id TEXT,event_encoding TEXT,event_json BLOB,search_text TEXT,searchable INTEGER,sender_id TEXT,created_at INTEGER,PRIMARY KEY(channel_id,chat_id,event_id))");
    const sources = createConversationSourceRepository(db), reads = createPluginSources({ repository: sources });
    const chatId = "onebot:private:u", scope = { channelId: "one", chatId };
    const memories = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs")).createUnifiedMemoryRepository(db, { source: (scope, id) => sources.get(scope, id) });
    const memoryActor = { ...scope, id: "plugin:memory", permissions: ["memory:read", "memory:write", "memory:manage", "memory:forget"], explicitRemember: true };
    const put = (id, content) => db.prepare("INSERT OR REPLACE INTO channel_events VALUES(?,?,?,?,?,?,?,?,?)").run(scope.channelId, chatId, id, "json",
      JSON.stringify({ id, chatId, content, direction: "in", source: "chat", createdAt: Date.now(), sender: { id: "u", name: "小林" } }), content, 1, "u", Date.now());
    put("m1", "我喜欢喝拿铁咖啡。");
    models = createSharedModels({ root, getDefault: () => "fixture", providers: { fixture: { name: "fixture", version: "test-768", dimension: 768,
      modalities: ["text"], ready: () => true, create: () => createLocalEmbeddingIndex(root, { embed: async input => Array.from({ length: 768 }, (_, i) => i === (/拿铁|咖啡|饮品/.test(input.text) ? 0 : 1) ? 1 : 0) }) } } });
    vectors = createVectorCollections({ root, models });
    const retrieval = createPluginRetrieval({ retrieval: { models, vectors } });
    processRuntime = createPluginProcessRuntime({ storeRoot: root, resolveLaunch: request => ({ command: process.execPath, args: request.args, runtimeEnv: {}, runtimePath: process.env.PATH }) });
    const raw = require(path.join(packageRoot, "plugin.json")), manifest = raw.extensions["com.openbot"];
    const plugin = { id: "memory", basePath: packageRoot, packageHash: "test-package", permissions: manifest.permissions, dependencies: manifest.dependencies, execution: manifest.execution };
    let generationStarted, finishGeneration, gate, generated = 0;
    const started = new Promise(resolve => { generationStarted = resolve; });
    gate = new Promise(resolve => { finishGeneration = resolve; });
    function context(input = {}, extra = {}) { return { input, config: {}, plugin: { id: "memory", namespace: "one" },
      principal: { source: "channel", channelId: "one", chatId, senderId: "u", role: "owner" },
      message: { id: "m1", chatId, content: "我喜欢喝拿铁咖啡。", sender: { id: "u", name: "小林" } }, ...extra }; }
    function run(exportName, ctx, timeout = 15000) {
      const actor = { ...scope, pluginId: "memory" }, principal = { actor, requirePermission(permission) { assert(manifest.permissions.includes(permission)); }, signal: new AbortController().signal };
      return processRuntime.run({ channelId: "one", plugin, context: ctx, executionTimeoutMs: timeout, exportName, api: {
        getCapabilities: async () => ({ features: { unifiedMemory: true, persistentContextItems: true, visibleContextItems: true, sourceHead: true } }),
        memory: input => memories.memory(memoryActor, input), memorySpace: input => memories.memorySpace(memoryActor, input),
        sources: input => reads({ channelId: "one", chatId: input.chatId || chatId }, input),
        embeddings: input => retrieval.embeddings(principal, input), vectorIndex: input => retrieval.vectorIndex(principal, input),
        runAgent: async request => {
          generated++; generationStarted(); await gate;
          const batch = JSON.parse(request.continuation.content);
          const invoke = input => run("organize", context({ ticket: batch.ticket, ...input }));
          await invoke({ operation: "search", query: "拿铁咖啡" });
          const source = batch.messages.find(item => item.text.includes("喜欢喝拿铁咖啡"));
          await invoke({ operation: "commit", result: { facts: source ? [{ content: "用户平时喜欢喝咖啡", kind: "fact",
            evidence: [{ id: source.id, quote: "喜欢喝拿铁咖啡" }] }] : [], topics: [] } });
          return { taskId: request.taskId, status: "completed", summary: "已提交" };
        },
        jobs: async () => ({ jobs: [] }), generate: async input => {
          generated++; generationStarted(); await gate;
          const payload = JSON.parse(input.prompt);
          return { modelId: "fixture", text: JSON.stringify({ facts: [{ content: "用户平时喜欢喝咖啡", kind: "fact", sourceIds: ["m1"], evidence: [{ id: "m1", quote: "喜欢喝拿铁咖啡" }] }],
            topics: [], revisions: [], invalidations: [], records: [], outcomes: (payload.candidates || []).map(entry => ({ id: entry.id, revision: entry.revision, outcome: "not_used", evidenceRefs: [] })) }) };
        },
      } });
    }
    const saved = await run("memory", context({ action: "remember", content: "平时喜欢喝拿铁咖啡" }));
    assert.equal(saved.ok, true); assert(memories.memory(memoryActor, { action: "read", id: saved.id }).item.sources.some(ref => ref.id === "m1"));
    await run("process", context());
    put("m2", "你还记得我平时爱喝哪种饮品吗？");
    const before = context({}, { message: { id: "m2", chatId, content: "你还记得我平时爱喝哪种饮品吗？", sender: { id: "u" } }, hook: { requestId: "turn", messages: [] } });
    const contribution = await run("beforeModel", before);
    assert(contribution.systemPromptAppend.includes("memory"));
    assert(contribution.contextItems.some(entry => entry.memory?.id === saved.id), "real process uses host semantic index for nonliteral recall");
    assert(JSON.stringify(contribution.contextItems).length <= 4000);
    await run("replyDelivered", context({}, { hook: { requestId: "turn", answerMessageId: "a1", sessionId: "session", text: "你喜欢拿铁咖啡。" } }));
    await run("afterModel", context());
    await run("manage", context({ action: "settings", settings: { enabled: true, schedule: "daily", dailyTime: "03:00", idleMinutes: 0 } }));
    const processing = run("process", context({ dream: true, trigger: "manual" }), 45000);
    await started;
    const listing = await run("list", context(), 3000);
    assert(listing.busy, "foreground management remains available while Dream waits for a model");
    finishGeneration(); await processing;
    assert(generated > 0);
    const after = await run("list", context());
    const runs = after.runs.runs || after.runs.items || after.runs;
    assert(Array.isArray(runs) && runs.length);
    const plan = await run("manage", context({ action: "rollbackPreview", runId: runs[0].id }));
    assert(plan.token, "native plugin retains rollback preview and version guard");
    await run("manage", context({ action: "rollback", runId: runs[0].id, token: plan.token }));
    assert(memories.memory(memoryActor, { action: "read", id: saved.id }).item, "rolling back Dream preserves a manually written fact");
    db.prepare("DELETE FROM channel_events WHERE event_id='m1'").run();
    const revoked = await run("beforeModel", before);
    assert(!revoked.contextItems.some(entry => entry.memory?.id === saved.id), "deleted evidence is revoked before injection");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='channel_memories'").get().n, 0, "host source storage never creates a memory business table");
    await processRuntime.stop();
    console.log("Memory plugin: real managed Node process, shared vector recall, scoped source changes, prompt contributions, concurrent Dream/management, delivered-use receipts, rollback and deleted-source revocation passed");
  } finally {
    clearTimeout(watchdog); await processRuntime?.stop(); await models?.pause(); await vectors?.pause(); db?.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith("openbot-memory-plugin-")); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
