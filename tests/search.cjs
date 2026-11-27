"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../plugins/search/index.js"), "utf8");
const sandbox = vm.createContext({ module: { exports: {} } });
vm.runInContext(source, sandbox);
const plugin = sandbox.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
(async () => {
  const calls = [];
  const ctx = { config: { webProvider: "tavily", imageProvider: "google" }, input: { query: "example" }, api: {
    getSecret: async name => name === "anysearchKey" ? "" : "fixture-key",
    request: async (url, options) => { calls.push({ url, options: plain(options) }); return { ok: true, status: 200, body: { results: [{ title: "Example", url: "https://example.org", content: "Evidence" }] } }; },
  } };
  const text = await plugin.web_search(ctx);
  assert.equal(text.results[0].snippet, "Evidence"); assert.equal(calls[0].options.body.api_key, "fixture-key");
  ctx.config.webProvider = "exa"; await plugin.web_search(ctx); assert.equal(calls.at(-1).options.headers["x-api-key"], "fixture-key");
  ctx.config.webProvider = "brave"; await plugin.web_search(ctx); assert.match(calls.at(-1).url, /q=example/);
  ctx.config.webProvider = "anysearch";
  ctx.api.request = async (url, options) => {
    calls.push({ url, options: plain(options) });
    const payload = options.body;
    return { ok: true, status: payload.id ? 200 : 202, headers: { "mcp-session-id": "session" }, body: payload.id
      ? JSON.stringify({ id: payload.id, result: payload.method === "initialize" ? { protocolVersion: "2025-03-26" } : { content: [{ type: "text", text: "Found source" }] } }) : "" };
  };
  assert.equal((await plugin.web_search(ctx)).content[0].text, "Found source");
  assert.equal(calls.at(-1).options.headers["mcp-session-id"], "session");
  assert.equal(calls.at(-1).options.body.params.name, "search");
  const anySearchRequest = ctx.api.request;
  ctx.api.request = async (_url, options) => ({ ok: true, body: JSON.stringify({ id: options.body.id,
    error: { code: -32602, message: "fixture-private" } }) });
  await assert.rejects(plugin.web_search(ctx), error =>
    error.code === "SEARCH_RPC_ERROR" && error.details.upstreamCode === -32602 && error.message === "AnySearch 初始化连接失败（错误码 -32602）。");
  ctx.api.request = async () => ({ ok: true, body: "fixture-private" });
  await assert.rejects(plugin.web_search(ctx), { code: "SEARCH_RPC_RESPONSE", message: "AnySearch 响应格式无效。" });
  ctx.api.request = anySearchRequest;
  ctx.input = { queries: [{ query: "first" }, { query: "second", domain: "code", sub_domain: "code.example", sub_domain_params: { repository: "example" } }] };
  await plugin.batch_search(ctx); assert.equal(calls.at(-1).options.body.params.name, "batch_search"); assert.equal(calls.at(-1).options.body.params.arguments.queries.length, 2);
  ctx.input = { domains: ["code"] }; await plugin.get_sub_domains(ctx); assert.equal(calls.at(-1).options.body.params.arguments.domains[0], "code");
  ctx.input = { url: "https://example.org" }; await plugin.read_webpage(ctx); assert.equal(calls.at(-1).options.body.params.name, "extract");
  ctx.api.getCapabilities = async () => ({ limits: { attachmentInlineBytes: 16 * 1024 * 1024 } });
  const data = Buffer.alloc(6 * 1024 * 1024 + 1).toString("base64");
  ctx.input = { messageId: "message", index: 1 };
  ctx.api.readMessageAttachment = async input => { assert.equal(input.index, 1); return { messageId: "message", index: 1, type: "image", mimeType: "image/png", data }; };
  ctx.api.request = async (url, options) => {
    assert.equal(url, "https://vision.googleapis.com/v1/images:annotate");
    assert.equal(options.headers["x-goog-api-key"], "fixture-key"); assert.ok(options.maxBodyBytes > data.length);
    assert.equal(options.body.requests[0].image.content, data); assert.equal(options.body.requests[0].features[0].type, "WEB_DETECTION");
    return { ok: true, body: { responses: [{ webDetection: { fullMatchingImages: [{ url: "https://example.org/full.png" }], visuallySimilarImages: [{ url: "https://example.org/similar.png" }], pagesWithMatchingImages: [{ url: "https://example.org/source", pageTitle: "Original" }], webEntities: [{ description: "Subject", score: 0.9 }] } }] } };
  };
  const image = await plugin.search_by_image(ctx); assert.equal(image.found, true); assert.equal(image.fullMatches.length, 1); assert.equal(image.similarImages.length, 1);
  assert.ok(!JSON.stringify(image).includes(data)); assert.ok(!JSON.stringify(image).includes("fixture-key"));
  ctx.api.request = async () => ({ ok: true, body: { responses: [{}] } }); assert.equal((await plugin.search_by_image(ctx)).found, false);
  ctx.api.request = async () => ({ ok: true, body: { responses: [{ error: { code: 7, message: "fixture-private" } }] } });
  await assert.rejects(plugin.search_by_image(ctx), error =>
    error.code === "SEARCH_VISION_ERROR" && error.details.upstreamCode === 7 && error.message === "Cloud Vision 图片搜索失败（错误码 7）。");
  ctx.api.request = async () => ({ ok: false, status: 403, body: { error: { status: "PERMISSION_DENIED", message: "fixture-private" } } });
  await assert.rejects(plugin.search_by_image(ctx), error => error.status === 403
    && error.details.upstreamCode === "PERMISSION_DENIED" && error.message === "搜索服务拒绝访问（HTTP 403）。");
  const readImage = ctx.api.readMessageAttachment;
  ctx.api.readMessageAttachment = async () => ({ type: "image", mimeType: "image/png", data: "a".repeat(10000000) });
  ctx.api.request = async () => { throw Error("oversized image reached the provider"); };
  await assert.rejects(plugin.search_by_image(ctx), error => error.code === "PLUGIN_INPUT_LIMIT" && /10 MB/.test(error.message));
  ctx.api.readMessageAttachment = readImage;
  ctx.api.getSecret = async () => ""; await assert.rejects(plugin.search_by_image(ctx), /Cloud Vision API Key/);
  ctx.config.webProvider = "anysearch"; ctx.input = { query: "still usable" };
  ctx.api.request = async (_url, options) => ({ ok: true, body: options.body.id ? JSON.stringify({ id: options.body.id, result: options.body.method === "initialize" ? { protocolVersion: "2025-03-26" } : { content: [] } }) : "" });
  assert.equal((await plugin.web_search(ctx)).provider, "anysearch");
  ctx.config.webProvider = "openai";
  ctx.input = { query: "fixture", resultType: "images", include_domains: ["example.org"] };
  ctx.api.getSecret = () => assert.fail("native models own their credentials");
  ctx.api.modelRequest = async req => {
    assert.equal(req.tools[0].filters.allowed_domains[0], "example.org");
    return { output: [{ type: "message", content: [{ type: "output_text", text: "unverified" }] }] };
  };
  await assert.rejects(plugin.web_search(ctx), /模型没有执行网页搜索/);
  ctx.api.modelRequest = async () => ({ output: [{ type: "web_search_call", status: "failed" }] });
  await assert.rejects(plugin.web_search(ctx), /网页搜索未完成（failed）/);
  ctx.api.modelRequest = async () => ({ output: [{ type: "web_search_call", status: "completed", results: [] }] });
  assert.deepEqual(plain((await plugin.web_search(ctx)).images), []);
  let streamStatus = 200, streamData = "", closed = 0;
  ctx.input = { imageUrl: "https://example.org/ref", sourceUrl: "https://example.org/source" };
  ctx.api.getCapabilities = async () => ({ limits: { assetBytes: 16, attachmentInlineBytes: 16, streamReadBytes: 8 } });
  ctx.api.openStream = async () => ({ id: "stream", status: streamStatus });
  ctx.api.readStream = async () => ({ data: streamData, done: true });
  ctx.api.closeStream = async () => { closed++; };
  ctx.api.assets = () => assert.fail("invalid candidate reached asset storage");
  await assert.rejects(plugin.prepare_reference(ctx), /参考图响应为空/);
  streamData = Buffer.alloc(17).toString("base64");
  await assert.rejects(plugin.prepare_reference(ctx), error => error.code === "PLUGIN_INPUT_LIMIT" && /17 字节，超过 16 字节/.test(error.message));
  streamData = Buffer.from("<html>").toString("base64");
  await assert.rejects(plugin.prepare_reference(ctx), /不是 PNG、JPEG 或 WebP/);
  streamStatus = 404; await assert.rejects(plugin.prepare_reference(ctx), /读取参考图失败（HTTP 404）/);
  assert.equal(closed, 4);
  console.log("Search plugin: isolated VM, five providers, MCP sessions/batch/extract, Google image upload, no matches and failures passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
