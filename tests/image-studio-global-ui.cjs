"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const host = path.resolve(process.argv[2] || path.join(__dirname, "../../openbot"));
const hostRequire = require("node:module").createRequire(path.join(host, "package.json"));
const { _electron: electron } = hostRequire("playwright");
let step = "启动";

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-image-global-ui-")); let app;
  try {
    fs.writeFileSync(path.join(root, "openbot-index.json"), JSON.stringify({ settings: { language: "zh-CN", hideToTray: false } }));
    app = await electron.launch({ args: [path.join(host, "electron/main.cjs"), `--user-data-dir=${root}`],
      env: { ...process.env, OPENBOT_LOAD_DIST: "1", OPENBOT_DISABLE_AUTO_UPDATE: "1", OPENBOT_DISABLE_MANAGED_NTQQ: "1" } });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on("dialog", dialog => { void dialog.accept().catch(() => {}); });
    await page.waitForFunction(() => !!window.openbot);
    const invoke = (action, args) => page.evaluate(({ action, args }) => window.openbot.invokeAction(action, args), { action, args });
    step = "导入和授权";
    const installed = await invoke("importPluginFromPath", { pluginPath: path.resolve(__dirname, "../plugins/image-studio") });
    await invoke("authorizePlugin", { pluginId: installed.id, fingerprint: installed.authorization.fingerprint, approved: true });
    step = "打开插件全局设置";
    await page.locator(".openbot-sidebar").getByRole("button", { name: "插件", exact: true }).click();
    await page.getByRole("button", { name: "查看 画图", exact: true }).click();
    await page.getByText("尚无实例，创建后可在这里开启插件。", { exact: true }).waitFor();
    await page.locator(".settings-page-actions").getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("tab", { name: "用量", exact: true }).click();
    await page.getByLabel("总并发数", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("总并发数", { exact: true }).inputValue(), "2");
    assert.equal(await page.getByLabel("每个实例默认并发数", { exact: true }).inputValue(), "1");
    step = "修改并保存限额";
    await page.getByLabel("总并发数", { exact: true }).fill("3");
    for (let i = 0; i < 100; i++) {
      if ((await invoke("getPluginGlobalSettings", { pluginId: "image-studio" })).config.globalConcurrency === 3) break;
      await page.waitForTimeout(50);
    }
    const savedConcurrency = (await invoke("getPluginGlobalSettings", { pluginId: "image-studio" })).config.globalConcurrency;
    if (savedConcurrency !== 3) throw new Error(`并发设置未保存，提示：${(await page.locator('[role="alert"]').allTextContents()).join(" | ")}`);
    await page.getByRole("tab", { name: "OpenAI", exact: true }).click();
    step = "验证凭据和启动";
    await page.getByLabel("OpenAI API Key", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "设置", exact: true }).click();
    await invoke("setPluginGlobalSecret", { pluginId: "image-studio", key: "openaiKey", value: "fixture-not-a-real-key" });
    assert.equal((await invoke("getPluginGlobalSecretStatus", { pluginId: "image-studio", key: "openaiKey" })).configured, true);
    await invoke("togglePlugin", { pluginId: "image-studio", enabled: true });
    const channel = await invoke("addChannel", { config: { name: "离线测试实例", platform: "qq", provider: "napcat-onebot", enabled: false,
      napcatMode: "external", onebotTransport: "forward-ws", wsUrl: "ws://127.0.0.1:1", token: "fixture", selfId: "10001" } });
    assert.equal(channel.enabled, false);
    step = "打开实例设置";
    await page.locator(".settings-page-back").click();
    await page.getByRole("button", { name: "离线测试实例", exact: true }).click();
    await page.locator(".channel-plugin-detail").getByRole("tab", { name: "用量", exact: true }).click();
    await page.getByLabel("并发数", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("并发数", { exact: true }).inputValue(), "0");
    await page.getByLabel("每小时上限", { exact: true }).waitFor();
    step = "重启后检查设置";
    await page.waitForTimeout(500);
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null;
    app = await electron.launch({ args: [path.join(host, "electron/main.cjs"), `--user-data-dir=${root}`],
      env: { ...process.env, OPENBOT_LOAD_DIST: "1", OPENBOT_DISABLE_AUTO_UPDATE: "1", OPENBOT_DISABLE_MANAGED_NTQQ: "1" } });
    const restarted = await app.firstWindow(); restarted.on("dialog", dialog => { void dialog.accept().catch(() => {}); });
    await restarted.waitForFunction(() => !!window.openbot);
    const again = (action, args) => restarted.evaluate(({ action, args }) => window.openbot.invokeAction(action, args), { action, args });
    assert.equal((await again("getPluginGlobalSettings", { pluginId: "image-studio" })).config.globalConcurrency, 3);
    assert.equal((await again("getPluginGlobalSecretStatus", { pluginId: "image-studio", key: "openaiKey" })).configured, true);
    let running = false;
    for (let i = 0; i < 200 && !running; i++) {
      running = (await again("listInstalledPlugins", {})).some(plugin => plugin.id === "image-studio" && plugin.enabled);
      if (!running) await restarted.waitForTimeout(50);
    }
    assert.equal(running, true, "a configured service passes the startup check after restart");
    await again("setPluginGlobalSecret", { pluginId: "image-studio", key: "openaiKey", value: "" });
    assert.equal((await again("listInstalledPlugins", {})).find(plugin => plugin.id === "image-studio").enabled, false);
    console.log("Image studio real UI: no-instance settings, encrypted key, startup gating, restart and per-instance overrides passed");
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      const closed = await Promise.race([app.close().then(() => true, () => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
      if (!closed) app.process().kill();
    }
    const resolved = path.resolve(root); assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("openbot-image-global-ui-"));
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { console.error(`临时测试目录未清理：${error.message}`); }
  }
})().catch(error => { console.error(`步骤：${step}`, error); process.exitCode = 1; });
