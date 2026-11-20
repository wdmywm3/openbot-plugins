"use strict";
// Explicit build/test-only host checkout; the plugin never reads this path.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const host = process.argv[2] && path.resolve(process.argv[2]);
if (!host) throw new Error("Usage: node tests/search-host.cjs PATH_TO_OPENBOT [--live-anysearch]");
const fromHost = name => require(path.join(host, "electron/lib", name));
const { createPluginCommands } = fromHost("commands/extensions/plugin-commands.cjs");
const { createChannelPluginRegistryService } = fromHost("features/channels/channel-plugin-registry-service.cjs");
const { createChannelPluginRuntimeService, shutdownPluginWorkers } = fromHost("features/channels/channel-plugin-runtime-service.cjs");
const { pluginAuthorization, decidePluginAuthorization } = fromHost("plugins/plugin-authorization.cjs");
const { sessionAssetWritePath, sessionAssetRef } = fromHost("context/session-asset-paths.cjs");
const { createOpenBotToolExecutor } = fromHost("tools/openbot-tool-executor.cjs");
const { createBuiltinToolHelpers } = fromHost("tools/builtin-tools.cjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-search-host-"));
  let runtime;
  try {
    const channel = { id: "bot", enabled: true, config: { ownerUsers: ["owner"], toolConfig: { version: 2, scopes: {
      chat: { enabledTools: ["web_search", "web_fetch"] }, task: { enabledTools: ["web_search"] }, management: { enabledTools: ["web_search", "web_fetch"] },
    } } } };
    const store = { root, data: { channels: [channel], sessions: [{ id: "conversation", channelId: "bot", channelChatId: "chat" }],
      settings: { legacyPluginSettings: { websearch: { config: { webProvider: "tavily" }, secrets: { tavilyKey: { encrypted: "fixture" } } } } } }, save() {}, async flush() {} };
    const arrays = name => store.data[name] ||= [];
    const installer = createPluginCommands({ fs, path, getStore: () => store, getCommands: () => ({}), ensureStoreArray: arrays });
    const installed = await installer.importPluginFromPath({ pluginPath: path.resolve(__dirname, "../plugins/search") });
    assert.equal(installed.authorization.status, "pending");
    assert.equal(channel.config.botPlugins[0].config.webProvider, "tavily");
    assert.equal(channel.config.botPlugins[0].settingsMigration, "websearch");
    const registry = createChannelPluginRegistryService({ store, ensureStoreArray: arrays, scheduleSave() {} });
    assert.deepEqual(registry.getPluginState(channel, "search", "channel", "bot", "secret:tavilyKey"), { encrypted: "fixture" });
    const saved = store.data.plugins[0];
    decidePluginAuthorization(saved, pluginAuthorization(saved).fingerprint, true);
    const plugin = channel.config.botPlugins[0];
    assert.equal(plugin.config.customWeb, true, "legacy service remains local");
    Object.assign(plugin.config, { customImage: true, imageProvider: "google" });
    const second = { id: "bot-b", enabled: true, config: { botPlugins: [registry.installedChannelPlugin(saved)] } };
    store.data.channels.push(second);
    saved.globalSettings = { webProvider: "brave", imageProvider: "off" };
    const resolved = target => registry.botPluginsFor(target)[0].config;
    assert.equal(resolved(second).webProvider, "brave");
    assert.equal(resolved(channel).webProvider, "tavily");
    saved.globalSettings.webProvider = "exa";
    assert.equal(resolved(second).webProvider, "exa");
    assert.equal(resolved(channel).webProvider, "tavily");
    plugin.config.customWeb = false;
    assert.equal(resolved(channel).webProvider, "exa");
    assert.equal(resolved(channel).imageProvider, "google");
    plugin.config.customWeb = true;
    saved.globalSecrets = { googleKey: { encrypted: "global" }, tavilyKey: { encrypted: "global" } };
    registry.setPluginState(channel, "search", "channel", "bot", "secret:googleKey", { encrypted: "fixture" });
    const file = sessionAssetWritePath({ path, root, sessionId: "conversation", kind: "images", fileName: "source.png" });
    const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(65000, 1)]); fs.writeFileSync(file, bytes);
    const message = { id: "source", chatId: "chat", media: [{ type: "image", assetRef: sessionAssetRef("conversation", "images", "source.png") }] };
    const sharp = require(require.resolve("sharp", { paths: [host] }));
    const drawing = await sharp(require("node:crypto").randomBytes(602 * 602 * 3),
      { raw: { width: 602, height: 602, channels: 3 } }).png().toBuffer();
    const illustration = "https://example.org/works/picture.png";
    let requests = 0, expectedKey = "fixture-key";
    runtime = createChannelPluginRuntimeService({ fs, path, store, ensureStoreArray: arrays, resolveChannel: id => id === "bot" ? channel : null,
      botPluginsFor: registry.botPluginsFor, makeId: () => "fixture", safeError: String, isNapCatOneBotChannel: () => false,
      getPluginState: registry.getPluginState, setPluginState: registry.setPluginState, pluginStateScopeId: registry.pluginStateScopeId,
      channelEventByReference: (_channel, chat, id) => chat === "chat" && id === "source" ? message : null,
      secretStore: { isSecretEnvelope: value => !!value?.encrypted, decryptSecret: value => value.encrypted === "global" ? "default-key" : "fixture-key" },
      readResponseBytes: async (response, max) => { const data = Buffer.from(await response.arrayBuffer()); assert.ok(data.length <= max); return data; },
      requestPluginModel: async ({ request }) => {
        assert.deepEqual(request.tools[0].search_content_types, ["image", "text"]);
        assert.ok(request.include.includes("web_search_call.results"));
        return { output: [{ type: "web_search_call", status: "completed", results: [
          { type: "image_result", image_url: illustration, source_website_url: "https://example.org/gallery", caption: "Character art" }] },
          { type: "message", content: [{ type: "output_text", text: "Gallery", annotations: [
            { type: "url_citation", url: "https://example.org/gallery", title: "Artist" }] }] }] };
      },
      guardedFetch: async (url, options) => {
        requests++;
        if (["https://local.example/v1/models", "https://shared.example/v1/models"].includes(url)) {
          assert.equal(new Headers(options.headers).get("Authorization"), url.includes("local.example") ? "Bearer fixture-key" : "Bearer default-key");
          return Response.json({ data: [{ id: "fixture-model" }] });
        }
        if (process.argv.includes("--live-reference") && ["xn--pssy23gqgbz2d718b.com", "raw.githubusercontent.com"].includes(new URL(url).hostname))
          return fetch(url, options);
        if (url === "https://api.anysearch.com/mcp" && process.argv.includes("--live-anysearch")) return fetch(url, options);
        if (url === "https://example.org/gallery") return new Response('<article><a href="works/detail">作品详情</a><img src="works/picture.png" alt="角色立绘"></article>',
          { headers: { "content-type": "text/html" } });
        if (url === illustration) return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(drawing.subarray(0, 11)); controller.enqueue(drawing.subarray(11)); controller.close();
        } }), { headers: { "content-type": "image/png" } });
        const body = JSON.parse(options.body);
        if (url === "https://vision.googleapis.com/v1/images:annotate") {
          assert.equal(body.requests[0].image.content, bytes.toString("base64"));
          assert.equal(options.headers["x-goog-api-key"], "fixture-key");
          return Response.json({ responses: [{ webDetection: { pagesWithMatchingImages: [{ url: "https://example.org/source", pageTitle: "Source" }] } }] });
        }
        assert.equal(url, "https://api.tavily.com/search"); assert.equal(body.api_key, expectedKey);
        return Response.json({ results: [{ title: "Example", url: "https://example.org", content: "Verified source" }] });
      } });
    const context = { requestId: "request", purpose: "chat", channelPrincipal: { source: "channel", channelId: "bot", chatId: "chat", senderId: "member", messageType: "group" } };
    async function complete(name, args, ctx = context) {
      let job = await runtime.runNativePluginTool(name, args, ctx);
      for (let i = 0; job.status === "running" && i < 120; i++) { await delay(250); job = await runtime.runNativePluginTool(`plugin__search__${job.tool}`, { action: "status", jobId: job.id }, ctx); }
      assert.equal(job.status, "completed", job.error); return job.result;
    }
    const images = await complete("plugin__search__search_by_image", { action: "start", requestKey: "image", input: { messageId: "source" } });
    assert.equal(images.pages[0].title, "Source"); assert.equal(requests, 1);
    assert.equal((await complete("web_search", { query: "example" })).results[0].snippet, "Verified source");
    saved.globalSettings.webProvider = "tavily";
    plugin.config.customWeb = false; expectedKey = "default-key";
    await complete("web_search", { query: "inherited" });
    plugin.config.customWeb = true; expectedKey = "fixture-key";
    registry.deletePluginState(channel, "search", "channel", "bot", "secret:tavilyKey");
    await assert.rejects(complete("web_search", { query: "missing-local-key" }), /Tavily API Key/i);
    registry.setPluginState(channel, "search", "channel", "bot", "secret:tavilyKey", { encrypted: "fixture" });
    plugin.config.webProvider = "openai";
    const native = await complete("web_search", { query: "Character art", resultType: "images" });
    assert.equal(native.images[0].imageUrl, illustration);
    assert.equal(native.results[0].title, "Artist");
    plugin.config.webProvider = "anysearch";
    const gallery = await complete("plugin__search__read_webpage", { action: "start", requestKey: "gallery", input: { url: native.images[0].sourceUrl, includeImages: true } });
    assert.equal(gallery.links[0].url, "https://example.org/works/detail");
    const candidate = gallery.images[0];
    assert.equal(candidate.caption, "角色立绘");
    const ready = await complete("plugin__search__prepare_reference", { action: "start", requestKey: "reference", input: { imageUrl: candidate.imageUrl, sourceUrl: candidate.sourceUrl } });
    const vault = fromHost("plugins/plugin-assets.cjs").createPluginAssets({ root });
    const actor = { channelId: "bot", chatId: "chat", pluginId: "image-studio" };
    const adopted = vault.handoff(actor, { action: "fromPublished", url: ready.reference.url }, () => true);
    assert.deepEqual(vault.read(actor, adopted.ref).data, drawing);
    if (process.argv.includes("--live-reference")) {
      const sourceUrl = "https://xn--pssy23gqgbz2d718b.com/works/gpt202611200001.html";
      const page = await complete("plugin__search__read_webpage", { action: "start", requestKey: "real-gallery", input: { url: sourceUrl, includeImages: true } });
      const original = page.images.find(item => item.imageUrl.includes("raw.githubusercontent.com") && item.imageUrl.includes("/originals/gpt/"));
      assert.ok(original, "work page supplies the original image");
      const prepared = await complete("plugin__search__prepare_reference", { action: "start", requestKey: "real-image",
        input: { imageUrl: original.imageUrl, sourceUrl } });
      const actual = vault.handoff(actor, { action: "fromPublished", url: prepared.reference.url }, () => true);
      console.log("Live reference:", page.title, actual.mimeType, actual.bytes, "bytes");
    }
    plugin.config.webProvider = "tavily";
    const helpers = createBuiltinToolHelpers({ normalizeList: value => value || [], parseJsonLoose: JSON.parse });
    const commands = { _channelPluginToolSchemas: runtime.pluginToolSchemas, _channelNativePluginTool: runtime.runNativePluginTool };
    const executor = createOpenBotToolExecutor({ fs, path, getStore: () => store, getCommands: () => commands, ensureStoreArray: arrays,
      getAgentForSession: () => ({ enabledTools: [] }), normalizeList: value => value || [], safeError: String, ...helpers });
    const aliasResult = await executor.executeLlmToolWithTimeout("web_search", { query: "executor" }, { ...context, requestId: "executor" });
    assert.ok(["completed", "running"].includes(aliasResult.status));
    if (aliasResult.status === "running") await complete("plugin__search__web_search", { action: "status", jobId: aliasResult.id });
    channel.config.toolConfig.scopes.chat.enabledTools = [];
    assert.ok(!runtime.pluginToolSchemas(context).some(tool => tool.function.name === "plugin__search__web_search"), "old disabled grants remain disabled after migration");
    await assert.rejects(Promise.resolve().then(() => runtime.runNativePluginTool("web_search", { query: "blocked" }, context)), /不可用/);
    plugin.legacyToolSelection = false;
    assert.ok(runtime.pluginToolSchemas(context).some(tool => tool.function.name === "plugin__search__web_search"), "an explicit new plugin choice uses package authorization");
    if (process.argv.includes("--live-anysearch")) {
      plugin.config.webProvider = "anysearch";
      const live = await complete("plugin__search__web_search", { action: "start", requestKey: "live", input: { query: "Google Cloud Vision Web Detection documentation", max_results: 2 } });
      assert.equal(live.provider, "anysearch"); assert.ok(live.content.length);
      console.log("Live anonymous AnySearch search completed through the installed plugin worker and guarded HTTP interface");
    }
    const drawingPackage = await installer.importPluginFromPath({ pluginPath: path.resolve(__dirname, "../plugins/image-studio") });
    const drawingPlugin = arrays("plugins").find(item => item.id === drawingPackage.id);
    decidePluginAuthorization(drawingPlugin, pluginAuthorization(drawingPlugin).fingerprint, true);
    drawingPlugin.globalSettings = { provider: "compatible-images", compatibleBaseUrl: "https://shared.example/v1", compatibleImageModel: "fixture-model" };
    drawingPlugin.globalSecrets = { compatibleKey: { encrypted: "global" } };
    const connection = channel.config.botPlugins.find(item => item.id === drawingPlugin.id);
    Object.assign(connection.config, { customService: true, provider: "compatible-images", compatibleBaseUrl: "https://local.example/v1", compatibleImageModel: "fixture-model" });
    registry.setPluginState(channel, drawingPlugin.id, "channel", channel.id, "secret:compatibleKey", { encrypted: "fixture" });
    const catalog = () => runtime.runGlobalPluginAction(drawingPlugin.id, "model_catalog", { source: "compatible", target: "image" }, channel.id);
    assert.equal((await catalog()).models[0].id, "fixture-model");
    connection.config.customService = false;
    assert.equal((await catalog()).models[0].id, "fixture-model");
    console.log("Search host integration: installed worker, search citations, gallery links, original image transfer, attachment upload, migration and revocation passed");
  } finally {
    runtime?.clearChannelPluginPollTimers?.({ id: "bot" }); await shutdownPluginWorkers();
    const resolved = path.resolve(root); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("openbot-search-host-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
