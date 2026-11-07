"use strict";
// Source-checkout integration only; the shipped plugin uses public ctx.api calls.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const host = path.resolve(process.argv[2] || process.env.OPENBOT_HOST_ROOT || path.join(__dirname, "../../openbot"));
const hostRequire = require("node:module").createRequire(path.join(host, "package.json"));
const fromHost = name => hostRequire("./electron/lib/" + name);
const { createPluginCommands } = fromHost("commands/extensions/plugin-commands.cjs");
const { createChannelPluginRegistryService } = fromHost("features/channels/channel-plugin-registry-service.cjs");
const { createChannelPluginRuntimeService, shutdownPluginWorkers } = fromHost("features/channels/channel-plugin-runtime-service.cjs");
const { pluginAuthorization, decidePluginAuthorization } = fromHost("plugins/plugin-authorization.cjs");
const { createPluginAssets } = fromHost("plugins/plugin-assets.cjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-selfie-host-"));
  let runtime, media, pluginData;
  try {
    const channel = { id: "selfies", enabled: true, config: { ownerUsers: ["owner"] } };
    const store = { root, data: { channels: [channel], models: [{ id: "signed-in", provider: "codex", codexProfileId: "fixture", enabled: true }] }, save() {}, async flush() {} };
    const arrays = name => store.data[name] ||= [];
    const installer = createPluginCommands({ fs, path, getStore: () => store, getCommands: () => ({}), ensureStoreArray: arrays });
    const installed = await installer.importPluginFromPath({ pluginPath: path.resolve(__dirname, "../plugins/image-studio") });
    assert.equal(installed.authorization.status, "pending");
    const saved = store.data.plugins.find(value => value.id === "image-studio"); decidePluginAuthorization(saved, pluginAuthorization(saved).fingerprint, true);
    const registry = createChannelPluginRegistryService({ store, ensureStoreArray: arrays, scheduleSave() {} });
    const binding = channel.config.botPlugins.find(value => value.id === "image-studio");
    const plugin = { ...binding, authorization: pluginAuthorization(saved),
      config: { ...binding.config, provider: "codex", imageEnabled: true, selfieEnabled: true, globalConcurrency: 4, instanceConcurrency: 4,
        instanceHourlyDefault: 1000, instanceDailyDefault: 1000, globalHourly: 1000, globalDaily: 1000 } };
    pluginData = fromHost("plugins/plugin-data-store.cjs").createPluginDataStore({ rootFor: (channelId, pluginId) => path.join(root, "data", channelId, pluginId) }).background;
    const action = plugin.actions.find(value => value.id === "selfie_reference"); assert(action, "reference management must be a declared native desktop action");
    const overrides = new Map(), calls = []; let gate;
    const sharp = hostRequire("sharp");
    const png = await sharp({ create: { width: 60, height: 80, channels: 3, background: "red" } }).png().toBuffer();
    const second = await sharp({ create: { width: 60, height: 80, channels: 3, background: "green" } }).png().toBuffer();
    media = createPluginAssets({ root }); const background = media.background;
    const actor = { channelId: channel.id, pluginId: plugin.id, chatId: "", desktop: true };
    const scope = { signal: new AbortController().signal, assertActive() {} };
    const first = await background.put(actor, png, { mimeType: "image/png", name: "形象 A" }, scope);
    const replacement = await background.put(actor, second, { mimeType: "image/png", name: "形象 B" }, scope);
    const privateImage = await background.put({ ...actor, chatId: "onebot:private:other" }, png, { mimeType: "image/png", name: "其他聊天私图" }, scope);
    const foreignPlugin = await background.put({ ...actor, pluginId: "other-plugin" }, png, { mimeType: "image/png", name: "其他插件图片" }, scope);
    const foreignInstance = await background.put({ ...actor, channelId: "other-instance" }, png, { mimeType: "image/png", name: "其他实例图片" }, scope);
    const preview = await background.call(actor, { action: "preview", ref: first.ref, maxEdge: 1024 }, scope);
    runtime = createChannelPluginRuntimeService({ fs, path, store, ensureStoreArray: arrays,
      resolveChannel: id => id === channel.id ? channel : null,
      botPluginsFor: (_channel, chatId) => [{ ...plugin, config: { ...plugin.config, ...(overrides.get(chatId) || {}) } }],
      pluginData: { database: (...args) => pluginData.database(...args) },
      makeId: () => crypto.randomUUID(), safeError: String, isNapCatOneBotChannel: () => false,
      getPluginState: registry.getPluginState, setPluginState: registry.setPluginState, pluginStateScopeId: registry.pluginStateScopeId,
      requestPluginModel: async ({ request, signal, assertActive }) => {
        assertActive(); signal.throwIfAborted(); calls.push(request);
        const pending = gate;
        if (pending) {
          pending.signal = signal; pending.entered.resolve();
          await new Promise((resolve, reject) => {
            const abort = () => { pending.aborted = true; reject(signal.reason); };
            signal.addEventListener("abort", abort, { once: true });
            pending.release.promise.then(() => { signal.removeEventListener("abort", abort); resolve(); });
          });
        }
        assertActive(); signal.throwIfAborted();
        return { output: [{ type: "image_generation_call", status: "completed", result: png.toString("base64") }] };
      },
    });
    const context = chat => ({ purpose: "chat", channelPrincipal: { source: "channel", channelId: channel.id, chatId: chat,
      senderId: "member", messageType: chat.includes(":group:") ? "group" : "private" } });
    const chatA = "onebot:group:a", chatB = "onebot:private:b", tool = "plugin__image-studio__draw_image";
    const start = (chat, key, input = { mode: "selfie", prompt: "在公园拍照" }) => runtime.runNativePluginTool(tool, { action: "start", input, requestKey: key }, context(chat));
    async function finish(job, chat = chatA) {
      for (let i = 0; job.status === "running" && i < 500; i++) { await delay(10); job = await runtime.runPluginTool({ action: "status", pluginId: plugin.id, jobId: job.id }, context(chat)); }
      return job;
    }
    const manage = input => runtime.runPluginAction(channel, plugin, action, input);
    const read = () => manage({ action: "get" });
    const set = async ref => manage({ action: "set", assetRef: ref, expectedRevision: (await read()).revision });
    const waitGate = async (chat, key, input) => {
      gate = { entered: deferred(), release: deferred(), aborted: false };
      const job = await start(chat, key, input); await gate.entered.promise; return { job, pending: gate };
    };

    let job = await finish(await start(chatA, "missing-reference")); assert.equal(job.status, "failed"); assert.equal(calls.length, 0);
    const selected = await set(first.ref); assert.equal(selected.revision, 1); assert.equal(selected.assetRef, first.ref);
    await assert.rejects(manage({ action: "set", assetRef: replacement.ref, expectedRevision: 0 }), /更新|变化|版本|刷新/);
    assert.equal((await read()).assetRef, first.ref, "state survives separate real worker invocations");
    for (const ref of [privateImage.ref, foreignPlugin.ref, foreignInstance.ref]) {
      await assert.rejects(set(ref), /私有|共享|不可用|不存在|实例|聊天/);
      assert.equal((await read()).assetRef, first.ref);
    }
    for (const chat of [chatA, chatB]) {
      job = await finish(await start(chat, "shared-reference-" + chat), chat); assert.equal(job.status, "completed", job.error);
      assert.equal(job.result.selfieReferenceRevision, 1);
      const content = calls.at(-1).input[0].content;
      assert(content[0].text.includes("请把固定形象参考图中的角色作为同一个主体"));
      assert.equal(content[1].image_url, "data:image/jpeg;base64," + preview.data, "only the globally shared identity crosses chats");
      assert.equal(calls.at(-1).tools[0].action, "edit");
    }

    const { createMediaContentStore } = fromHost("features/retrieval/media-content-store.cjs");
    const originals = createMediaContentStore(root);
    const reference = (id, view, bytes) => ({ id, name: id, view, contentHash: originals.put(bytes), mimeType: "image/png" });
    const large = await sharp(crypto.randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
    const front = reference("front", "front", png), back = reference("back", "back", second), chibi = reference("chibi", "chibi", large);
    const roleA = { id: "role-a", referenceImages: [front, back, chibi], stickers: [{ ...back, id: "only-a-sticker" }] };
    const roleB = { id: "role-b", referenceImages: [{ ...back, id: "b-front", view: "front" }] };
    store.data.channelAgents = [roleA, roleB];
    channel.config.agentId = "channel-agent:role-a";
    channel.config.chatOverrides = { [chatB]: { agentId: "channel-agent:role-b", commandManagedFields: ["agentId"] } };
    const frontUrl = "data:image/jpeg;base64," + preview.data;
    const backPreview = await background.call(actor, { action: "preview", ref: replacement.ref, maxEdge: 1024 }, scope);
    const backUrl = "data:image/jpeg;base64," + backPreview.data;
    const lastImages = () => calls.at(-1).input[0].content.filter(part => part.type === "input_image").map(part => part.image_url);
    job = await finish(await start(chatA, "role-front")); assert.equal(job.status, "completed", job.error);
    assert.equal(job.result.selfieReferenceRevision, undefined);
    assert.deepEqual(lastImages(), [frontUrl], "role front takes priority over the manual image");
    job = await finish(await start(chatB, "role-other-chat"), chatB); assert.equal(job.status, "completed", job.error);
    assert.deepEqual(lastImages(), [backUrl], "each chat uses its assigned role");
    job = await finish(await runtime.runNativePluginTool(tool, { action: "start", requestKey: "role-in-turn",
      input: { mode: "selfie", prompt: "画自己的形象" } }, { ...context(chatA), overrideAgent: { id: "channel-agent:role-b", source: "channel" } }));
    assert.equal(job.status, "completed", job.error);
    assert.deepEqual(lastImages(), [backUrl], "a turn using an explicitly routed role uses that role's references");
    job = await finish(await start(chatA, "role-back", { mode: "selfie", selfieView: "back", prompt: "从背面画我" }));
    assert.equal(job.status, "completed", job.error);
    assert.deepEqual(lastImages(), [backUrl, frontUrl]);

    let ticks = 0, largestGap = 0, previousTick = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      largestGap = Math.max(largestGap, now - previousTick);
      previousTick = now;
      ticks++;
    }, 5);
    try {
      job = await finish(await start(chatA, "role-chibi", { mode: "selfie", selfieView: "chibi", prompt: "画Q版的我" }));
      assert.equal(job.status, "completed", job.error);
      assert.equal(lastImages().length, 1);
      assert(![frontUrl, backUrl].includes(lastImages()[0]), "the Q version uses its own reference without mixing body proportions");
      assert(ticks > 0 && largestGap < 350, `host remained responsive during ${large.length} bytes of role media: ${largestGap.toFixed(0)} ms`);
      console.log(`Role image preview: ${large.length} bytes, maximum host timer gap ${largestGap.toFixed(0)} ms`);
    } finally { clearInterval(heartbeat); }

    let roleRunning = await waitGate(chatA, "role-reference-replaced");
    store.data.channelAgents = [{ ...roleA, referenceImages: [{ ...front, contentHash: back.contentHash }, back, chibi] }, roleB];
    roleRunning.pending.release.resolve(); gate = null;
    job = await finish(roleRunning.job); assert.equal(job.status, "failed"); assert.match(job.error, /角色人设图已更换/); assert.equal(job.result, undefined);
    roleRunning = await waitGate(chatA, "role-rebound");
    channel.config.agentId = "channel-agent:role-b";
    roleRunning.pending.release.resolve(); gate = null;
    job = await finish(roleRunning.job); assert.equal(job.status, "failed"); assert.match(job.error, /角色已更换/); assert.equal(job.result, undefined);
    delete channel.config.agentId;
    delete channel.config.chatOverrides;
    store.data.channelAgents = [];

    let running = await waitGate(chatA, "replace-running");
    await set(replacement.ref); running.pending.release.resolve(); gate = null;
    job = await finish(running.job); assert.equal(job.status, "failed"); assert.match(job.error, /形象已更换或清除/); assert.equal(job.result, undefined);
    const oldInfo = await background.info(actor, first.ref, scope); assert.equal(oldInfo.ref, first.ref, "replacement retains previously referenced assets");
    const previous = await read(); await manage({ action: "clear", expectedRevision: previous.revision });
    assert.equal((await read()).assetRef, ""); assert.equal((await background.info(actor, replacement.ref, scope)).ref, replacement.ref);
    const beforeClear = calls.length; job = await finish(await start(chatA, "cleared")); assert.equal(job.status, "failed"); assert.equal(calls.length, beforeClear);
    await set(first.ref);

    // A per-chat toggle change is observed through getConfig rather than the
    // initiating VM's stale ctx.config. Changing the other mode must not stop it.
    running = await waitGate(chatA, "other-mode-change");
    overrides.set(chatA, { imageEnabled: false }); await delay(650);
    assert.equal(running.pending.aborted, false, "ordinary drawing switch does not cancel an active selfie");
    running.pending.release.resolve(); gate = null; job = await finish(running.job); assert.equal(job.status, "completed", job.error);
    running = await waitGate(chatA, "selfie-toggle-off");
    overrides.set(chatA, { imageEnabled: false, selfieEnabled: false });
    for (let i = 0; !running.pending.aborted && i < 150; i++) await delay(20);
    assert.equal(running.pending.aborted, true, "closing the effective chat selfie switch aborts the waiting model");
    gate = null; job = await finish(running.job); assert.equal(job.status, "failed"); assert.match(job.error, /自拍.*关闭|关闭.*自拍/); assert.equal(job.result, undefined);
    job = await finish(await start(chatB, "other-chat-still-enabled"), chatB); assert.equal(job.status, "completed", job.error);
    const blocked = calls.length; job = await finish(await start(chatA, "off-no-charge")); assert.equal(job.status, "failed"); assert.equal(calls.length, blocked);
    overrides.clear();

    running = await waitGate(chatA, "cancel-selfie");
    const canceled = await runtime.runPluginTool({ action: "cancel", pluginId: plugin.id, jobId: running.job.id }, context(chatA));
    assert.equal(canceled.status, "interrupted");
    for (let i = 0; !running.pending.aborted && i < 100; i++) await delay(10);
    assert.equal(running.pending.aborted, true); assert.equal(canceled.result, undefined); gate = null;
    running = await waitGate(chatA, "revoke-reference");
    const info = await background.info(actor, first.ref, scope);
    await background.call(actor, { action: "grant", ref: first.ref, expectedRevision: info.revision, shared: false, chats: [] }, scope);
    running.pending.release.resolve(); gate = null;
    job = await finish(running.job); assert.equal(job.status, "failed"); assert.equal(job.result, undefined);
    console.log("Image studio selfie host: role views, chat and turn role scopes, bounded previews, manual fallback, reference and role changes, live switches and cancellation passed");
  } finally {
    runtime?.clearChannelPluginPollTimers?.({ id: "selfies" }); await runtime?.pauseForDataSnapshot(); await pluginData?.pause(); await media?.pauseBackground(); shutdownPluginWorkers();
    const resolved = path.resolve(root); assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("openbot-selfie-host-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
