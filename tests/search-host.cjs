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
    const plugin = { ...channel.config.botPlugins[0], authorization: pluginAuthorization(saved), config: { webProvider: "tavily", imageProvider: "google" } };
    registry.setPluginState(channel, "search", "channel", "bot", "secret:googleKey", { encrypted: "fixture" });
    const file = sessionAssetWritePath({ path, root, sessionId: "conversation", kind: "images", fileName: "source.png" });
    const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(65000, 1)]); fs.writeFileSync(file, bytes);
    const message = { id: "source", chatId: "chat", media: [{ type: "image", assetRef: sessionAssetRef("conversation", "images", "source.png") }] };
    let requests = 0;
    runtime = createChannelPluginRuntimeService({ fs, path, store, ensureStoreArray: arrays, resolveChannel: id => id === "bot" ? channel : null,
      botPluginsFor: () => [plugin], makeId: () => "fixture", safeError: String, isNapCatOneBotChannel: () => false,
      getPluginState: registry.getPluginState, setPluginState: registry.setPluginState, pluginStateScopeId: registry.pluginStateScopeId,
      channelEventByReference: (_channel, chat, id) => chat === "chat" && id === "source" ? message : null,
      secretStore: { isSecretEnvelope: value => value?.encrypted === "fixture", decryptSecret: () => "fixture-key" },
      readResponseBytes: async (response, max) => { const data = Buffer.from(await response.arrayBuffer()); assert.ok(data.length <= max); return data; },
      guardedFetch: async (url, options) => {
        requests++;
        if (url === "https://api.anysearch.com/mcp" && process.argv.includes("--live-anysearch")) return fetch(url, options);
        const body = JSON.parse(options.body);
        if (url === "https://vision.googleapis.com/v1/images:annotate") {
          assert.equal(body.requests[0].image.content, bytes.toString("base64"));
          assert.equal(options.headers["x-goog-api-key"], "fixture-key");
          return Response.json({ responses: [{ webDetection: { pagesWithMatchingImages: [{ url: "https://example.org/source", pageTitle: "Source" }] } }] });
        }
        assert.equal(url, "https://api.tavily.com/search"); assert.equal(body.api_key, "fixture-key");
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
    console.log("Search host integration: managed installation, encrypted migration, native worker, 65 KiB attachment upload, legacy dispatch and revocation passed");
  } finally {
    runtime?.clearChannelPluginPollTimers?.({ id: "bot" }); await shutdownPluginWorkers();
    const resolved = path.resolve(root); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("openbot-search-host-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
