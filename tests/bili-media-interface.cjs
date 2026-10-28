"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, "../plugins/bilibili-explorer");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8")).extensions["com.openbot"];
const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(root, "index.js"), "utf8") + "\nmodule.exports.mediaCheck = biliMedia;", sandbox);
const media = sandbox.module.exports.mediaCheck, calls = [];
let response = { structuredContent: { status: "completed", observations: [{ start: 1, end: 2, text: "visible" }],
  frames: [{ timestamp: 1, mimeType: "image/png", data: "aGVsbG8=" }] } };
const ctx = { plugin: { namespace: "a".repeat(64), scopeNamespace: "b".repeat(64) },
  config: { mediaServices: structuredClone(manifest.configSchema.properties.mediaServices.default) },
  api: { callTool: async input => { calls.push(JSON.parse(JSON.stringify(input))); return response; } } };
const input = { kind: "frames", url: "https://www.bilibili.com/video/BV1234567890/?p=2", requestId: "test", start: 0, end: 10 };
(async () => {
  assert.equal((await media(ctx, input)).frames[0].timestamp, 1);
  assert.deepEqual(calls[0], { pluginId: "watch", pluginServer: "watch", name: "watch_media", timeoutMs: 120000,
    arguments: { kind: "frames", url: input.url, start: 0, end: 10, namespace: "b".repeat(64), request_id: "test" } });
  response = { structuredContent: { status: "queued", jobId: "job-1" } };
  assert.equal((await media(ctx, input)).status, "queued");
  await media(ctx, { ...input, jobId: "job-1" }); assert.equal(calls.at(-1).arguments.job_id, "job-1");
  response = { content: [{ type: "text", text: JSON.stringify({ segments: [{ start: 1, end: 2, text: "audio" }] }) }] };
  assert.equal((await media(ctx, { ...input, kind: "transcribe" })).segments[0].text, "audio");
  response = { structuredContent: { segments: [{ start: -1, end: 2, text: "bad" }] } };
  await assert.rejects(media(ctx, input), /时间戳/);
  response = { structuredContent: { frames: Array(13).fill({}) } }; await assert.rejects(media(ctx, input), /12/);
  response = { structuredContent: { frames: [{ timestamp: 1, mimeType: "text/html", data: "aGVsbG8=" }] } }; await assert.rejects(media(ctx, input), /图片/);
  response = { structuredContent: { status: "queued", jobId: "../foreign" } }; await assert.rejects(media(ctx, input), /任务编号/);
  response = { isError: true, content: [{ type: "text", text: "unavailable" }] }; await assert.rejects(media(ctx, input), /执行失败/);
  await assert.rejects(media(ctx, { ...input, url: "https://evil.example/video/BV1234567890/" }), /地址/);
  await assert.rejects(media(ctx, { ...input, end: 1000 }), /范围/);
  ctx.config.mediaServices.backup = { serverId: "backup", toolName: "save", arguments: { namespace: "$namespace", source: "$url" } };
  response = { structuredContent: { status: "completed", backup: { path: "D:/backup/fixture.mp4", sha256: "c".repeat(64), bytes: 42 } } };
  assert.equal((await media(ctx, { ...input, kind: "backup" })).backup.bytes, 42);
  assert.equal(calls.at(-1).arguments.namespace, "a".repeat(64));
  response = { structuredContent: { status: "completed", backup: { path: "D:/backup/fixture.mp4", sha256: "bad", bytes: 42 } } };
  await assert.rejects(media(ctx, { ...input, kind: "backup" }), /校验/);
  ctx.config.mediaServices.frames = null; assert.equal((await media(ctx, input)).status, "unavailable");
  const legacy = { config: {}, api: { media: async () => ({ status: "completed", segments: [{ start: -1, end: 2, text: "bad" }] }) } };
  await assert.rejects(media(legacy, input), /时间戳/, "the plugin also validates legacy host results");
  console.log("Bili media: generic tool selectors, plugin-owned bindings/receipts/timestamps/backup validation and legacy result validation passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
