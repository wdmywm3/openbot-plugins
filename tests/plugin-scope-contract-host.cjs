// Check the published declarations through the host's package reader and runtime registry.
"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const host = path.resolve(process.argv[2] || process.env.OPENBOT_HOST_ROOT);
const load = file => require(path.join(host, "electron/lib", file));
const { readRuntime } = load("plugins/plugin-install-package.cjs");
const { decidePluginAuthorization, pluginAuthorization } = load("plugins/plugin-authorization.cjs");
const { createChannelPluginRegistryService } = load("features/channels/channel-plugin-registry-service.cjs");
const { pluginOperationAccess } = load("features/channels/channel-operation-policy.cjs");
const { validatePluginOverrides } = load("plugins/plugin-config-validation.cjs");
const { deliveryTarget } = load("plugins/plugin-conversation-policy.cjs");
const entries = require("../catalog-v2.json").plugins;
const store = { data: { plugins: [], channels: [] } };
const arrays = key => store.data[key] ||= [];
const registry = createChannelPluginRegistryService({ store, ensureStoreArray: arrays });
const chat = "onebot:group:1", other = "onebot:group:2";
const makeBot = id => ({ id, enabled: true, config: { botPlugins: [], ownerUsers: ["host-owner"], chatOverrides: { [chat]: { pluginOverrides: {} } } } });
const a = makeBot("alpha"), b = makeBot("beta");
store.data.channels.push(a, b);
let groups = 0, chatFields = 0;
for (const { id, version } of entries) {
  const dir = path.resolve(__dirname, "../plugins", id);
  const { manifest, channelRuntime } = readRuntime(dir);
  const installed = { id, version: manifest.version, channelRuntime, permissions: manifest.permissions || [], enabled: true };
  decidePluginAuthorization(installed, pluginAuthorization(installed).fingerprint, true);
  store.data.plugins.push(installed);
  const local = registry.installedChannelPlugin(installed);
  a.config.botPlugins.push(local); b.config.botPlugins.push(structuredClone(local));
  const get = (bot, chatId = "", context) => registry.botPluginsFor(bot, chatId, context).find(p => p.id === id);
  for (const group of channelRuntime.ui?.settingsGroups || []) {
    groups++;
    const fields = channelRuntime.configSchema.properties;
    for (const key of group.fields) {
      const rule = fields[key], initial = local.config[key];
      const value = rule.enum?.find(item => item !== initial) ?? (rule.type === "boolean" ? !initial :
        rule.type === "array" ? ["custom"] : ["number", "integer"].includes(rule.type) ? (rule.minimum === initial ? initial + 1 : rule.minimum ?? 0) : "custom");
      local.config[group.mode] = true; local.config[key] = value;
      assert.deepEqual(get(a).config[key], value, id + "." + key);
      assert.deepEqual(get(b).config[key], initial);
      local.config[group.mode] = false;
      assert.deepEqual(get(a).config[key], initial);
      const overrides = { [id]: { configOverrides: { [key]: value } } };
      a.config.chatOverrides[chat].pluginOverrides = overrides;
      if (rule.chatOverride) {
        chatFields++; validatePluginOverrides(overrides, [local], [installed]);
        assert.deepEqual(get(a, chat).config[key], value);
        assert.deepEqual(get(a, other).config[key], initial); assert.deepEqual(get(a).config[key], initial);
      } else {
        assert.throws(() => validatePluginOverrides(overrides, [local], [installed]));
        assert.deepEqual(get(a, chat).config[key], initial);
      }
      delete a.config.chatOverrides[chat].pluginOverrides[id];
      assert.deepEqual(get(a, chat).config[key], initial);
    }
  }
  if (id === "content-monitor" || id === "computer-use") {
    assert.equal(get(a, chat).enabled, false);
    const caller = { chatId: chat, messageType: "group", source: "channel", senderId: "outsider", role: "member" };
    const declaration = (local.commands || [])[0] || local.tools[0];
    const operation = load("features/channels/channel-operation-policy.cjs").pluginOperation(local, declaration);
    a.config.commandPolicy = { rules: { [operation.id]: { subjects: ["everyone"], contexts: ["group"] } } };
    assert.deepEqual(pluginOperationAccess(a, local, declaration, caller, caller), { allowed: false, reason: "此插件操作仅支持私聊" });
    const privateCaller = { ...caller, chatId: "onebot:private:outsider", messageType: "private" };
    assert.deepEqual(pluginOperationAccess(a, local, declaration, privateCaller, privateCaller), { allowed: false, reason: "此插件操作仅允许主人使用" });
    if (id === "content-monitor") {
      assert.equal(get(a, chat, { [deliveryTarget]: true }).enabled, true);
      a.config.chatOverrides[chat].pluginOverrides[id] = { mode: "disabled" };
      assert.equal(get(a, chat, { [deliveryTarget]: true }).enabled, false);
    }
  }
}
async function checkWorkerConfiguration() {
  const os = require("node:os");
  const { createChannelPluginRuntimeService, shutdownPluginWorkers } = load("features/channels/channel-plugin-runtime-service.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-scope-worker-"));
  store.root = root; store.save = () => {}; store.flush = async () => {};
  const runtime = createChannelPluginRuntimeService({ fs, path, store, resolveChannel: id => store.data.channels.find(bot => bot.id === id),
    ensureStoreArray: arrays, botPluginsFor: registry.botPluginsFor });
  const pluginId = "random-toolbox";
  const run = chatId => runtime.runScheduledPlugin({ channelId: a.id, pluginId, chatId, content: "/random 1 8" },
    { senderId: "host-owner", messageType: "group" }, { runId: "scope-test", signal: new AbortController().signal, assertActive() {} });
  try {
    const installed = store.data.plugins.find(row => row.id === pluginId);
    installed.globalSettings = { maxRange: 20 };
    a.config.chatOverrides[chat].pluginOverrides[pluginId] = { configOverrides: { maxRange: 3 } };
    assert.match((await run(chat)).text, /最大跨度为 3/);
    assert.match((await run(other)).text, /1 到 8/);
    delete a.config.chatOverrides[chat].pluginOverrides[pluginId];
    assert.match((await run(chat)).text, /1 到 8/);
  } finally {
    await runtime.pauseForDataSnapshot(); await shutdownPluginWorkers();
    assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true });
  }
}
checkWorkerConfiguration().catch(error => { console.error(error); process.exitCode = 1; });
const packages = path.resolve(__dirname, "../plugins");
const packageIds = fs.readdirSync(packages, { withFileTypes: true })
  .filter(dir => dir.isDirectory() && fs.existsSync(path.join(packages, dir.name, "plugin.json")))
  .map(dir => dir.name);
assert.deepEqual(entries.map(entry => entry.id).sort(), packageIds.sort());
assert(groups > 10 && chatFields > 10);
console.log(entries.length, "packages checked;", groups, "instance groups;", chatFields, "chat fields; caller ceilings and independent delivery passed");
