"use strict";
// Test-only dependency on a host checkout; shipped plugin code uses only ctx.api.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const host = path.resolve(process.argv[2] || process.env.OPENBOT_HOST_ROOT || path.join(__dirname, "../../openbot"));
const hostRequire = require("node:module").createRequire(path.join(host, "package.json"));
const fromHost = name => hostRequire("./electron/lib/" + name);
const { createPluginCommands } = fromHost("commands/extensions/plugin-commands.cjs");
const { createChannelPluginRegistryService } = fromHost("features/channels/channel-plugin-registry-service.cjs");
const { createChannelPluginRuntimeService, shutdownPluginWorkers } = fromHost("features/channels/channel-plugin-runtime-service.cjs");
const { pluginAuthorization, decidePluginAuthorization } = fromHost("plugins/plugin-authorization.cjs");
const { sessionAssetWritePath, sessionAssetRef } = fromHost("context/session-asset-paths.cjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-image-host-")); let runtime, pluginData;
  try {
    const channel = { id: "images", enabled: true, config: { ownerUsers: ["owner"], modelId: "signed-in" } };
    const store = { root, data: { channels: [channel], models: [{ id: "signed-in", name: "Logged-in model", provider: "codex", modelName: "gpt-6.1-terra", codexProfileId: "profile-fixture", enabled: true }],
      sessions: [{ id: "session", channelId: channel.id, channelChatId: "chat" }] }, save() {}, async flush() {} };
    const arrays = name => store.data[name] ||= [];
    const installer = createPluginCommands({ fs, path, getStore: () => store, getCommands: () => ({}), ensureStoreArray: arrays });
    const installed = await installer.importPluginFromPath({ pluginPath: path.resolve(__dirname, "../plugins/image-studio") });
    assert.equal(installed.authorization.status, "pending");
    const registry = createChannelPluginRegistryService({ store, ensureStoreArray: arrays, scheduleSave() {} }), saved = store.data.plugins.find(p => p.id === "image-studio");
    decidePluginAuthorization(saved, pluginAuthorization(saved).fingerprint, true);
    saved.globalSecrets = { openaiKey: { encrypted: "fixture" }, compatibleKey: { encrypted: "fixture" } };
    const binding = channel.config.botPlugins.find(p => p.id === "image-studio");
    const plugin = { ...binding, authorization: pluginAuthorization(saved), config: { ...binding.config, provider: "openai-images", instanceHourlyDefault: 1000, instanceDailyDefault: 1000, globalHourly: 1000, globalDaily: 1000 } };
    pluginData = fromHost("plugins/plugin-data-store.cjs").createPluginDataStore({ rootFor: (channelId, pluginId) => path.join(root, "data", channelId, pluginId) }).background;
    const png = await hostRequire("sharp")({ create: { width: 16, height: 16, channels: 3, background: "blue" } }).png().toBuffer();
    const smallGif = Buffer.from("R0lGODlhAgABAIEAAExpcQD/AP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAAAgABAAACAlQKACH5BAUPAAAALAAAAAACAAEAgUxpcf//AAAA/wAAAAICVAoAOw==", "base64");
    const block = Buffer.concat([Buffer.from([255]), Buffer.alloc(255, 65)]);
    const comment = Buffer.concat([Buffer.from([33, 254]), ...Array(4600).fill(block), Buffer.from([0])]);
    const gif = Buffer.concat([smallGif.subarray(0, -1), comment, smallGif.subarray(-1)]);
    assert.equal((await hostRequire("sharp")(gif, { animated: true }).metadata()).pages, 2);
    const large = Buffer.concat([png, Buffer.alloc(950000, 11)]), encoded = large.toString("base64");
    const sourceFile = sessionAssetWritePath({ path, root, sessionId: "session", kind: "images", fileName: "source.png" }); fs.writeFileSync(sourceFile, png);
    const message = { id: "reference", chatId: "chat", media: [{ type: "image", assetRef: sessionAssetRef("session", "images", "source.png") }] };
    const requests = [], nativeCalls = []; let slowStarted = false, slowCanceled = false, nativeStarted = false, nativeCanceled = false;
    runtime = createChannelPluginRuntimeService({ fs, path, store, ensureStoreArray: arrays, resolveChannel: id => id === channel.id ? channel : null,
      botPluginsFor: () => [plugin], makeId: () => "fixture-" + Math.random().toString(16).slice(2), safeError: String,
      pluginData: { database: (...args) => pluginData.database(...args) },
      isNapCatOneBotChannel: () => false, getPluginState: registry.getPluginState, setPluginState: registry.setPluginState, pluginStateScopeId: registry.pluginStateScopeId,
      channelEventByReference: (_channel, chat, id) => chat === "chat" && id === "reference" ? message : null,
      secretStore: { isSecretEnvelope: value => value?.encrypted === "fixture", decryptSecret: () => "fixture-key" },
      requestPluginModel: async ({ request, signal, assertActive }) => {
        assertActive(); signal.throwIfAborted(); nativeCalls.push(request);
        assert(!("token" in request)); assert(!("headers" in request)); assert(!("model" in request));
        assert.equal(request.tools[0].type, "image_generation");
        if (request.input[0].content[0].text === "native slow") {
          nativeStarted = true;
          await new Promise((resolve, reject) => signal.addEventListener("abort", () => { nativeCanceled = true; reject(signal.reason); }, { once: true }));
        }
        return { modelId: "signed-in", output: [{ type: "image_generation_call", status: "completed",
          result: (request.tools[0].output_format === "gif" ? gif : png).toString("base64") }] };
      },
      readResponseBytes: async (response, max) => { const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length <= max); return bytes; },
      guardedFetch: async (url, options) => {
        if (String(url).endsWith("/models")) {
          assert.equal(options.method, "GET"); assert.equal(options.headers.authorization, "Bearer fixture-key");
          return Response.json({ data: [{ id: "gpt-image-2.6-flare" }, { id: "conversation" }] });
        }
        const body = options.body ? JSON.parse(options.body) : null; requests.push({ url: String(url), body, headers: options.headers });
        assert.equal(options.headers.authorization, "Bearer fixture-key");
        if (body.prompt === "slow") {
          slowStarted = true;
          return new Response(new ReadableStream({ cancel() { slowCanceled = true; } }), { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        if (body.prompt === "denied") return Response.json({ error: { message: "fixture-key" } }, { status: 429 });
        if (body.prompt === "animated") {
          assert.equal(body.model, "gpt-image-2.6-flare"); assert.equal(body.output_format, "gif");
          assert.equal(body.frame_count, 2); assert(!("stream" in body)); assert(!("partial_images" in body));
          return Response.json({ data: [{ b64_json: gif.toString("base64") }] });
        }
        if (body.prompt === "edit") assert.equal(body.images[0].image_url, "data:image/png;base64," + png.toString("base64"));
        const response = body.input
          ? { type: "response.completed", response: { status: "completed", output: [{ type: "image_generation_call", status: "completed", result: encoded }] } }
          : { type: body.images ? "image_edit.completed" : "image_generation.completed", b64_json: encoded };
        const payload = Buffer.from("data: " + JSON.stringify(response) + "\n\n"), chunks = [];
        for (let i = 0; i < payload.length; i += 49123) chunks.push(payload.subarray(i, i + 49123));
        return new Response(new ReadableStream({ pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); } }),
          { status: 200, headers: { "content-type": "text/event-stream" } });
      } });
    const catalogAction = plugin.actions.find(action => action.id === "model_catalog");
    const models = await runtime.runPluginAction(channel, plugin, catalogAction, { source: "openai", target: "image" });
    assert.deepEqual(models.models.map(item => item.id), ["gpt-image-2.6-flare"]);
    const context = { requestId: "draw", purpose: "chat", channelPrincipal: { source: "channel", channelId: channel.id, chatId: "chat", senderId: "member", messageType: "group" } };
    const tool = "plugin__image-studio__draw_image";
    async function finish(input, requestKey) {
      let job = await runtime.runNativePluginTool(tool, { action: "start", requestKey, input }, context);
      for (let i = 0; job.status === "running" && i < 200; i++) { await delay(25); job = await runtime.runPluginTool({ action: "status", pluginId: plugin.id, jobId: job.id }, context); }
      assert.equal(job.status, "completed", job.error); return job;
    }
    assert(runtime.pluginToolSchemas(context).some(t => t.function.name === tool));
    let last = Date.now(), maxGap = 0;
    const heartbeat = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
    let drawn;
    try {
      drawn = await finish({ prompt: "large" }, "single");
      assert.equal(drawn.result.images[0].mimeType, "image/png"); assert(!JSON.stringify(drawn.result).includes(encoded));
      assert(drawn.result.images[0].url.startsWith("openbot-"), "host publishes its opaque media URL");
      const again = await finish({ prompt: "large" }, "single"); assert.equal(again.id, drawn.id); assert.equal(requests.length, 1, "same request key never resubmits chargeable API");
      await finish({ prompt: "edit", references: [{ messageId: "reference" }] }, "edit");
      assert.equal(requests.at(-1).url, "https://api.openai.com/v1/images/edits");
      const animated = await finish({ prompt: "animated", format: "gif", frameCount: 2 }, "animated");
      assert.equal(animated.result.images[0].mimeType, "image/gif");
      const delivered = await runtime.resolvePluginMedia(channel, "chat", [{ type: "image", data: { file: animated.result.images[0].url } }]);
      assert.equal(delivered[0].data.file, "base64://" + gif.toString("base64"), "delivery preserves every GIF frame");
      plugin.config.provider = "compatible-responses"; plugin.config.compatibleBaseUrl = "https://images.example/v1";
      plugin.config.compatibleTextModel = "text-fixture"; plugin.config.compatibleImageModel = "image-fixture";
      await finish({ prompt: "response" }, "responses"); assert.equal(requests.at(-1).body.tools[0].model, "image-fixture");
      assert(maxGap < 500, `large streamed image blocked host event loop for ${maxGap} ms`);
    } finally { clearInterval(heartbeat); }
    const sent = [{ type: "image", data: { file: drawn.result.images[0].url } }];
    const resolved = await runtime.resolvePluginMedia(channel, "chat", sent); assert.equal(resolved[0].data.file, "base64://" + encoded);
    await assert.rejects(runtime.resolvePluginMedia(channel, "other-chat", sent), /不可用/);
    plugin.config.provider = "codex"; plugin.config.codexModelId = "signed-in";
    await finish({ prompt: "native", references: [{ messageId: "reference" }] }, "native");
    assert.equal(nativeCalls.length, 1); assert.equal(nativeCalls[0].modelId, "signed-in");
    assert(!("responseModel" in nativeCalls[0])); assert(!("model" in nativeCalls[0].tools[0]));
    plugin.config.provider = "auto"; plugin.config.codexModelId = "";
    await finish({ prompt: "auto Codex" }, "auto-codex");
    assert.equal(nativeCalls.length, 2); assert(!("modelId" in nativeCalls[1]));
    assert(!("responseModel" in nativeCalls[1]), "the configured Terra model controls the default request");
    plugin.config.provider = "codex"; plugin.config.codexModelId = "signed-in";
    const nativeGif = await finish({ prompt: "native animated", format: "gif", frameCount: 2 }, "native-gif");
    assert.equal(nativeCalls.length, 3); assert.equal(nativeCalls[2].tools[0].model, "gpt-image-2.6-flare");
    assert.equal(nativeCalls[2].tools[0].frame_count, 2); assert.equal(nativeGif.result.images[0].mimeType, "image/gif");
    const nativeDelivery = await runtime.resolvePluginMedia(channel, "chat", [{ type: "image", data: { file: nativeGif.result.images[0].url } }]);
    assert.equal(nativeDelivery[0].data.file, "base64://" + gif.toString("base64"));
    const permissions = [...plugin.permissions];
    async function permissionFailure(missing, key) {
      plugin.permissions = permissions.filter(p => p !== missing);
      let job = await runtime.runNativePluginTool(tool, { action: "start", requestKey: key, input: { prompt: "native" } }, context);
      for (let i = 0; job.status === "running" && i < 100; i++) { await delay(10); job = await runtime.runPluginTool({ action: "status", pluginId: plugin.id, jobId: job.id }, context); }
      assert.equal(job.status, "failed"); assert.match(job.error, new RegExp(missing));
      plugin.permissions = [...permissions];
    }
    await permissionFailure("model:request", "without-request"); await permissionFailure("model:select", "without-select");
    assert.equal(nativeCalls.length, 3, "missing permission never dispatches a model request");
    const nativeSlow = await runtime.runNativePluginTool(tool, { action: "start", requestKey: "native-slow", input: { prompt: "native slow" } }, context);
    for (let i = 0; !nativeStarted && i < 100; i++) await delay(10);
    assert(nativeStarted);
    await runtime.runPluginTool({ action: "cancel", pluginId: plugin.id, jobId: nativeSlow.id }, context);
    for (let i = 0; !nativeCanceled && i < 100; i++) await delay(10);
    assert(nativeCanceled, "cancel interrupts the native model before image publication");
    plugin.config.provider = "openai-images";
    const count = requests.length;
    const slow = await runtime.runNativePluginTool(tool, { action: "start", requestKey: "slow", input: { prompt: "slow" } }, context);
    for (let i = 0; !slowStarted && i < 500; i++) await delay(10);
    assert(slowStarted, JSON.stringify(await runtime.runPluginTool({ action: "status", pluginId: plugin.id, jobId: slow.id }, context))); assert.equal(slow.status, "running");
    await runtime.runPluginTool({ action: "cancel", pluginId: plugin.id, jobId: slow.id }, context);
    for (let i = 0; !slowCanceled && i < 100; i++) await delay(10);
    assert(slowCanceled, "cancel closes the underlying HTTP response"); assert.equal(requests.length, count + 1);
    let denied = await runtime.runNativePluginTool(tool, { action: "start", requestKey: "denied", input: { prompt: "denied" } }, context);
    for (let i = 0; denied.status === "running" && i < 500; i++) { await delay(20); denied = await runtime.runPluginTool({ action: "status", pluginId: plugin.id, jobId: denied.id }, context); }
    assert.equal(denied.status, "failed"); assert(!JSON.stringify(denied).includes("fixture-key"));
    plugin.enabled = false;
    await assert.rejects(Promise.resolve().then(() => runtime.runNativePluginTool(tool, { prompt: "revoked" }, context)), /不可用/);
    console.log(`Image studio host: installed/authorized; >1 MiB SSE; reference edit; Responses/native models; permission denial; dedup; scoped media; 429; cancellation; heartbeat ${maxGap} ms passed`);
  } finally {
    runtime?.clearChannelPluginPollTimers?.({ id: "images" }); await runtime?.pauseForDataSnapshot(); await pluginData?.pause(); shutdownPluginWorkers();
    const resolved = path.resolve(root); assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("openbot-image-host-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
