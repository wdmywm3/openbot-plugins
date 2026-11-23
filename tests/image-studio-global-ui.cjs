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
    step = "上传并替换生图 Skill";
    const skillRow = page.locator(".plugin-setting-row").filter({ hasText: "生图 Skill" });
    const uploadGuide = async (file, button) => {
      await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, file);
      await skillRow.getByText(button, { exact: true }).click();
      await skillRow.getByText(path.basename(file), { exact: true }).waitFor();
    };
    const markdown = path.join(root, "构图.md");
    fs.writeFileSync(markdown, "# 我的构图指南\n由焦点写到背景。");
    await uploadGuide(markdown, "上传文件");
    const JSZip = hostRequire("jszip");
    const invalid = path.join(root, "缺少正文.zip");
    fs.writeFileSync(invalid, await new JSZip().file("references/light.md", "参考文档").generateAsync({ type: "nodebuffer" }));
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, invalid);
    await skillRow.getByText("替换文件", { exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "ZIP 中缺少 SKILL.md" }).waitFor();
    assert.equal((await invoke("managePluginSkill", { pluginId: installed.id, action: "status" })).fileName, "构图.md");
    await skillRow.getByText("恢复默认", { exact: true }).click();
    await skillRow.getByText("插件默认", { exact: true }).waitFor();
    const bundle = new JSZip(), archive = path.join(root, "光影.zip");
    bundle.file("guide/SKILL.md", "---\nname: custom\ndescription: 写作试用\n---\n先选主光方向，再读取 references/light.md。");
    bundle.file("guide/references/light.md", "暖窗光照在杯沿上。");
    fs.writeFileSync(archive, await bundle.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    await uploadGuide(archive, "上传文件");
    await page.getByRole("tab", { name: "用量", exact: true }).click();
    await page.getByLabel("总并发数", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("总并发数", { exact: true }).inputValue(), "4");
    assert.equal(await page.getByLabel("每个实例默认并发数", { exact: true }).inputValue(), "2");
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
    assert.equal(await page.getByLabel("画图模型", { exact: true }).inputValue(), "");
    await page.getByRole("tab", { name: "设置", exact: true }).click();
    await invoke("setPluginGlobalSecret", { pluginId: "image-studio", key: "openaiKey", value: "fixture-not-a-real-key" });
    assert.equal((await invoke("getPluginGlobalSecretStatus", { pluginId: "image-studio", key: "openaiKey" })).configured, true);
    await invoke("savePluginGlobalSettings", { pluginId: "image-studio", config: { openaiImageModel: "gpt-image-2.6-sunburst" } });
    await invoke("togglePlugin", { pluginId: "image-studio", enabled: true });
    const channel = await invoke("addChannel", { config: { name: "离线测试实例", platform: "qq", provider: "napcat-onebot", enabled: false,
      napcatMode: "external", onebotTransport: "forward-ws", wsUrl: "ws://127.0.0.1:1", token: "fixture", selfId: "10001" } });
    assert.equal(channel.enabled, false);
    const skillScope = { channelId: channel.id, chatId: "onebot:group:123" };
    await invoke("setChannelPluginEnabled", { channelId: channel.id, pluginId: installed.id, enabled: true });
    const custom = (await invoke("listChannelPluginSkills", skillScope)).filter(skill => skill.name.startsWith("image-studio:"));
    assert.deepEqual(custom.map(skill => [skill.name, skill.description, skill.files]), [["image-studio:imagegen", "写作试用", ["references/light.md"]]]);
    assert.equal(custom[0].content, "先选主光方向，再读取 references/light.md。");
    step = "打开实例设置";
    await page.locator(".settings-page-back").click();
    await page.getByRole("button", { name: "离线测试实例", exact: true }).click();
    const access = page.getByRole("switch", { name: "允许非主人画图", exact: true });
    assert.equal(await access.getAttribute("aria-checked"), "false");
    await access.click();
    await page.waitForFunction(async channelId => {
      const config = await window.openbot.invokeAction("getChannelConfig", { channelId });
      return config.botPlugins?.find(plugin => plugin.id === "image-studio")?.config?.allowNonOwnerDrawing === true;
    }, channel.id);
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
    assert.equal((await again("managePluginSkill", { pluginId: installed.id, action: "status" })).fileName, "光影.zip");
    assert.equal((await again("listChannelPluginSkills", skillScope)).find(skill => skill.name === "image-studio:imagegen").content, custom[0].content);
    await again("managePluginSkill", { pluginId: installed.id, action: "reset" });
    const restored = (await again("listChannelPluginSkills", skillScope)).filter(skill => skill.name.startsWith("image-studio:"));
    assert.deepEqual(restored.map(skill => skill.name).sort(), ["image-studio:gpt-image", "image-studio:imagegen"]);
    await again("setPluginGlobalSecret", { pluginId: "image-studio", key: "openaiKey", value: "" });
    assert.equal((await again("listInstalledPlugins", {})).find(plugin => plugin.id === "image-studio").enabled, false);
    console.log("Image studio real UI: Markdown/ZIP upload, invalid replacement, skill catalog after restart and default restoration, settings and startup gating passed");
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
