"use strict";
// Explicit development-only host path; the shipped plugin has no host imports.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createRequire } = require("node:module"), { execFileSync } = require("node:child_process");
const host = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(host, "electron/lib/plugins/plugin-package.cjs"))) {
  throw new Error("Usage: node tests/watch-host.cjs <OpenBot checkout>");
}
const hostRequire = createRequire(path.join(host, "package.json"));
const { Client } = hostRequire("@modelcontextprotocol/client");
const { StdioClientTransport } = hostRequire("@modelcontextprotocol/client/stdio");
const { readPluginPackage } = hostRequire("./electron/lib/plugins/plugin-package.cjs");
const { normalizeExternalMcpResult } = hostRequire("./electron/lib/tools/mcp-result.cjs");
const { sanitizeMcpSchema } = hostRequire("./electron/lib/tools/mcp-schema-policy.cjs");
const plugin = path.resolve(__dirname, "../plugins/watch"), pkg = readPluginPackage(plugin);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-watch-host-")), data = path.join(work, "data");
const python = process.env.WATCH_TEST_PYTHON || "python";
const client = new Client({ name: "watch-host-test", version: "1" }, { capabilities: {} });

async function main() {
  assert.equal(pkg.manifest.id, "watch");
  assert.equal(pkg.scriptPath, path.join(plugin, "index.js"));
  assert.deepEqual(pkg.skills.map(s => s.name), ["watch:watch"]);
  assert.equal(pkg.mcpServers.length, 1);
  const video = path.join(work, "fixture.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=4:duration=6", "-c:v", "mpeg4", video], { windowsHide: true, timeout: 30000 });
  const imported = JSON.parse(execFileSync(python, ["-B", path.join(plugin, "tools/server.py"), "--data-dir", data, "--import-file", video], { encoding: "utf8", windowsHide: true }));
  const transport = new StdioClientTransport({ command: python, args: pkg.mcpServers[0].args.map(v => v.replaceAll("${PLUGIN_ROOT}", plugin).replaceAll("${PLUGIN_DATA}", data)),
    env: { ...process.env, ...Object.fromEntries(Object.entries(pkg.mcpServers[0].env).map(([key, value]) =>
      [key, value.replaceAll("${PLUGIN_CONFIG}", JSON.stringify({ asrBackend: "none" }))])) }, cwd: work, stderr: "pipe" });
  await client.connect(transport, { timeout: 15000 });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 12);
  assert.deepEqual(new Set(tools.map(t => t.name)), new Set([...pkg.mcpServers[0].enabled_tools, ...pkg.mcpServers[0].native_tools]));
  for (const tool of tools) assert.equal(sanitizeMcpSchema(tool.inputSchema).ok, true, tool.name);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const info = await call("watch_info");
  assert.equal(info.structuredContent.dependencies.ffmpeg, true);
  assert.equal(info.structuredContent.asr.backend, "none", "owner settings arrive through the MCP environment");
  const started = await call("watch_start", { source: imported.source, frame_count: 8, sampling: "uniform" });
  assert.equal(started.isError, false, JSON.stringify(started));
  const job_id = started.structuredContent.job_id;
  let status;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    status = (await call("watch_status", { job_id })).structuredContent;
    if (["ready", "failed"].includes(status.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status.status, "ready", JSON.stringify(status));
  const raw = await call("watch_frames", { job_id });
  assert.equal(raw.content.filter(b => b.type === "image").length, 4);
  const normalized = normalizeExternalMcpResult(raw, text => text, "watch-test");
  assert.equal(normalized.userContextBlocks.filter(b => b.type === "image_url").length, 4);
  assert.equal(raw.structuredContent.next_offset, 4);
  assert.ok(!normalized.toolText.includes(data));
  // Native entry transfers provider-neutral cached bytes through the real MCP server.
  const native = require(path.join(plugin, "index.js"));
  const ownEntry = { id: "native-watch", channelId: "bot", pluginId: "watch", pluginServer: "watch", pluginOwnerKey: "native-owner", mcpType: "stdio", enabled: true,
    pluginDeclaredTools: pkg.mcpServers[0].enabled_tools, pluginNativeTools: pkg.mcpServers[0].native_tools };
  const ownService = hostRequire("./electron/lib/plugins/plugin-tools.cjs").createPluginToolService({
    entries: () => [ownEntry], allowedTools: async () => [],
    request: async (_id, method, params) => method === "tools/list" ? client.listTools() : client.callTool(params) });
  const nativeCall = input => ownService.call({ channel: { id: "bot" },
    plugin: { id: "watch", mcpServers: pkg.mcpServers }, principal: { source: "channel", channelId: "bot", chatId: "fixture", senderId: "owner" },
    signal: new AbortController().signal, assertActive() {}, input });
  const bytes = fs.readFileSync(video);
  const nativeCtx = { plugin: { scopeNamespace: "d".repeat(64) }, config: { localVideoRoots: [work] },
    input: { message_id: "attachment", frame_count: 2, sampling: "uniform" },
    message: { id: "attachment", media: [{ type: "video", name: "fixture.mp4", assetRef: "openbot-asset://fixture", size: bytes.length }] },
    api: { readMessageAttachment: async () => ({ type: "video", mimeType: "video/mp4", size: bytes.length, data: bytes.toString("base64") }),
      callTool: nativeCall } };
  for (const input of [nativeCtx.input, { source: video, frame_count: 2, sampling: "uniform" }]) {
    nativeCtx.input = input;
    const nativeJob = await native.watch_start(nativeCtx);
    const until = Date.now() + 30000;
    let nativeStatus;
    do {
      nativeStatus = (await call("watch_status", { job_id: nativeJob.job_id })).structuredContent;
      if (["ready", "failed"].includes(nativeStatus.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < until);
    assert.equal(nativeStatus.status, "ready", JSON.stringify(nativeStatus));
    assert.ok((await call("watch_frames", { job_id: nativeJob.job_id })).content.some(b => b.type === "image"));
  }
  // Explicit local acceptance input; read existing cached media without modifying it.
  if (process.env.WATCH_TEST_ATTACHMENT_REF && process.env.WATCH_TEST_ATTACHMENT_ROOT) {
    const fixture = JSON.parse(fs.readFileSync(process.env.WATCH_TEST_ATTACHMENT_REF, "utf8"));
    const { readMessageAttachment } = hostRequire("./electron/lib/plugins/plugin-message-attachment.cjs");
    const message = { id: fixture.messageId, chatId: fixture.chatId, media: [
      { type: "video", name: "cached.mp4", assetRef: fixture.assetRef, mimeType: "video/mp4" },
    ] };
    const ctx = { ...nativeCtx, input: { message_id: message.id, frame_count: 2, sampling: "uniform" }, message,
      api: { callTool: nativeCtx.api.callTool, readMessageAttachment: input => readMessageAttachment({ fs, path,
        root: process.env.WATCH_TEST_ATTACHMENT_ROOT, channel: { id: fixture.channelId }, chatId: message.chatId,
        input, resolveMessage: () => message, guardedFetch: () => { throw new Error("Cached attachment must not need its old URL"); } }) } };
    const job = await native.watch_start(ctx);
    let state;
    const until = Date.now() + 30000;
    do {
      state = (await call("watch_status", { job_id: job.job_id })).structuredContent;
      if (["ready", "failed"].includes(state.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < until);
    assert.equal(state.status, "ready", JSON.stringify(state));
    const frames = await call("watch_frames", { job_id: job.job_id });
    assert.ok(frames.content.some(b => b.type === "image"));
    console.log("Existing cached attachment: host scoped reader -> native Watch -> MCP -> decoded frames passed");
  }
  const overview = await call("watch_storyboard", { job_id });
  assert.equal(overview.isError, false, JSON.stringify(overview));
  assert.equal(overview.structuredContent.cells.length, 8);
  assert.equal(normalizeExternalMcpResult(overview, text => text, "watch-storyboard-test").userContextBlocks.filter(b => b.type === "image_url").length, 1);
  assert.ok(!JSON.stringify(overview.structuredContent).includes(data));
  const crop = { x: 20, y: 20, width: 160, height: 100 };
  const focused = await call("watch_zoom", { job_id, cell_id: 3, frame_count: 2, crop });
  assert.equal(focused.isError, false, JSON.stringify(focused));
  const focusedId = focused.structuredContent.job_id;
  const focusedDeadline = Date.now() + 30000;
  while (Date.now() < focusedDeadline) {
    status = (await call("watch_status", { job_id: focusedId })).structuredContent;
    if (["ready", "failed"].includes(status.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status.status, "ready", JSON.stringify(status));
  assert.deepEqual(status.result.range, overview.structuredContent.cells[2].range);
  assert.deepEqual(status.result.focus_cell, { job_id, cell_id: 3 });
  const detail = await call("watch_frames", { job_id: focusedId });
  const detailText = detail.content.filter(b => b.type === "text").map(b => JSON.parse(b.text)).find(b => b.view);
  assert.deepEqual(detailText.view, { crop, width: 160, height: 100, source_width: 320, source_height: 180 });
  assert.ok(normalizeExternalMcpResult(detail, text => text, "watch-crop-test").userContextBlocks.some(b => b.type === "image_url"));
  // Real plugin -> generic host binding -> Watch MCP -> real extracted frames.
  // Only the transport's source is replaced with our explicitly imported fixture.
  const { createPluginToolService } = hostRequire("./electron/lib/plugins/plugin-tools.cjs");
  const { fixture } = require("./video-analysis.cjs");
  const consumer = readPluginPackage(path.resolve(__dirname, "../plugins/bilibili-explorer")).manifest;
  assert.equal(consumer.name, "B站小管家");
  const entry = { id: "fixture", channelId: "bot", pluginId: "watch", pluginServer: "watch", pluginOwnerKey: "fixture-owner", mcpType: "stdio", enabled: true };
  const mediaService = createPluginToolService({ entries: () => [entry], allowedTools: async () => ["mcp__fixture__watch_media", "mcp__fixture__watch_preview"],
    request: async (_id, method, params) => method === "tools/list" ? client.listTools()
      : client.callTool({ ...params, arguments: { ...params.arguments, url: imported.source } }) });
  const f = fixture({ captions: false, duration: 6 });
  const { createHash } = require("node:crypto");
  f.ctx.config.mediaServices = structuredClone(consumer.configSchema.properties.mediaServices.default);
  f.ctx.plugin = { id: consumer.id,
    namespace: createHash("sha256").update(`bot:${consumer.id}`).digest("hex"),
    scopeNamespace: createHash("sha256").update(JSON.stringify(["bot", consumer.id, f.ctx.message.chatId])).digest("hex") };
  const receipts = [];
  f.ctx.api.callTool = async input => {
    const result = await mediaService.call({ channel: { id: "bot" },
      principal: { source: "channel", channelId: "bot", chatId: f.ctx.message.chatId, senderId: "1", role: "member" },
      input, signal: new AbortController().signal, assertActive() {} });
    receipts.push({ input: input.arguments, result: result.structuredContent }); return result;
  };
  const readingDeadline = Date.now() + 45000;
  while (Date.now() < readingDeadline && f.job()?.stage !== "completed") {
    await f.invoke(); await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(f.job()?.stage, "completed", JSON.stringify(f.job()));
  assert.ok(receipts.some(row => ["queued", "running"].includes(row.result.status)));
  assert.ok(receipts.some(row => row.input.kind === "frames" && row.result.frames?.length));
  assert.ok(f.models.some(request => request.attachments?.length), "actual Watch images reach the summarizing model");
  assert.match(f.job().summary, /Watch 抽样画面/);
  assert.match(f.job().summary, /待核对/);
  const completed = receipts.find(row => row.result.frames?.length).result;
  assert.equal(completed.source, "Watch 抽样画面");
  const denied = await call("watch_ingest", { action: "local", namespace: "d".repeat(64), source: video, roots: [] });
  assert.equal(denied.isError, true);
  console.log("Watch host integration: schemas, native attachments/local files, storyboard images, cell zoom, source crop and consumer media forwarding passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await client.close().catch(() => {});
  const resolved = fs.realpathSync(work), base = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase());
  assert.ok(path.basename(resolved).startsWith("openbot-watch-host-"));
  fs.rmSync(resolved, { recursive: true, force: true });
});
