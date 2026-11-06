"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const host = path.resolve(process.env.OPENBOT_SOURCE || path.join(__dirname, "../../openbot"));
const hostRequire = require("node:module").createRequire(path.join(host, "package.json"));
const { readPluginPackage } = hostRequire("./electron/lib/plugins/plugin-package.cjs");
const { createChannelPluginRuntimeService } = hostRequire("./electron/lib/features/channels/channel-plugin-runtime-service.cjs");
const { createChannelGroupNames } = hostRequire("./electron/lib/features/channels/channel-group-names.cjs");
const { createPluginDataStore } = hostRequire("./electron/lib/plugins/plugin-data-store.cjs");
const { createPluginAssets } = hostRequire("./electron/lib/plugins/plugin-assets.cjs");
const { shutdownPluginWorkers } = hostRequire("./electron/lib/features/channels/plugin-worker-pool.cjs");
const { createSharedModels, MODELS } = hostRequire("./electron/lib/features/retrieval/shared-models.cjs");
const { createVectorCollections } = hostRequire("./electron/lib/features/retrieval/vector-collections.cjs");
const { createLocalEmbeddingIndex } = hostRequire("./electron/lib/features/retrieval/local-embedding-index.cjs");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-meme-plugin-")); let runtime, retrieval;
  try {
    const loaded = readPluginPackage(path.join(__dirname, "../plugins/meme-library"));
    const plugin = { ...loaded.manifest, id: "meme-library", enabled: true, runtimeEnabled: true, type: "js-plugin", basePath: loaded.basePath || path.join(__dirname, "../plugins/meme-library"),
      scriptPath: path.join(__dirname, "../plugins/meme-library/index.js"), config: {}, permissions: loaded.manifest.permissions };
    const channel = { id: "test", enabled: true, config: { agentId: "test-profile", provider: "napcat-onebot", selfId: "10000" },
      chatSessions: { "onebot:group:123456": "session", "onebot:group:876543": "other-session" } };
    const store = { root, data: { channels: [channel], models: [{ id: "vision", name: "Vision", imageEnabled: true }],
      sessions: [{ id: "session", title: "群 123456" }, { id: "other-session", title: "群 876543" }] }, save() {} };
    let groupListCalls = 0;
    const groupNames = createChannelGroupNames({ store, runtimeChannel: value => value, oneBot: {
      isRunning: () => true, async call() { groupListCalls++; return { data: [
        { group_id: 123456, group_name: "表情交流群" }, { group_id: 876543, group_name: "表情交流群" }] }; },
    } });
    const media = createPluginAssets({ root }), actor = { channelId: channel.id, pluginId: plugin.id, desktop: true };
    const bytes = await hostRequire("sharp")({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
    const asset = media.put(actor, bytes, { mimeType: "image/png", name: "fixture.png" });
    const state = new Map(), vectors = Array(768).fill(0); vectors[0] = 1;
    let generated = 0, engineAvailable = true;
    const models = createSharedModels({ root, providers: { "embeddinggemma-2": { ...MODELS[0],
      ready: () => engineAvailable,
      async install() { if (!engineAvailable) throw Error("model unavailable"); },
      create: () => createLocalEmbeddingIndex(root, { embed: async () => { if (!engineAvailable) throw Error("model unavailable"); return vectors; } }),
    } } });
    retrieval = { models, vectors: createVectorCollections({ root, models }) };
    const picker = { release: null };
    runtime = createChannelPluginRuntimeService({ fs, path, store, retrieval, groupNames, ensureStoreArray: key => store.data[key] || [],
      selectPluginFiles: () => new Promise(resolve => { picker.release = resolve; }),
      resolveChannel: () => channel, botPluginsFor: () => [plugin], makeId: () => Math.random().toString(), safeError: String,
      getPluginState: (_channel, _plugin, scope, scopeId, key) => state.get(JSON.stringify([scope, scopeId, key])),
      setPluginState: (_channel, _plugin, scope, scopeId, key, value) => state.set(JSON.stringify([scope, scopeId, key]), value),
      pluginStateScopeId: (_channel, scope, msg) => scope === "chat" ? msg.chatId : "shared", isNapCatOneBotChannel: () => true,
      pluginData: createPluginDataStore({ rootFor: () => path.join(root, "data") }),
      generatePluginModel: async ({ request }) => { generated++; assert.equal(request.attachments[0].mimeType, "image/jpeg"); return { text: JSON.stringify({ caption: "蓝色方块", meaning: "冷静", tags: ["冷静"] }), modelId: "vision" }; },
      pluginTools: { call: async args => {
        const input = args.input.arguments;
        assert(!["status", "install", "embed"].includes(input.action), "media engine never owns inference");
        const result = input.action === "has" ? { present: true } : input.action === "prepare" ? { mimeType: "image/jpeg", data: bytes.toString("base64") } : {};
        return { structuredContent: result };
      }, list: async () => ({ tools: [] }) },
    });
    const action = id => plugin.actions.find(a => a.id === id);
    await runtime.runPluginAction(channel, plugin, action("import"), { refs: [asset.ref] });
    let page;
    for (let attempt = 0; attempt < 120; attempt++) {
      page = await runtime.runPluginAction(channel, plugin, action("list"), {});
      if (page.jobs.every(job => !["queued", "running"].includes(job.status))) break;
      await wait(20);
    }
    page = await runtime.runPluginAction(channel, plugin, action("list"), {});
    assert.equal(page.items[0]?.indexStatus, "ready", JSON.stringify(page.jobs)); assert.equal(generated, 1);
    assert.equal(page.models[0].id, "vision"); assert(page.contexts.profiles.length);
    assert.deepEqual(page.contexts.chats, [{ id: "onebot:group:123456", name: "表情交流群（123456）" },
      { id: "onebot:group:876543", name: "表情交流群（876543）" }], "management labels include both group names and numbers, even for duplicate names");
    assert.equal(groupListCalls, 1, "plugin list refreshes reuse cached group names");
    const context = { channelPrincipal: { source: "channel", channelId: channel.id, chatId: "onebot:group:123456", messageType: "group", senderId: "user" } };
    const originalMessages = [{ role: "system", content: "host protocol" }, { role: "user", content: "hello" }];
    const prompt = await runtime.runPluginModelHook(channel, context.channelPrincipal.chatId, "beforeModel", { messages: originalMessages, requestId: "turn" }, context.channelPrincipal);
    assert.equal(prompt.messages[1].role, "system"); assert.match(prompt.messages[1].content, /stickers/);
    assert.equal(prompt.messages.at(-1).role, "user"); assert.match(prompt.messages.at(-1).content, /主动使用倾向/);
    assert.equal(prompt.contextRecords.length, 1, "availability is a durable context record");
    const repeated = await runtime.runPluginModelHook(channel, context.channelPrincipal.chatId, "beforeModel", { messages: prompt.messages, requestId: "next-turn" }, context.channelPrincipal);
    assert.equal(repeated.contextRecords?.length || 0, 0, "the same availability is not appended twice");
    assert.equal(originalMessages.length, 2, "preparation never mutates source history");
    // Long-running group chats retain images in model context. The availability
    // hook needs metadata only; this media volume used to exhaust its worker.
    const inline = { type: "image_url", image_url: { url: "data:image/gif;base64," + "A".repeat(3 * 1024 * 1024) } };
    const mediaMessage = { role: "user", content: [{ type: "text", text: "聊天里累计的图片" }, ...Array(24).fill(inline)] };
    const mediaPrompt = await runtime.runPluginModelHook(channel, context.channelPrincipal.chatId, "beforeModel",
      { messages: [...originalMessages, mediaMessage], requestId: "large-media-turn" }, context.channelPrincipal);
    assert.match(mediaPrompt.messages[1].content, /stickers/);
    assert.match(mediaPrompt.messages.at(-1).content, /主动使用倾向/);
    const retained = mediaPrompt.messages.find(message => Array.isArray(message.content));
    assert.deepEqual(retained, mediaMessage, "the model retains all 72 MiB of image input while the plugin prepares availability");
    let found = await runtime.runNativePluginTool("qqSticker", { action: "search", query: "冷静" }, context);
    for (let n = 0; n < 100 && found.status === "running"; n++) { await wait(20); found = await runtime.runPluginTool({ action: "status", pluginId: plugin.id, jobId: found.id }, context); }
    assert.equal(found.status, "completed", found.error); assert.equal(found.result.candidates.length, 1);
    assert(found.userContextBlocks.some(block => block.type === "image_url"), "native tool image references become model-visible previews");
    const url = found.result.candidates[0].url, segments = [{ type: "image", data: { file: url } }];
    const resolved = await runtime.resolvePluginMedia(channel, context.channelPrincipal.chatId, segments);
    assert.equal(resolved[0].data.file, "base64://" + bytes.toString("base64")); assert.equal(resolved[0].data.sub_type, 1);
    await assert.rejects(runtime.resolvePluginMedia(channel, "onebot:group:other", segments), /不可用/);
    if (process.env.OPENBOT_TEST_MEME_UI === "1") await require("./meme-ui.cjs")({ hostRequire, runtime, channel, plugin, action, media, actor, root, picker });
    engineAvailable = false;
    const secondBytes = await hostRequire("sharp")({ create: { width: 33, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
    const second = media.put(actor, secondBytes, { mimeType: "image/png", name: "offline.png" });
    await runtime.runPluginAction(channel, plugin, action("import"), { refs: [second.ref] });
    for (let n = 0; n < 200; n++) {
      page = await runtime.runPluginAction(channel, plugin, action("list"), {});
      if (page.items.find(item => item.id === second.sha256)?.indexStatus === "fallback"
        && page.jobs.every(job => !["running", "queued"].includes(job.status))) break;
      await wait(20);
    }
    assert.equal(page.items.find(item => item.id === second.sha256).indexStatus, "fallback", JSON.stringify({ items: page.items, jobs: page.jobs }));
    assert.equal(page.retrievalStatus.mode, "bm25"); assert.equal(page.counts.searchable, 2);
    engineAvailable = true;
    await runtime.runPluginAction(channel, plugin, action("update"), {});
    for (let n = 0; n < 200; n++) {
      page = await runtime.runPluginAction(channel, plugin, action("list"), {});
      if (page.counts.ready === 2 && page.jobs.every(job => !["running", "queued"].includes(job.status))) break;
      await wait(20);
    }
    assert.equal(page.counts.ready, 2); assert.equal(page.retrievalStatus.mode, "semantic");
    const preparedAnalysis = require("../personas/xixi-sticker-analysis.json").stickers[0].analysis;
    store.data.channelAgents = [{ id: "own", name: "角色", enabled: true,
      stickers: Array.from({ length: 105 }, (_, i) => ({ id: `role-${i}`, name: `角色 ${i}`, description: "角色冷静", tags: ["冷静"],
        metadata: { "meme-library": { schemaVersion: 1, analysis: preparedAnalysis } },
        enabled: true, contentHash: asset.sha256, mimeType: "image/png" })) }];
    channel.config.agentId = "channel-agent:own";
    let lastTick = Date.now(), maxGap = 0;
    const heartbeat = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - lastTick); lastTick = now; }, 10);
    try {
      await runtime.notifyPluginProfilesChanged("channel-agent:own");
      for (let n = 0; n < 1200; n++) {
        page = await runtime.runPluginAction(channel, plugin, action("list"), { source: "profile", profileId: "channel-agent:own" });
        if (page.total === 105 && page.jobs.every(job => !["running", "queued"].includes(job.status))) break;
        await wait(20);
      }
      assert.equal(page.total, 105, JSON.stringify(page.jobs));
      assert(page.items.every(item => item.meaning === preparedAnalysis.meaning), "media metadata reaches the plugin through the public host interface");
      assert(page.items.every(item => item.profileIds.includes("channel-agent:own")), "role media is synchronized with its role scope");
      assert(maxGap < 500, `role synchronization blocked the host for ${maxGap} ms`);
      let own = await runtime.runNativePluginTool("qqSticker", { action: "search", query: "冷静" }, context);
      for (let n = 0; n < 100 && own.status === "running"; n++) { await wait(20); own = await runtime.runPluginTool({ action: "status", pluginId: plugin.id, jobId: own.id }, context); }
      assert.equal(own.status, "completed", own.error);
      assert(own.result.candidates.some(item => item.roleSticker), "retrieved role stickers are identified to the model");
      const rebuild = await runtime.runPluginAction(channel, plugin, action("update"), {});
      let rebuildState;
      for (let n = 0; n < 1800; n++) {
        page = await runtime.runPluginAction(channel, plugin, action("list"), { source: "profile", profileId: "channel-agent:own" });
        rebuildState = page.jobs.find(item => item.id === rebuild.id);
        if (rebuildState && !["running", "queued"].includes(rebuildState.status)) break;
        await wait(20);
      }
      assert.equal(rebuildState?.status, "completed", JSON.stringify(rebuildState));
      assert.equal(rebuildState.progress?.completed, 107, "reindexing visits every role and ordinary sticker");
      assert.equal(page.total, 105, "reindexing a large library retains all role stickers");
      assert(maxGap < 500, `role indexing blocked the host for ${maxGap} ms`);
    } finally { clearInterval(heartbeat); }
    plugin.enabled = false;
    const inactive = await runtime.runPluginModelHook(channel, context.channelPrincipal.chatId, "beforeModel", { messages: originalMessages }, context.channelPrincipal);
    assert.deepEqual(inactive.messages, originalMessages, "disabled plugins leave neither stable instructions nor runtime hints in new requests");
    await assert.rejects(runtime.resolvePluginMedia(channel, context.channelPrincipal.chatId, segments), /不可用/);
    assert.deepEqual(media.readPublished(url).data, bytes);
    console.log("Meme plugin host integration: actual VM, 72 MiB model media without worker exhaustion, persistent SQLite/jobs, image preparation, model result previews and scoped/revoked outbound references passed");
  } finally {
    await runtime?.pauseForDataSnapshot(); shutdownPluginWorkers();
    await retrieval?.models.pause(); await retrieval?.vectors.pause();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith("openbot-meme-plugin-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
