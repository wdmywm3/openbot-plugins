"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const sandbox = vm.createContext({ module: { exports: {} } });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../plugins/watch/index.js"), "utf8"), sandbox);
const start = sandbox.module.exports.watch_start;
const plain = value => JSON.parse(JSON.stringify(value));
const namespace = "a".repeat(64), imported = "import:" + "b".repeat(32);
function fixture() {
  const calls = [], chunks = [];
  const bytes = Buffer.alloc(80003, 123);
  const entry = { id: "event", platform: "arbitrary-provider", media: [
    { type: "image", mimeType: "image/png" },
    { type: "file", name: "clip.webm", assetRef: "openbot-asset://fixture", size: bytes.length },
  ] };
  const ctx = { input: { message_id: "event" }, config: {}, plugin: { scopeNamespace: namespace }, api: {
    readHistory: async () => ({ items: [entry] }),
    readMessageAttachment: async args => {
      assert.equal(args.messageId, "event"); assert.equal(args.index, 1); assert.equal(args.maxBytes, 6 * 1024 * 1024);
      return { type: "file", mimeType: "application/octet-stream", size: bytes.length, data: bytes.toString("base64") };
    },
    callTool: async input => {
      assert.ok(Buffer.byteLength(JSON.stringify(input.arguments)) < 65536);
      assert.equal(input.pluginId, "watch"); assert.equal(input.pluginServer, "watch");
      calls.push(plain(input)); const args = input.arguments;
      let result = { job_id: "job", status: "queued" };
      if (input.name === "watch_ingest") {
        assert.equal(args.namespace, namespace);
        if (args.action === "begin") result = { upload_id: "upload", offset: 0 };
        else if (args.action === "append") {
          const chunk = Buffer.from(args.base64, "base64"); chunks.push(chunk);
          result = { offset: args.offset + chunk.length };
        } else result = { source: imported };
      }
      return { structuredContent: result };
    },
  } };
  return { ctx, calls, chunks, bytes, entry };
}
(async () => {
  const f = fixture();
  assert.equal((await start(f.ctx)).job_id, "job");
  assert.deepEqual(Buffer.concat(f.chunks), f.bytes);
  assert.equal(f.calls.at(-1).arguments.source, imported);
  assert.equal(f.calls.filter(c => c.arguments.action === "append").length, 3);
  assert.ok(f.calls.every(c => c.name !== "inspect"));
  for (const source of ["https://archive.org/details/test", "https://cdn.example.org/get?token=x%2By", "http://media.example.org/a.mp4", "watch:" + "c".repeat(32)]) {
    const f = fixture(); f.ctx.input = { source }; await start(f.ctx);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].arguments.source, source);
  }
  {
    const f = fixture(); f.ctx.input = { source: "file:///D:/Videos/clip.mp4" }; f.ctx.config.localVideoRoots = ["D:/Videos"];
    await start(f.ctx); assert.deepEqual(f.calls[0].arguments.roots, ["D:/Videos"]);
    assert.equal(f.calls.at(-1).arguments.source, imported);
    f.ctx.input.roots = ["C:/"]; await assert.rejects(start(f.ctx), /二者选择一个/);
  }
  {
    const f = fixture(); f.entry.media[1].size = 10 * 1024 * 1024; f.entry.media[1].originalUrl = "https://other-platform.example/video?id=7&sig=a%2Fb";
    await start(f.ctx); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].arguments.source_type, "direct");
    assert.equal(f.calls[0].arguments.source, f.entry.media[1].originalUrl);
    delete f.entry.media[1].originalUrl; await assert.rejects(start(f.ctx), /大小/);
  }
  {
    const f = fixture(); f.ctx.api.readHistory = async () => ({ items: [] });
    await assert.rejects(start(f.ctx), /找不到/); assert.equal(f.calls.length, 0);
    f.ctx.input = { source: "https://example.org/a", message_id: "event" }; await assert.rejects(start(f.ctx), /二者选择一个/);
    f.ctx.input = { source: "https://example.org/a", attachment_index: 1 }; await assert.rejects(start(f.ctx), /消息编号/);
  }
  {
    const f = fixture(); f.ctx.message = f.entry; f.ctx.api.readHistory = async () => { throw new Error("should not read history"); };
    f.ctx.api.callTool = async () => ({ isError: true, content: [{ type: "text", text: "attachment denied" }] });
    await assert.rejects(start(f.ctx), /attachment denied/);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugins/watch/plugin.json"))).extensions["com.openbot"];
  const mcp = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugins/watch/mcp.json")));
  const server = Object.values(mcp.mcpServers)[0];
  assert.equal(manifest.tools.filter(t => t.name === "watch_start").length, 1);
  assert.ok(!server.enabled_tools.includes("watch_start")); assert.ok(!server.enabled_tools.includes("watch_ingest"));
  console.log("Watch native: provider-neutral attachments, bounded chunks, signed URLs, approved local roots, errors and single entry passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
