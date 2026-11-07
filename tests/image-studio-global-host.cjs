"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const host = path.resolve(process.argv[2] || path.join(__dirname, "../../openbot"));
const hostRequire = require("node:module").createRequire(path.join(host, "package.json"));
const fromHost = name => hostRequire("./electron/lib/" + name);
const { createPluginCommands } = fromHost("commands/extensions/plugin-commands.cjs");
const { createChannelPluginRuntimeService, shutdownPluginWorkers } = fromHost("features/channels/channel-plugin-runtime-service.cjs");
const { pluginAuthorization, decidePluginAuthorization } = fromHost("plugins/plugin-authorization.cjs");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-image-global-")); let runtime;
  try {
    const store = { root, data: { channels: [], models: [] }, save() {}, async flush() {} };
    const arrays = name => store.data[name] ||= [];
    const secretStore = { encryptSecret: value => ({ encrypted: `sealed:${value}` }),
      isSecretEnvelope: value => !!value?.encrypted?.startsWith("sealed:"), decryptSecret: value => value.encrypted.slice(7) };
    const requests = [];
    const guardedFetch = async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.authorization });
      return Response.json({ data: [{ id: "gpt-image-2.6-flare" }] });
    };
    let commands = {};
    runtime = createChannelPluginRuntimeService({ fs, path, store, ensureStoreArray: arrays, secretStore, guardedFetch,
      readResponseBytes: async response => Buffer.from(await response.arrayBuffer()),
      resolveChannel: () => null, botPluginsFor: () => [], safeError: String, makeId: () => "test" });
    commands = { ...createPluginCommands({ fs, path, getStore: () => store, getCommands: () => commands, ensureStoreArray: arrays, secretStore, guardedFetch,
      unpackArgs: fromHost("app/runtime-utils.cjs").unpackArgs }),
      _runGlobalPluginAction: runtime.runGlobalPluginAction, _cancelGlobalPluginActions: runtime.cancelGlobalPluginActions,
      _validateGlobalPluginSettings: runtime.validateGlobalPluginSettings,
      _reconcileChannelPluginRuntime() {} };
    const installed = await commands.importPluginFromPath({ pluginPath: path.resolve(__dirname, "../plugins/image-studio") });
    assert.equal(installed.enabled, false, "new package remains stopped without configuration");
    const saved = store.data.plugins.find(plugin => plugin.id === "image-studio");
    decidePluginAuthorization(saved, pluginAuthorization(saved).fingerprint, true);
    await assert.rejects(commands.togglePlugin({ pluginId: saved.id, enabled: true }), /配置OpenAI API Key/);
    assert.equal(saved.enabled, false);
    const config = commands.getPluginGlobalSettings({ pluginId: saved.id }).config;
    assert.equal(config.provider, "openai-images", "new installations use the explicit OpenAI Images provider");
    assert.equal(config.globalConcurrency, 2); assert.equal(config.instanceConcurrencyDefault, 1);
    await commands.savePluginGlobalSettings({ pluginId: saved.id, config: { provider: "openai-images", globalHourly: 7 } });
    await assert.rejects(commands.savePluginGlobalSettings({ pluginId: saved.id, config: { instanceConcurrency: 4 } }), /未声明/);
    await assert.rejects(commands.setPluginGlobalSecret({ pluginId: saved.id, key: "undeclared", value: "x" }), /未声明/);
    await commands.setPluginGlobalSecret({ pluginId: saved.id, key: "openaiKey", value: "fixture-secret" });
    assert.equal(commands.getPluginGlobalSecretStatus({ pluginId: saved.id, key: "openaiKey" }).configured, true);
    assert(!JSON.stringify(commands.listInstalledPlugins()).includes("fixture-secret"));
    const models = await commands.runPluginGlobalAction({ pluginId: saved.id, actionId: "model_catalog", input: { source: "openai", target: "image" } });
    assert.equal(models.models[0].id, "gpt-image-2.6-flare");
    assert.equal(requests[0].url, "https://api.openai.com/v1/models");
    assert.equal(requests[0].authorization, "Bearer fixture-secret");
    assert(!JSON.stringify(models).includes("fixture-secret"));
    await commands.togglePlugin({ pluginId: saved.id, enabled: true });
    assert.equal(saved.enabled, true);
    store.persistConfigRow = async () => { throw Error("fixture disk conflict"); };
    await assert.rejects(commands.savePluginGlobalSettings({ pluginId: saved.id, config: { globalHourly: 8 } }), /disk conflict/);
    assert.equal(commands.getPluginGlobalSettings({ pluginId: saved.id }).config.globalHourly, 7, "a failed save restores the previous value");
    await assert.rejects(commands.setPluginGlobalSecret({ pluginId: saved.id, key: "openaiKey", value: "" }), /disk conflict/);
    assert.equal(saved.enabled, true, "a failed credential save restores the previous running state");
    assert.equal(commands.getPluginGlobalSecretStatus({ pluginId: saved.id, key: "openaiKey" }).configured, true);
    delete store.persistConfigRow;
    await commands.setPluginGlobalSecret({ pluginId: saved.id, key: "openaiKey", value: "" });
    assert.equal(saved.enabled, false, "removing the last configured service stops the plugin");
    saved.enabled = true;
    commands._markPluginGlobalReadiness();
    assert.equal(fromHost("plugins/plugin-global-settings.cjs").isStarting(saved), true);
    commands._initializePluginGlobalReadiness();
    for (let i = 0; fromHost("plugins/plugin-global-settings.cjs").isStarting(saved) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(saved.enabled, false, "startup rechecks restored configuration before enabling execution");
    assert.equal(store.data.channels.length, 0, "global settings require no instance");
    await commands.setPluginGlobalSecret({ pluginId: saved.id, key: "openaiKey", value: "fixture-secret" });
    await commands.uninstallPlugin({ pluginId: saved.id });
    assert.equal(store.data.pluginRetainedSettings.length, 1);
    await commands.importPluginFromPath({ pluginPath: path.resolve(__dirname, "../plugins/image-studio") });
    assert.equal(commands.getPluginGlobalSettings({ pluginId: saved.id }).config.globalHourly, 7);
    assert.equal(commands.getPluginGlobalSecretStatus({ pluginId: saved.id, key: "openaiKey" }).configured, true);
    assert(!JSON.stringify(commands.listInstalledPlugins()).includes("fixture-secret"));
    console.log("Image studio global host: no instance, encrypted credentials, model catalog, startup gating, revocation and uninstall/reinstall retention passed");
  } finally {
    await runtime?.pauseForDataSnapshot(); shutdownPluginWorkers();
    const resolved = path.resolve(root); assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("openbot-image-global-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
