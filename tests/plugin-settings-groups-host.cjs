// Integration test against the actual desktop forms, local packages and encrypted state.
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const host = path.resolve(process.argv[2] || ".");
const { _electron: electron } = require(require.resolve("playwright", { paths: [host] }));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-group-settings-"));
const source = path.resolve(__dirname, "../plugins");
(async () => {
  let app;
  try {
    app = await electron.launch({ args: [path.join(host, "electron/main.cjs"), "--user-data-dir=" + fixture],
      env: { ...process.env, OPENBOT_LOAD_DIST: "1", OPENBOT_DISABLE_AUTO_UPDATE: "1", OPENBOT_DISABLE_MANAGED_NTQQ: "1" } });
    const page = await app.firstWindow({ timeout: 90000 }); page.setDefaultTimeout(15000);
    page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
    const invoke = (action, args) => page.evaluate(({ action, args }) => window.openbot.invokeAction(action, args), { action, args });
    await page.locator(".openbot-root").waitFor();
    const add = (name, selfId) => invoke("addChannel", { name, config: { selfId, provider: "napcat-onebot",
      napcatMode: "external", onebotTransport: "forward-ws", wsUrl: "ws://127.0.0.1:1", token: "fixture" } });
    const a = await add("配置甲", "12340001"), b = await add("配置乙", "12340002");
    const install = async dir => {
      const plugin = await invoke("importPluginFromPath", { pluginPath: dir });
      await invoke("authorizePlugin", { pluginId: plugin.id, fingerprint: plugin.authorization.fingerprint, approved: true });
    };
    // Simulate an older binding with just an instance key and unchanged provider.
    const old = path.join(fixture, "previous-search");
    fs.cpSync(path.join(source, "search"), old, { recursive: true });
    const file = path.join(old, "plugin.json"), manifest = JSON.parse(fs.readFileSync(file));
    const ext = manifest.extensions["com.openbot"]; manifest.version = "0.2.0";
    delete ext.configSchema.properties.customWeb; delete ext.configSchema.properties.customImage;
    for (const field of Object.values(ext.configSchema.properties)) delete field.scope;
    ext.ui.sections = ext.ui.globalSections; delete ext.ui.settingsGroups; delete ext.ui.globalSections;
    fs.writeFileSync(file, JSON.stringify(manifest));
    await install(old);
    await invoke("setChannelPluginSecret", { channelId: a.id, pluginId: "search", key: "anysearchKey", value: "instance-only" });
    await install(path.join(source, "search")); await install(path.join(source, "image-studio"));
    const binding = async name => (await invoke("getChannelConfig", { name })).botPlugins.find(row => row.id === "search");
    assert.equal((await binding(a.name)).config.customWeb, true);
    assert.equal((await binding(b.name)).config.customWeb, false);
    assert.equal((await invoke("getPluginGlobalSecretStatus", { pluginId: "search", key: "anysearchKey" })).configured, false);
    const market = async (label, capability = "插件") => {
      await page.locator(".openbot-sidebar").getByRole("button", { name: "插件", exact: true }).click();
      await page.getByRole("tablist", { name: "插件能力" }).getByRole("tab", { name: capability, exact: true }).click();
      await page.getByRole("button", { name: "查看 " + label, exact: true }).click();
    };
    await market("搜索");
    await page.getByRole("button", { name: "默认配置", exact: true }).click();
    await page.getByLabel("网页搜索", { exact: true }).selectOption({ label: "Tavily" });
    await page.getByLabel("Tavily API Key").fill("plugin-default");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "返回插件详情" }).click();
    await page.getByRole("button", { name: b.name, exact: true }).click();
    const web = page.locator("#customWeb"); await web.waitFor();
    assert.match(await web.locator("option:checked").innerText(), /跟随插件默认（Tavily）/);
    assert.equal(await page.getByLabel("Tavily API Key").count(), 0);
    await web.selectOption("custom");
    await page.locator(".instance-plugin-config .plugin-setting-fields select").first().selectOption({ label: "Brave Search" });
    await page.waitForFunction(async name => {
      const c = await window.openbot.invokeAction("getChannelConfig", { name });
      return c.botPlugins.find(p => p.id === "search")?.config.webProvider === "brave";
    }, b.name);
    await web.selectOption("default");
    await page.waitForFunction(async name => !(await window.openbot.invokeAction("getChannelConfig", { name }))
      .botPlugins.find(p => p.id === "search").config.customWeb, b.name);
    assert.equal((await binding(a.name)).config.customWeb, true);
    await market("画图");
    await page.getByRole("button", { name: a.name, exact: true }).click();
    await page.locator("#customOutput").selectOption("custom");
    await page.getByLabel("默认画质").selectOption({ label: "高" });
    await page.waitForFunction(async name => (await window.openbot.invokeAction("getChannelConfig", { name }))
      .botPlugins.find(p => p.id === "image-studio")?.config.quality === "high", a.name);
    assert.equal(await page.locator("#customService").inputValue(), "default");
    await page.locator('.instance-plugin-config[aria-busy="false"]').waitFor();
    await page.locator(".openbot-sidebar").getByRole("button", { name: "设置", exact: true }).click();
    for (const [id, name, allowed, hidden] of [
      ["group-digest", "群聊总结", "群聊", "私聊"],
      ["content-monitor", "内容监控", "私聊", "群聊"],
    ]) {
      await install(path.join(source, id));
      await market(name, id === "group-digest" ? "指令" : "插件");
      await page.getByRole("button", { name: a.name, exact: true }).click();
      await page.locator(".channel-plugin-detail .channel-detail-heading strong").filter({ hasText: name }).waitFor();
      const declared = (await invoke("listInstalledChannelPlugins", {})).find(row => row.id === id).definition.ui.chatAudiences;
      assert(declared?.length, "missing audience in desktop definition: " + id);
      const scopes = page.locator(".channel-plugin-scope");
      await scopes.getByRole("group", { name: allowed, exact: true }).waitFor();
      await scopes.getByRole("group", { name: hidden, exact: true }).waitFor({ state: "hidden" });
      if (id === "content-monitor") assert.equal(await scopes.getByRole("checkbox").count(), 1);
      await page.locator(".openbot-sidebar").getByRole("button", { name: "设置", exact: true }).click();
    }
    console.log("Desktop: caller selection respects package chat and role declarations;");
    console.log("Desktop: old key-only upgrade, independent instance modes, live default summary, local output and persistence passed.");
  } finally {
    await app?.close();
    assert.equal(path.dirname(fixture), os.tmpdir());
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
