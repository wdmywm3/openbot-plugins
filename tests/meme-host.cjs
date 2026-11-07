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
function startMemeEngine(root) {
  const { spawn } = require("node:child_process"), readline = require("node:readline");
  const child = spawn(process.execPath, [path.join(__dirname, "../plugins/meme-library/engine/server.cjs"), root], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  let serial = 0; const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line), entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(Error(message.error.message)); else entry.resolve(message.result);
  });
  child.on("exit", () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error("image process exited")); } pending.clear(); });
  return { call(input) { return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error("image process timed out")); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "sticker_engine", arguments: input } }) + "\n");
  }); }, close() { child.stdin.end(); } };
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-meme-plugin-")); let runtime, retrieval, textEngine;
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
    let generated = 0, engineAvailable = true, useTextEngine = false;
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
      generatePluginModel: async ({ request }) => { generated++; assert(request.attachments[0].mimeType === "image/jpeg" || request.attachments[0].assetRef); return { text: JSON.stringify({ caption: "蓝色方块", meaning: "冷静", tags: ["冷静"] }), modelId: "vision" }; },
      pluginTools: { call: async args => {
        const input = args.input.arguments;
        assert(!["status", "install", "embed"].includes(input.action), "media engine never owns inference");
        if (useTextEngine && ["has", "put", "renderText"].includes(input.action)) return textEngine.call(input);
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
    assert.equal(prompt.messages.at(-1).role, "user"); assert.match(prompt.messages.at(-1).content, /图文混合中的表情/);
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
    assert.match(mediaPrompt.messages.at(-1).content, /图文混合中的表情/);
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

    textEngine = startMemeEngine(path.join(root, "real-image-engine")); useTextEngine = true;
    const beforeTemplate = await runtime.runPluginAction(channel, plugin, action("detail"), { id: asset.sha256 });
    const template = { version: 1, rect: { x: .1, y: .1, width: .8, height: .8 }, color: "#ff0000", align: "center", maxFontSize: .15 };
    await runtime.runPluginAction(channel, plugin, action("save"), { id: asset.sha256, revision: beforeTemplate.revision, textTemplate: template,
      enabled: true, roleProfileId: "", profileIds: [], chatMode: "all", chatIds: [] });
    const waitTool = async (input, principal = context) => {
      let result = await runtime.runNativePluginTool("qqSticker", input, principal);
      for (let n = 0; n < 500 && result.status === "running"; n++) { await wait(20); result = await runtime.runPluginTool({ action: "status", pluginId: plugin.id, jobId: result.id }, principal); }
      assert.equal(result.status, "completed", result.error); return result.result;
    };
    const candidates = await waitTool({ action: "search", query: "冷静" });
    const selected = candidates.candidates.find(item => item.id === asset.sha256);
    assert.equal(selected.textTemplate, true); assert.equal(selected.url, undefined);
    const textResult = await waitTool({ action: "render", searchId: candidates.searchId, id: selected.id, text: "白痴！" });
    const textSegments = [{ type: "image", data: { file: textResult.url } }];
    assert.equal((await runtime.runPluginBeforeSend(channel, context.channelPrincipal.chatId, textSegments)).content.length, 1);
    const textResolved = await runtime.resolvePluginMedia(channel, context.channelPrincipal.chatId, textSegments);
    const output = Buffer.from(textResolved[0].data.file.slice("base64://".length), "base64");
    assert.equal((await hostRequire("sharp")(output).metadata()).format, "webp");
    const afterTemplate = await runtime.runPluginAction(channel, plugin, action("detail"), { id: asset.sha256 });
    await runtime.runPluginAction(channel, plugin, action("save"), { id: asset.sha256, revision: afterTemplate.revision, clearTextTemplate: true });
    assert.equal((await runtime.runPluginBeforeSend(channel, context.channelPrincipal.chatId, textSegments)).content.length, 0, "revoking the template blocks previously rendered images");
    useTextEngine = false;

    const settingsPage = await runtime.runPluginAction(channel, plugin, action("list"), {});
    await runtime.runPluginAction(channel, plugin, action("settings"), { revision: settingsPage.preferences.revision, frequency: 0, cooldownSeconds: 0 });
    const mixedContent = `先冷静一下。然后再说。![表情](${url})`;
    const modelHook = (replyId, content) => runtime.runPluginModelHook(channel, context.channelPrincipal.chatId, "afterModel",
      { replyId, content, purpose: "chat", messageIds: ["source"] }, context.channelPrincipal);
    assert.equal((await modelHook("mixed-zero", mixedContent)).content, "先冷静一下。然后再说。");
    assert.equal((await modelHook("pure-zero", `![表情](${url})`)).content, `![表情](${url})`);
    assert.equal((await runtime.runPluginBeforeSend(channel, context.channelPrincipal.chatId, segments)).content.length, 1,
      "zero mixed frequency does not block pure sticker delivery");
    const changedSettings = await runtime.runPluginAction(channel, plugin, action("list"), {});
    await runtime.runPluginAction(channel, plugin, action("settings"), { revision: changedSettings.preferences.revision, frequency: 100, cooldownSeconds: 0 });
    assert.equal((await modelHook("mixed-zero", mixedContent)).content, "先冷静一下。然后再说。", "same submission reuses its decision after settings change");
    assert.equal((await modelHook("mixed-hundred", mixedContent)).content, mixedContent);
    // Exercise the actual outbox: filtering must run once before it splits text
    // and images into separate sends, with no extra model/draft exchange.
    const { createChannelReplyOutbox } = hostRequire("./electron/lib/commands/chat/channel-reply-outbox.cjs");
    let sendId = 0; const delivered = [], hookInputs = [];
    const currentSettings = await runtime.runPluginAction(channel, plugin, action("list"), {});
    await runtime.runPluginAction(channel, plugin, action("settings"), { revision: currentSettings.preferences.revision, frequency: 0, cooldownSeconds: 0 });
    const outbound = createChannelReplyOutbox({ commands: {
      getChannelReplyDeliveryConfig: () => ({ segmentedReply: { enabled: true, intervalSeconds: 0, maxSegments: 3 } }),
      runChannelModelHook: args => { hookInputs.push(args.payload); return modelHook(args.payload.replyId, args.payload.content); },
      send_channel_host_reply: async args => { if (args.dryRun) return { dryRun: true }; delivered.push(args); return { networkStatus: "sent", content: args.text }; },
    }, storage: { getEvent: () => ({ id: "source", direction: "in", chatId: context.channelPrincipal.chatId, sender: { id: "user" } }) },
      makeId: prefix => prefix + "-" + ++sendId, persistMessage() {}, chatRecord: (_session, role, content, extra) => ({ role, content, ...extra }), sendEvent() {}, safeError: String });
    const turn = outbound.createTurn({ sessionId: "session", requestId: "turn", principal: context.channelPrincipal, agent: {} });
    const args = { requestKey: "mixed", messageIds: ["source"], content: `先冷静一下。然后再说。<image src="${url}"/>` };
    const ack = turn.submit(args); assert.equal(ack.ok, true); assert.equal(turn.submit(args), ack);
    await outbound.drain();
    assert.equal(hookInputs.length, 1); assert(hookInputs[0].content.includes(url));
    assert.equal(delivered.map(row => row.text || "").join(""), "先冷静一下。然后再说。");
    assert(!JSON.stringify(delivered).includes(url), "image cannot escape filtering as a later pure segment");
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
        metadata: { "meme-library": { schemaVersion: 1, analysis: preparedAnalysis, ...(i === 0 ? { textTemplate: template } : {}) } },
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
      const templateRoleId = `${asset.sha256}:profile:channel-agent:own:role-0`;
      assert.deepEqual((await runtime.runPluginAction(channel, plugin, action("detail"), { id: templateRoleId })).textTemplate, template,
        "template metadata survives real role-media synchronization");
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

    // Exercise a multi-megabyte image through the real plugin worker, background
    // asset service and separate renderer process while the host remains live.
    const noise = require("node:crypto").randomBytes(1600 * 1600 * 3);
    const largeBytes = await hostRequire("sharp")(noise, { raw: { width: 1600, height: 1600, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    assert(largeBytes.length > 1024 * 1024, "the isolation fixture must exercise large media");
    const largeAsset = media.put(actor, largeBytes, { mimeType: "image/jpeg", name: "大图填字" });
    useTextEngine = true;
    let lastBeat = Date.now(), worstBeat = 0;
    const pulse = setInterval(() => { const now = Date.now(); worstBeat = Math.max(worstBeat, now - lastBeat); lastBeat = now; }, 10);
    try {
      await runtime.runPluginAction(channel, plugin, action("import"), { refs: [largeAsset.ref] });
      for (let attempt = 0; ; attempt++) {
        const detail = await runtime.runPluginAction(channel, plugin, action("detail"), { id: largeAsset.sha256 });
        try { await runtime.runPluginAction(channel, plugin, action("save"), { id: largeAsset.sha256, revision: detail.revision, name: "大图填字", textTemplate: template }); break; }
        catch (error) { if (attempt >= 4 || !/更新|刷新|冲突/.test(error.message)) throw error; }
      }
      const largeSearch = await waitTool({ action: "search", query: "大图填字", mode: "text" });
      const largeCandidate = largeSearch.candidates.find(item => item.id === largeAsset.sha256);
      assert(largeCandidate?.textTemplate);
      const largeResult = await waitTool({ action: "render", searchId: largeSearch.searchId, id: largeCandidate.id, text: "你好！" });
      const image = (await runtime.resolvePluginMedia(channel, context.channelPrincipal.chatId, [{ type: "image", data: { file: largeResult.url } }]))[0].data.file;
      assert(Buffer.from(image.slice("base64://".length), "base64").length <= 256 * 1024);
      assert(worstBeat < 500, `large template processing blocked the host for ${worstBeat} ms`);
      console.log(`Large template: ${largeBytes.length} bytes, host maximum timer gap ${worstBeat} ms`);
    } finally { clearInterval(pulse); useTextEngine = false; }
    plugin.enabled = false;
    const inactive = await runtime.runPluginModelHook(channel, context.channelPrincipal.chatId, "beforeModel", { messages: originalMessages }, context.channelPrincipal);
    assert.deepEqual(inactive.messages, originalMessages, "disabled plugins leave neither stable instructions nor runtime hints in new requests");
    await assert.rejects(runtime.resolvePluginMedia(channel, context.channelPrincipal.chatId, segments), /不可用/);
    assert.deepEqual(media.readPublished(url).data, bytes);
    console.log("Meme plugin host integration: actual VM, 72 MiB model media without worker exhaustion, persistent SQLite/jobs, image preparation, model result previews and scoped/revoked outbound references passed");
  } finally {
    textEngine?.close();
    await runtime?.pauseForDataSnapshot(); shutdownPluginWorkers();
    await retrieval?.models.pause(); await retrieval?.vectors.pause();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith("openbot-meme-plugin-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
