"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const host = path.resolve(process.argv[2] || path.join(__dirname, "../../openbot"));
const hostRequire = require("node:module").createRequire(path.join(host, "package.json"));
const fromHost = name => hostRequire("./electron/lib/" + name);
const { createPluginCommands } = fromHost("commands/extensions/plugin-commands.cjs");
const { createChannelPluginRegistryService } = fromHost("features/channels/channel-plugin-registry-service.cjs");
const { createChannelPluginRuntimeService, executePluginWorker, shutdownPluginWorkers } = fromHost("features/channels/channel-plugin-runtime-service.cjs");
const { pluginAuthorization, decidePluginAuthorization } = fromHost("plugins/plugin-authorization.cjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-image-queue-")); let runtime, pluginData;
  try {
    const channels = ["a", "b"].map(id => ({ id, name: id, enabled: true, config: { modelId: "signed-in", ownerUsers: ["owner"] } }));
    const store = { root, data: { channels, models: [{ id: "signed-in", provider: "codex", codexProfileId: "fixture", enabled: true }], sessions: [] }, save() {}, async flush() {} };
    const arrays = name => store.data[name] ||= [];
    const installer = createPluginCommands({ fs, path, getStore: () => store, getCommands: () => ({}), ensureStoreArray: arrays });
    await installer.importPluginFromPath({ pluginPath: path.resolve(__dirname, "../plugins/image-studio") });
    const saved = store.data.plugins.find(plugin => plugin.id === "image-studio");
    decidePluginAuthorization(saved, pluginAuthorization(saved).fingerprint, true); saved.enabled = true;
    saved.globalSettings = { provider: "codex", globalConcurrency: 2, instanceConcurrencyDefault: 1, queueLimit: 2, queueTimeoutSeconds: 20,
      instanceHourlyDefault: 1000, instanceDailyDefault: 1000, globalHourly: 1000, globalDaily: 1000 };
    const registry = createChannelPluginRegistryService({ store, ensureStoreArray: arrays, scheduleSave() {} });
    pluginData = fromHost("plugins/plugin-data-store.cjs").createPluginDataStore({ rootFor: (channelId, pluginId) => path.join(root, "data", channelId, pluginId) }).background;
    const png = await hostRequire("sharp")({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    const gates = new Map(), started = [];
    runtime = createChannelPluginRuntimeService({ fs, path, store, ensureStoreArray: arrays, resolveChannel: id => channels.find(channel => channel.id === id),
      botPluginsFor: registry.botPluginsFor, getPluginState: registry.getPluginState, setPluginState: registry.setPluginState, pluginStateScopeId: registry.pluginStateScopeId,
      pluginData: { database: (...args) => pluginData.database(...args) }, makeId: () => crypto.randomUUID(), safeError: String, isNapCatOneBotChannel: () => false,
      requestPluginModel: async ({ request, signal, assertActive }) => {
        const name = request.input[0].content[0].text, gate = gates.get(name); started.push(name); gate.entered.resolve();
        await Promise.race([gate.release.promise, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
        assertActive(); return { output: [{ type: "image_generation_call", status: "completed", result: png.toString("base64") }] };
      },
    });
    const tool = "plugin__image-studio__draw_image";
    const context = id => ({ purpose: "chat", channelPrincipal: { source: "channel", channelId: id, chatId: `chat-${id}`, senderId: "owner", messageType: "private" } });
    const start = async (id, name) => {
      gates.set(name, { entered: deferred(), release: deferred() });
      return runtime.runNativePluginTool(tool, { action: "start", requestKey: name, input: { prompt: name } }, context(id));
    };
    const status = (id, job) => runtime.runPluginTool({ action: "status", pluginId: "image-studio", jobId: job.id }, context(id));
    const a1 = await start("a", "a1"); await gates.get("a1").entered.promise;
    const a2 = await start("a", "a2"); assert.equal(a2.phase, "queued");
    const b1 = await start("b", "b1"); await gates.get("b1").entered.promise;
    const b2 = await start("b", "b2"); assert.equal(b2.phase, "queued");
    const overflow = await start("a", "overflow"); assert.equal(overflow.status, "failed"); assert.match(overflow.error, /排队已满/);
    assert.deepEqual(started, ["a1", "b1"]);
    const begin = Date.now();
    assert.equal(await executePluginWorker({ code: "module.exports.handle=()=>42", api: {}, context: {}, exportName: "handle", executionTimeoutMs: 2000 }), 42);
    assert(Date.now() - begin < 1000, "queued image tasks do not occupy all workers");
    await runtime.runPluginTool({ action: "cancel", pluginId: "image-studio", jobId: a2.id }, context("a"));
    assert.equal((await status("a", a2)).canceled, true);
    gates.get("a1").release.resolve();
    for (let i = 0; (await status("a", a1)).status === "running" && i < 200; i++) await delay(10);
    assert.deepEqual(started, ["a1", "b1"], "another task for the busy instance remains queued");
    gates.get("b1").release.resolve(); await gates.get("b2").entered.promise;
    gates.get("b2").release.resolve();
    for (let i = 0; (await status("b", b2)).status === "running" && i < 200; i++) await delay(10);
    assert.equal((await status("b", b2)).status, "completed");
    console.log("Image studio queue host: real plugin tasks honor instance/global concurrency, bounded waiting, cancellation and worker isolation");
  } finally {
    await runtime?.pauseForDataSnapshot(); await pluginData?.pause(); shutdownPluginWorkers();
    const resolved = path.resolve(root); assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("openbot-image-queue-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
