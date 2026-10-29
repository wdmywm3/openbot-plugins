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
  ctx.input = { queries: [{ query: "first" }, { query: "second", domain: "code", sub_domain: "code.example", sub_domain_params: { repository: "example" } }] };
  await plugin.batch_search(ctx); assert.equal(calls.at(-1).options.body.params.name, "batch_search"); assert.equal(calls.at(-1).options.body.params.arguments.queries.length, 2);
  ctx.input = { domains: ["code"] }; await plugin.get_sub_domains(ctx); assert.equal(calls.at(-1).options.body.params.arguments.domains[0], "code");
  ctx.input = { url: "https://example.org" }; await plugin.read_webpage(ctx); assert.equal(calls.at(-1).options.body.params.name, "extract");
  const data = Buffer.alloc(50000).toString("base64");
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
  ctx.api.request = async () => ({ ok: true, body: { responses: [{ error: { code: 7 } }] } }); await assert.rejects(plugin.search_by_image(ctx), /搜索失败/);
  ctx.api.request = async () => ({ ok: false, status: 403 }); await assert.rejects(plugin.search_by_image(ctx), /权限/);
  ctx.api.getSecret = async () => ""; await assert.rejects(plugin.search_by_image(ctx), /Cloud Vision API Key/);
  ctx.config.webProvider = "anysearch"; ctx.input = { query: "still usable" };
  ctx.api.request = async (_url, options) => ({ ok: true, body: options.body.id ? JSON.stringify({ id: options.body.id, result: options.body.method === "initialize" ? { protocolVersion: "2025-03-26" } : { content: [] } }) : "" });
  assert.equal((await plugin.web_search(ctx)).provider, "anysearch");
  console.log("Search plugin: isolated VM, four providers, MCP sessions/batch/extract, Google image upload, no matches and failures passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
