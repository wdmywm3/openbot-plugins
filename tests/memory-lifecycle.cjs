"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), zlib = require("node:zlib"), crypto = require("node:crypto");
const host = path.resolve(process.env.OPENBOT_HOST_ROOT || path.join(__dirname, "../../openbot"));
const fromHost = require("node:module").createRequire(path.join(host, "package.json"));
const { createContextPaths } = fromHost("./electron/lib/context/context-paths.cjs");
const { createChannelStorageRepository } = fromHost("./electron/lib/context/channel-storage-repository.cjs");
const { createChannelStorageRepository: legacyStorage } = fromHost("./scripts/fixtures/native-memory/context/channel-storage-repository.cjs");
const { createDreamDocuments } = fromHost("./scripts/fixtures/native-memory/features/channels/channel-dream-documents.cjs");
const { exportLegacyMemory } = fromHost("./scripts/export-legacy-memory.cjs");
const { createChannelPluginRuntimeService, shutdownPluginWorkers } = fromHost("./electron/lib/features/channels/channel-plugin-runtime-service.cjs");
const { createPluginAssets } = fromHost("./electron/lib/plugins/plugin-assets.cjs");
const { createPluginDataStore } = fromHost("./electron/lib/plugins/plugin-data-store.cjs");
const { readPluginPackage } = fromHost("./electron/lib/plugins/plugin-package.cjs");
const { pluginPackageHash } = fromHost("./electron/lib/plugins/plugin-authorization.cjs");
const { createSharedModels } = fromHost("./electron/lib/features/retrieval/shared-models.cjs");
const { createVectorCollections } = fromHost("./electron/lib/features/retrieval/vector-collections.cjs");
const { createLocalEmbeddingIndex } = fromHost("./electron/lib/features/retrieval/local-embedding-index.cjs");
const environment = fromHost("./electron/lib/plugins/plugin-environment.cjs"), originalLaunch = environment.resolveLaunch;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-lifecycle-")), dataRoot = path.join(root, "data"), legacyRoot = path.join(root, "legacy");
  const scope = { channelId: "bot", chatId: "onebot:private:u" }, other = { ...scope, channelId: "foreign" };
  let old, storage, runtime, retrieval, postgres, databaseRuntime, dataStore;
  try {
    old = legacyStorage({ fs, paths: createContextPaths({ root: legacyRoot }) });
    const source = { id: "m1", chatId: scope.chatId, direction: "in", createdAt: Date.now(), content: "我平时习惯喝拿铁咖啡。", sender: { id: "u", name: "小林" } };
    old.appendEvent({ id: scope.channelId }, source); await old.flush();
    old.memoryRepository.save(scope, { id: "legacy-fact", content: "平时习惯喝拿铁咖啡", sourceIds: [source.id], createdByUserId: "u" }, 0);
    old.dreamRepository.setDefaults(scope.channelId, { enabled: true });
    await createDreamDocuments({ storage: old }).prepare(scope);
    const original = old.memoryRepository.get(scope, "legacy-fact");
    const runId = old.dreamRepository.runs.start(scope, { trigger: "manual", cutoff: Date.now(), upper: 1 });
    old.dreamRepository.runs.trace(scope, runId, "dream_output", { text: "迁移后仍能读到的运行日志" });
    old.dreamRepository.runs.trace(scope, runId, "dream_input", { text: "长日志分页开头：" + "聊天原文。".repeat(3000) + "长日志分页结尾" });
    old.dreamRepository.runs.change(scope, runId, { memories: 1 });
    old.dreamRepository.runs.finish(scope, runId, "completed");
    const secretRun = old.dreamRepository.runs.start(other, { trigger: "manual", cutoff: Date.now(), upper: 1 });
    old.dreamRepository.runs.trace(other, secretRun, "dream_output", { text: "FOREIGN_INSTANCE_PRIVATE_MATERIAL" });
    old.dreamRepository.runs.finish(other, secretRun, "completed");
    old.setPluginState({ channelId: scope.channelId, pluginId: "__channel_memory__", scope: "chat", scopeId: "onebot:private:legacy", key: "entries", value: [{ id: "pre-sql", content: "更早版本的记忆" }] });
    await old.flush();
    const bundleFile = path.join(root, "export.json"); exportLegacyMemory(legacyRoot, scope.channelId, bundleFile);
    const bundle = JSON.parse(fs.readFileSync(bundleFile, "utf8")), decoded = zlib.gunzipSync(Buffer.from(bundle.data, "base64")).toString("utf8");
    const exported = JSON.parse(decoded);
    assert.doesNotMatch(exported.tables.channel_dream_run_payloads.map(row => Buffer.from(row.data.__bytes, "base64").toString("utf8")).join("\n"), /FOREIGN_INSTANCE_PRIVATE_MATERIAL/);
    assert(exported.legacyEntries.some(item => item.entries[0].content === "更早版本的记忆"));
    assert(exported.tables.channel_documents.some(row => row.artifact_id === original.documentRef.artifactId));
    assert.throws(() => exportLegacyMemory(legacyRoot, scope.channelId, bundleFile), /EEXIST/);
    old.close(); old = null;

    if (process.env.OPENBOT_TEST_POSTGRES === "1") {
      databaseRuntime = await fromHost("./scripts/helpers/database-runtime.cjs").prepareDatabaseRuntime(dataRoot);
      postgres = fromHost("./electron/lib/storage/managed-postgres.cjs").createManagedPostgres({ getRoot: () => dataRoot,
        getRuntime: databaseRuntime.getRuntime, protect: value => ({ test: value }), unprotect: value => value.test });
      await postgres.start();
    }
    storage = createChannelStorageRepository({ fs, paths: createContextPaths({ root: dataRoot }), ...(postgres ? { postgres: () => postgres.connection } : {}) });
    storage.appendEvent({ id: scope.channelId }, source); await storage.flush();
    const loaded = readPluginPackage(path.resolve(__dirname, "../plugins/memory"));
    const plugin = { ...loaded.manifest, id: "memory", basePath: path.resolve(__dirname, "../plugins/memory"), type: "js-plugin", enabled: true, runtimeEnabled: true, config: {} };
    plugin.scriptPath = path.join(plugin.basePath, "index.js"); plugin.packageHash = pluginPackageHash(plugin.basePath);
    const channel = { id: scope.channelId, enabled: true, config: { ownerUsers: ["u"] }, chatSessions: { [scope.chatId]: "session" } };
    const store = { root: dataRoot, data: { channels: [channel], models: [] }, save() {}, async flush() {} }, state = new Map();
    const models = createSharedModels({ root: dataRoot, getDefault: () => "fixture", providers: { fixture: { name: "fixture", dimension: 768, version: "fixture-768", modalities: ["text"], ready: () => true,
      create: () => createLocalEmbeddingIndex(dataRoot, { embed: async () => Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0) }) } } });
    retrieval = { models, vectors: createVectorCollections({ root: dataRoot, models }) };
    environment.resolveLaunch = request => ({ command: process.execPath, args: request.args, runtimeEnv: {}, runtimePath: process.env.PATH });
    let installed = false, idleGenerations = 0;
    const media = createPluginAssets({ root: dataRoot });
    dataStore = createPluginDataStore({ rootFor: () => path.join(dataRoot, "files"), ...(postgres ? { postgres: () => postgres.connection } : {}) });
    runtime = createChannelPluginRuntimeService({ fs, path, store, retrieval, sourceRepository: storage.sourceRepository, pluginAssets: media,
      unifiedMemoryRepository: storage.unifiedMemoryRepository, activityRepository: storage.activityRepository,
      ensureStoreArray: key => store.data[key] || [], resolveChannel: () => channel, botPluginsFor: () => installed ? [plugin] : [],
      makeId: () => crypto.randomUUID(), safeError: error => error.message || String(error), isNapCatOneBotChannel: () => true,
      pluginData: dataStore.background || dataStore,
      getPluginState: (_c, _p, kind, id, key) => state.get(JSON.stringify([kind, id, key])),
      setPluginState: (_c, _p, kind, id, key, value) => state.set(JSON.stringify([kind, id, key]), value),
      pluginStateScopeId: (_c, kind, msg) => kind === "chat" ? msg.chatId : "shared",
      runPluginAgent: async ({ request, executionPrincipal }) => {
        assert.equal(request.usageCategory, "memory"); idleGenerations++;
        assert.equal(executionPrincipal.source, "channel", "scheduled and management jobs receive a scoped, non-owner tool identity");
        assert.equal(executionPrincipal.role, "member");
        const batch = JSON.parse(request.continuation.content), context = { channelPrincipal: executionPrincipal, purpose: "plugin_background" };
        let result = await runtime.runPluginTool({ action: "start", pluginId: "memory", tool: "organize", requestKey: batch.ticket,
          input: { ticket: batch.ticket, operation: "commit", result: { facts: [], topics: [] } } }, context);
        for (let attempt = 0; result.status === "running" && attempt < 100; attempt++) {
          await wait(20); result = await runtime.runPluginTool({ action: "status", pluginId: "memory", tool: "organize", jobId: result.id }, context);
        }
        assert.equal(result.status, "completed", result.error); assert(result.result.ok);
        return { taskId: request.taskId, status: "completed", summary: "已提交本批" };
      },
      generatePluginModel: async ({ request }) => {
        assert.equal(request.usageCategory, "memory", "organization is accounted as memory work");
        idleGenerations++;
        return { modelId: "fixture", text: JSON.stringify({ facts: [], records: [], revisions: [], invalidations: [], outcomes: [], topics: [] }) };
      },
    });
    const principal = { source: "channel", ...scope, senderId: "u", messageType: "private", primaryMessageId: "m1" };
    const messages = [{ role: "system", content: "宿主协议" }, { role: "user", content: "咖啡" }], payload = { messages, inputMessages: [source], requestId: "turn" };
    assert.deepEqual((await runtime.runPluginModelHook(channel, scope.chatId, "beforeModel", payload, principal)).messages, messages, "bot runs without an installed memory plugin");
    installed = true;
    const action = id => plugin.actions.find(item => item.id === id), call = (id, input = {}) => runtime.runPluginAction(channel, plugin, action(id), input);
    const groupPrincipal = { ...principal, chatId: "onebot:group:g", messageType: "group", senderId: "member" };
    assert(!runtime.pluginToolSchemas({ channelPrincipal: groupPrincipal }).some(tool => tool.function.name === "plugin__memory__memory"), "compatibility entry does not duplicate the native memory tool");
    const nativeActor = { ...scope, id: "desktop:owner", permissions: ["memory:read", "memory:write", "memory:manage"], canReadChat: () => true, canAccessOwner: () => true };
    const records = async (chatId = scope.chatId) => (await storage.unifiedMemoryRepository.memory({ ...nativeActor, chatId }, { action: "search", mode: "history", limit: 100 })).items;
    const actor = { channelId: channel.id, pluginId: plugin.id, desktop: true };
    const asset = media.put(actor, fs.readFileSync(bundleFile), { mimeType: "application/json", name: "memory.json" });
    await call("import", { refs: [asset.ref] });
    let page;
    for (let i = 0; i < 150; i++) { page = await call("list", { chatId: scope.chatId }); if (page.jobs.length && page.jobs.every(job => !["running", "queued"].includes(job.status))) break; await wait(20); }
    assert(page.jobs.every(job => job.status === "completed"), JSON.stringify(page.jobs));
    const imported = (await records()).filter(item => item.preview.includes("拿铁"));
    assert(imported.length); assert(imported[0].revision >= original.revision);
    const count = (await records()).length;
    assert.equal(page.settings.enabled, false, "import does not replay the old scheduler");
    assert((await records("onebot:private:legacy")).some(entry => entry.preview.includes("更早版本的记忆")));
    const details = await call("manage", { chatId: scope.chatId, action: "readRun", runId });
    assert(details.events.some(event => event.text.includes("迁移后仍能读到的运行日志")));
    const job = await call("import", { refs: [asset.ref] });
    for (let i = 0; i < 100; i++) { page = await call("list", { chatId: scope.chatId }); if (page.jobs.find(item => item.id === job.id)?.status === "completed") break; await wait(20); }
    assert.equal((await records()).length, count, "reimport is idempotent");
    // Indexing and prompt preparation run through the actual host scope guards.
    await call("process", { chatId: scope.chatId });
    for (let i = 0; i < 100; i++) { page = await call("list", { chatId: scope.chatId }); if (page.jobs.every(item => !["queued", "running"].includes(item.status))) break; await wait(20); }
    // Exercise the real desktop -> native process -> empty-principal background
    // poll -> durable job path; unit contexts with namespace === channelId miss it.
    await call("manage", { action: "settings", settings: { enabled: true, schedule: "daily", dailyTime: "03:00", idleMinutes: 5 } });
    await call("manage", { action: "settings", chatId: scope.chatId, inherit: true });
    await storage.flush();
    // Set actual source timestamps: the host may perform reads on another thread.
    const clockDb = new (require("node:sqlite").DatabaseSync)(createContextPaths({ root: dataRoot }).contextDbFile);
    const observed = clockDb.prepare("SELECT seq,observed_at FROM conversation_source_changes WHERE channel_id=?").all(scope.channelId);
    clockDb.prepare("UPDATE conversation_source_changes SET observed_at=? WHERE channel_id=?").run(Date.now() - 6 * 60000, scope.channelId);
    try {
      await runtime.runPluginPoll(channel, plugin);
      let idlePage;
      for (let i = 0; i < 150; i++) {
        idlePage = await call("list", { chatId: scope.chatId });
        if (idleGenerations > 0 && idlePage.lastRun > 0
          && idlePage.jobs.every(job => !["running", "queued"].includes(job.status))) break;
        await wait(20);
      }
      assert(idleGenerations > 0, "the actual host poll must reach organization's model call");
      assert(idlePage.lastRun > 0, JSON.stringify(idlePage.jobs));
      assert(!idlePage.runs.items.some(run => run.trigger === "idle" && run.status === "completed"), "empty completed idle runs stay out of the user-facing list");
    } finally {
      const restore = clockDb.prepare("UPDATE conversation_source_changes SET observed_at=? WHERE seq=?");
      for (const row of observed) restore.run(row.observed_at, row.seq);
      clockDb.close();
    }
    await call("manage", { action: "settings", settings: { enabled: false } });
    const prompt = await runtime.runPluginModelHook(channel, scope.chatId, "beforeModel", payload, principal);
    const largeImage = { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(3 * 1024 * 1024) } };
    const imageTurn = { role: "user", content: [{ type: "text", text: "咖啡" }, ...Array(12).fill(largeImage)] };
    const largePayload = { ...payload, messages: [...messages, imageTurn] };
    assert(Buffer.byteLength(JSON.stringify(largePayload)) > 32 * 1024 * 1024);
    const largePrompt = await runtime.runPluginModelHook(channel, scope.chatId, "beforeModel", largePayload, principal);
    assert.deepEqual(largePrompt.messages.find(message => Array.isArray(message.content)), imageTurn,
      "real Memory Plus recalls from text without duplicating oversized image bodies into its process or dropping model images");
    assert(prompt.messages.some(message => String(message.content).includes("拿铁")), JSON.stringify(prompt));
    const poked = await runtime.runPluginModelHook(channel, scope.chatId, "beforeModel", { ...payload, inputMessages: [{ ...source, oneBotEvent: { noticeType: "notify", subType: "poke" }, event: { type: "notice", kind: "notify", subtype: "poke" } }] }, principal);
    assert(!poked.messages.some(message => String(message.content).includes("legacy-fact")), "notification-only turns skip automatic recall");
    plugin.enabled = false;
    assert.deepEqual((await runtime.runPluginModelHook(channel, scope.chatId, "beforeModel", payload, principal)).messages, messages);
    plugin.enabled = true;
    assert((await records()).length, "disable preserves host memory independently of the strategy plugin");
    await call("manage", { chatId: scope.chatId, action: "settings", settings: { enabled: true, schedule: "daily", dailyTime: "03:00", idleMinutes: 0 } });
    fs.writeFileSync(path.join(dataRoot, "context/full-data-restore.json"), JSON.stringify({ restoredAt: Date.now() }));
    assert.equal((await call("list", { chatId: scope.chatId })).settings.enabled, false, "restore marker pauses private scheduler state");
    if (process.env.OPENBOT_TEST_MEMORY_UI === "1") await require("./memory-ui.cjs")({ fromHost, runtime, channel, plugin, action, scope, root, legacyRunId: runId });
    console.log("Memory lifecycle: real host SDK/actions/jobs, optional absence, enable/disable, scoped legacy export/import, notes/revisions/journals, repeated import, public prompt injection and restore pause passed");
  } finally {
    await runtime?.pauseForDataSnapshot(); await shutdownPluginWorkers(); environment.resolveLaunch = originalLaunch;
    await retrieval?.vectors.pause(); await retrieval?.models.pause(); await dataStore?.pauseBackground?.(); await storage?.pauseForDataSnapshot?.(); storage?.close(); old?.close(); await postgres?.close(); await databaseRuntime?.components.close();
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("openbot-memory-lifecycle-")) fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
