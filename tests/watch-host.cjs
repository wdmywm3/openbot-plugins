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
  assert.equal(pkg.scriptPath, "");
  assert.deepEqual(pkg.skills.map(s => s.name), ["watch:watch"]);
  assert.equal(pkg.mcpServers.length, 1);
  const video = path.join(work, "fixture.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=4:duration=6", "-c:v", "libx264", video], { windowsHide: true, timeout: 30000 });
  const imported = JSON.parse(execFileSync(python, ["-B", path.join(plugin, "tools/server.py"), "--data-dir", data, "--import-file", video], { encoding: "utf8", windowsHide: true }));
  const transport = new StdioClientTransport({ command: python, args: pkg.mcpServers[0].args.map(v => v.replaceAll("${PLUGIN_ROOT}", plugin).replaceAll("${PLUGIN_DATA}", data)),
    env: { ...process.env, ...pkg.mcpServers[0].env }, cwd: work, stderr: "pipe" });
  await client.connect(transport, { timeout: 15000 });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 7);
  for (const tool of tools) assert.equal(sanitizeMcpSchema(tool.inputSchema).ok, true, tool.name);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const info = await call("watch_info");
  assert.equal(info.structuredContent.dependencies.ffmpeg, true);
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
  const crop = { x: 20, y: 20, width: 160, height: 100 };
  const focused = await call("watch_start", { source: `watch:${job_id}`, timestamps: [1], crop });
  assert.equal(focused.isError, false, JSON.stringify(focused));
  const focusedId = focused.structuredContent.job_id;
  const focusedDeadline = Date.now() + 30000;
  while (Date.now() < focusedDeadline) {
    status = (await call("watch_status", { job_id: focusedId })).structuredContent;
    if (["ready", "failed"].includes(status.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status.status, "ready", JSON.stringify(status));
  const detail = await call("watch_frames", { job_id: focusedId });
  const detailText = detail.content.filter(b => b.type === "text").map(b => JSON.parse(b.text)).find(b => b.view);
  assert.deepEqual(detailText.view, { crop, width: 160, height: 100, source_width: 320, source_height: 180 });
  assert.equal(normalizeExternalMcpResult(detail, text => text, "watch-crop-test").userContextBlocks.filter(b => b.type === "image_url").length, 1);
  // Real plugin -> generic host binding -> Watch MCP -> real extracted frames.
  // Only the transport's source is replaced with our explicitly imported fixture.
  const { createPluginMediaService, mediaResult } = hostRequire("./electron/lib/features/channels/channel-plugin-media-service.cjs");
  const { fixture } = require("./video-analysis.cjs");
  const consumer = readPluginPackage(path.resolve(__dirname, "../plugins/bilibili-explorer")).manifest;
  assert.equal(consumer.name, "B站小管家");
  const entry = { id: "fixture", channelId: "bot", pluginId: "watch", pluginServer: "watch", pluginOwnerKey: "fixture-owner", mcpType: "stdio", enabled: true };
  const mediaService = createPluginMediaService({ entries: () => [entry], allowedTools: async () => ["mcp__fixture__watch_media"],
    request: async (_id, _method, params) => client.callTool({ ...params, arguments: { ...params.arguments, url: imported.source } }) });
  const f = fixture({ captions: false, duration: 6 });
  const receipts = [];
  f.ctx.api.media = async input => {
    const result = await mediaService({ channel: { id: "bot" }, plugin: { ...consumer, config: {} },
      principal: { chatId: "agent:plugin:bilibili-explorer" }, input, signal: new AbortController().signal, assertActive() {} });
    receipts.push({ input, result }); return result;
  };
  const readingDeadline = Date.now() + 45000;
  while (Date.now() < readingDeadline && f.job()?.stage !== "completed") {
    await f.invoke(); await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(f.job()?.stage, "completed", JSON.stringify(f.job()));
  assert.ok(receipts.some(row => ["queued", "running"].includes(row.result.status)));
  assert.ok(receipts.some(row => row.input.kind === "frames" && row.result.frames?.length));
  assert.ok(f.models.some(request => request.frames?.length), "actual Watch images reach the summarizing model");
  assert.match(f.job().summary, /Watch 抽样画面/);
  assert.match(f.job().summary, /待核对/);
  const completed = receipts.find(row => row.result.frames?.length).result;
  assert.equal(mediaResult({ structuredContent: completed }).source, "Watch 抽样画面");
  const denied = await call("watch_start", { source: video });
  assert.equal(denied.isError, true);
  console.log("Watch host integration: package discovery, seven validated schemas, MCP client, native images and host image forwarding passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await client.close().catch(() => {});
  const resolved = fs.realpathSync(work), base = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase());
  assert.ok(path.basename(resolved).startsWith("openbot-watch-host-"));
  fs.rmSync(resolved, { recursive: true, force: true });
});
