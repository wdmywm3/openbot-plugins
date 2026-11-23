"use strict";

// Windows integration test. Only the temporary store and the tagged test window are used.
const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { setTimeout: delay } = require("node:timers/promises");
const { promisify } = require("node:util");

async function verifyForeground({ invoke, target, x, y, python, requireForeground, token }) {
  const script = path.join(__dirname, "fixtures/computer-use-foreground.py");
  const probe = async (expected = 0) => {
    const { stdout } = await promisify(execFile)(python,
      ["-I", "-B", script, String(expected)], { windowsHide: true });
    return JSON.parse(stdout);
  };
  const original = await probe();
  for (const shape of ["Button", "Canvas"]) {
    const state = (await invoke("view", { ...target, image: shape === "Canvas" })).result;
    const point = shape === "Canvas" ? { x, y } : { element: token(state, /\[(\d+)\] Button "Foreground button"/) };
    const input = { view: state.view, action: "click", foreground: true, ...point };
    if (!original.receivesInput) {
      await assert.rejects(invoke("act", input), /foreground_desktop_inactive/);
      await assert.rejects(invoke("act", input), /观察已失效/);
      assert.ok(!(await invoke("view", target)).result.tree.includes(shape + " clicks"));
      continue;
    }
    const watcher = spawn(python, ["-I", "-B", script, "--watch", String(target.window_id)],
      { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
    const lines = readline.createInterface({ input: watcher.stdout });
    const ended = once(watcher, "close");
    try {
      assert.equal((await once(lines, "line", { signal: AbortSignal.timeout(4000) }))[0], "ready");
      const result = (await invoke("act", input)).result;
      assert.match(result.driver_result, /SendInput/);
      assert.equal((await ended)[0], 0, "Windows must place the exact target window in the foreground");
    } finally {
      lines.close();
      if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill();
      await ended;
    }
    const expected = shape + " clicks 1 focused true";
    const deadline = Date.now() + 2000;
    let tree;
    do {
      tree = (await invoke("view", { ...target, query: expected })).result.tree;
      if (tree.includes(expected)) break;
      await delay(50);
    } while (Date.now() < deadline);
    assert.ok(tree.includes(expected), shape + " must receive exactly one real pointer click while focused");
    if (original.foreground && original.foreground !== target.window_id) {
      assert.equal((await probe(original.foreground)).foreground, original.foreground, "previous foreground window restored");
    }
  }
  await invoke("finish", {});
  if (requireForeground && !original.receivesInput) throw Error("当前 Windows 桌面未接收键鼠输入。已验证拒绝前台点击，交互桌面验收未通过。");
  console.log(original.receivesInput ? "Foreground: verified button and canvas received one focused SendInput click each."
    : "Foreground: verified no clicks on a desktop that does not receive input. Interactive delivery not exercised.");
}

async function main() {
  if (process.platform !== "win32") return console.log("Computer use requires a Windows x64 desktop.");
  if (!process.argv[2]) throw Error("Usage: node tests/computer-use-host.cjs <OpenBot checkout>");
  const host = createRequire(path.resolve(process.argv[2], "package.json"));
  const { createPluginCommands } = host("./electron/lib/commands/extensions/plugin-commands.cjs");
  const { createChannelPluginRegistryService } = host("./electron/lib/features/channels/channel-plugin-registry-service.cjs");
  const { createChannelPluginRuntimeService, shutdownPluginWorkers } = host("./electron/lib/features/channels/channel-plugin-runtime-service.cjs");
  const { createExternalMcpService } = host("./electron/lib/features/mcp-external-service.cjs");
  const { createPluginToolService } = host("./electron/lib/plugins/plugin-tools.cjs");
  const { channelPrincipalForMessage } = host("./electron/lib/features/channels/channel-permissions.cjs");

  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "openbot-cu-host-"));
  const channels = ["test-a", "test-b"].map(id => ({ id, name: id, platform: "qq", enabled: true,
    config: { provider: "napcat-onebot", selfId: "881", ownerUsers: ["101"] } }));
  const store = { root, data: { channels, settings: {}, sessions: [], mcps: [] }, save() {}, async flush() {} };
  const array = key => store.data[key] ||= [];
  const resolveChannel = id => channels.find(c => c.id === id);
  const registry = createChannelPluginRegistryService({ fs, path, store, ensureStoreArray: array,
    getCommands: () => ({}), getChatOverride: () => ({}), profileList: v => v || [] });
  const installer = createPluginCommands({ fs, path, getStore: () => store, ensureStoreArray: array, getCommands: () => ({}) });
  const mcp = createExternalMcpService({ getStore: () => store, getPlugins: (id, chat, ctx) => registry.botPluginsFor(resolveChannel(id), chat, ctx),
    secretStore: { encryptSecret: v => v, hydrateSecretMap: v => v } });
  const pluginTools = createPluginToolService({ entries: () => store.data.mcps, request: (...args) => mcp.request(...args), allowedTools: async () => [] });
  const runtime = createChannelPluginRuntimeService({ fs, path, store, ensureStoreArray: array, resolveChannel, pluginTools,
    botPluginsFor: registry.botPluginsFor, getPluginState: registry.getPluginState, setPluginState: registry.setPluginState,
    pluginStateScopeId: registry.pluginStateScopeId, makeId: prefix => prefix + "-" + randomUUID(), safeError: e => e.message, isNapCatOneBotChannel: () => true });

  const context = (channel, sender = "101", type = "private") => ({ purpose: "chat", requestId: randomUUID(),
    channelPrincipal: channelPrincipalForMessage(channel, { id: randomUUID(), chatId: "onebot:" + type + ":" + (type === "group" ? "42" : sender),
      messageType: type, sender: { id: sender, role: "member" } }) });
  const [a, b] = channels.map(channel => context(channel));
  async function invoke(tool, input, ctx = a, key = randomUUID()) {
    const name = "plugin__computer-use__" + tool;
    let job = await runtime.runNativePluginTool(name, { action: "start", requestKey: key, input }, ctx);
    const deadline = Date.now() + 30000;
    while (job.status === "running" && Date.now() < deadline) {
      await delay(80);
      job = await runtime.runNativePluginTool(name, { action: "status", jobId: job.id }, ctx);
    }
    if (job.status !== "completed") throw Error(String(job.error || job.status));
    return job;
  }
  const token = (state, pattern) => {
    const row = state.tree.match(pattern);
    assert.ok(row, "expected fixture control in the UIA tree");
    return state.snapshot + ":" + row[1];
  };
  let form, canvas;
  try {
    const loaded = await installer.importPluginFromPath({ pluginPath: path.resolve(__dirname, "../plugins/computer-use") });
    assert.equal(loaded.authorization.status, "pending");
    assert.equal(runtime.pluginToolSchemas(a).length, 0);
    await installer.authorizePlugin({ pluginId: loaded.id, fingerprint: loaded.authorization.fingerprint, approved: true });
    await mcp.startPlugin(loaded.id);
    assert.equal(store.data.mcps.filter(e => e.pluginId === loaded.id).length, 2);
    assert.equal(runtime.pluginToolSchemas(a).length, 6);
    assert.equal(runtime.pluginToolSchemas(context(channels[0], "202")).length, 0);
    assert.equal(runtime.pluginToolSchemas(context(channels[0], "101", "group")).length, 0);
    const entry = store.data.mcps.find(e => e.channelId === channels[0].id && e.pluginId === loaded.id);
    assert.deepEqual((await mcp.request(entry.id, "tools/list", {}, a)).tools, []);
    await assert.rejects(mcp.request(entry.id, "tools/call", { name: "desktop_step", arguments: {} }, a), /未获授权/);
    await assert.rejects(invoke("open_app", { name: "OpenBot Fixture" }), /允许打开应用或激活窗口/);

    const title = "OpenBot-CU-" + randomUUID(), pauseFile = path.join(root, "pause-test-window");
    form = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-File",
      path.join(__dirname, "fixtures/computer-use-window.ps1"), "-WindowTitle", title, "-PauseRequest", pauseFile],
    { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
    const lines = readline.createInterface({ input: form.stdout });
    const win = JSON.parse((await once(lines, "line", { signal: AbortSignal.timeout(12000) }))[0]);
    lines.close();
    const target = { pid: win.pid, window_id: win.window_id };
    const windows = (await invoke("windows", { pid: win.pid, query: title })).result.windows;
    assert.ok(windows.some(w => w.window_id === target.window_id && w.title === title));
    const initial = await invoke("view", { ...target, image: true });
    assert.ok(initial.userContextBlocks.some(part => part.type === "image_url"));
    assert.ok(!initial.result.url);
    await assert.rejects(invoke("view", target, b), /另一个实例/);
    const otherTurn = context(channels[0]);
    assert.equal((await invoke("finish", {}, otherTurn)).result.released, false);
    await assert.rejects(invoke("view", target, otherTurn), /另一项任务/);
    const text = "明天下午三点开会";
    const type = { view: initial.result.view, action: "type", element: token(initial.result, /\[(\d+)\] Edit/), text };
    await assert.rejects(invoke("act", { ...type, foreground: true }), /允许打开应用或激活窗口/);
    const key = randomUUID();
    const typed = await invoke("act", type, a, key);
    assert.equal((await invoke("act", type, a, key)).id, typed.id);
    await assert.rejects(invoke("act", type), /观察已失效/);
    const updated = (await invoke("view", target)).result;
    assert.ok(updated.tree.includes(text), "Chinese text read back from the actual edit control");
    await invoke("act", { view: updated.view, action: "click", element: token(updated, /\[(\d+)\] Button "Verify"/) });
    const captured = await invoke("screenshot", target);
    assert.ok(captured.result.tree.includes('Button "Verified"'));
    assert.ok(captured.result.url && captured.userContextBlocks.some(part => part.type === "image_url"));
    await invoke("act", { view: captured.result.view, action: "click", x: win.x, y: win.y });
    assert.ok((await invoke("view", target)).result.tree.includes('Button "Clicked twice"'), "window-local screenshot coordinates including display scaling");
    assert.equal((await invoke("finish", {})).result.released, true);
    fs.writeFileSync(pauseFile, "");
    const pauseDeadline = Date.now() + 4000;
    while (!fs.existsSync(pauseFile + ".started") && Date.now() < pauseDeadline) await delay(30);
    assert.ok(fs.existsSync(pauseFile + ".started"));
    const slow = await runtime.runNativePluginTool("plugin__computer-use__view",
      { action: "start", requestKey: randomUUID(), input: target }, a);
    assert.equal(slow.status, "running", "the blocked test UI should yield a cancellable job");
    const canceled = await runtime.runNativePluginTool("plugin__computer-use__view", { action: "cancel", jobId: slow.id }, a);
    assert.ok(["interrupted", "canceled", "canceling"].includes(canceled.status), canceled.status);
    await delay(4600);
    assert.equal(mcp.pluginStatus(loaded.id).state, "running", "canceling a stalled driver call keeps both MCP services running");
    const next = await invoke("view", target, b);
    assert.ok(next.result.tree.includes(text));
    await assert.rejects(invoke("act", type, b), /观察已失效/);
    await invoke("act", { view: next.result.view, action: "click", element: token(next.result, /\[(\d+)\] Button "Minimize fixture"/) }, b);
    await assert.rejects(invoke("screenshot", target, b), /最小化/);
    await invoke("finish", {}, b);

    const canvasEnv = { ...process.env };
    delete canvasEnv.ELECTRON_RUN_AS_NODE;
    canvas = spawn(host("electron"), [path.join(__dirname, "fixtures/computer-use-canvas.cjs"), root],
      { env: canvasEnv, windowsHide: true, stdio: "ignore" });
    const ready = path.join(root, "canvas.json"), canvasDeadline = Date.now() + 10000;
    while (!fs.existsSync(ready) && Date.now() < canvasDeadline) await delay(50);
    const { pid, window_id, x, y, foregroundX } = JSON.parse(fs.readFileSync(ready, "utf8"));
    const before = (await invoke("view", { pid, window_id, image: true })).result;
    assert.ok(before.tree.includes("Untouched canvas") && !before.tree.includes("Canvas clicked"));
    await invoke("act", { view: before.view, action: "click", x, y });
    assert.ok((await invoke("view", { pid, window_id, query: "Canvas clicked" })).result.tree.includes("Canvas clicked"));
    await invoke("finish", {});

    // Change just one temporary instance's setting and check both native and driver gates.
    channels[0].config.botPlugins.find(plugin => plugin.id === loaded.id).config.allowForeground = true;
    await mcp.syncPlugins();
    await assert.rejects(invoke("open_app", { name: "invalid/path" }), /应用显示名称/);
    await assert.rejects(invoke("open_app", { name: "invalid/path" }, b), /允许打开应用或激活窗口/);
    const installed = store.data.plugins.find(plugin => plugin.id === loaded.id);
    const { python } = host("./electron/lib/plugins/plugin-environment.cjs").readEnvironment(root, installed);
    await verifyForeground({ invoke, target: { pid, window_id }, x: foregroundX, y, python, token,
      requireForeground: process.argv.includes("--require-foreground") });
    await installer.authorizePlugin({ pluginId: loaded.id, fingerprint: loaded.authorization.fingerprint, approved: false });
    await mcp.syncPlugins();
    assert.equal(runtime.pluginToolSchemas(a).length, 0);
    console.log("Computer use: managed install, private routing, Chinese input, UIA/pixel clicks, Electron canvas, screenshots, minimized window, stale input, per-instance settings, multi-instance exclusion, cancellation and revocation passed.");
  } finally {
    if (form && form.exitCode === null && !form.killed) form.kill();
    if (canvas && canvas.exitCode === null && canvas.signalCode === null) {
      const closed = once(canvas, "exit");
      fs.writeFileSync(path.join(root, "canvas.close"), "");
      const force = setTimeout(() => canvas.kill(), 3000);
      try { await closed; } finally { clearTimeout(force); }
    }
    await mcp.close();
    await runtime.stopAllPluginPolls();
    shutdownPluginWorkers();
    await installer._pausePluginPreparation();
    if (path.dirname(root) === parent && path.basename(root).startsWith("openbot-cu-host-")) {
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
