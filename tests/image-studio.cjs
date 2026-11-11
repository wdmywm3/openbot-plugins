"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../plugins/image-studio/index.js"), "utf8");
const { defaults, mockDatabase } = require("./image-studio-test-helpers.cjs");
const sandbox = vm.createContext({ module: { exports: {} } }); vm.runInContext(source, sandbox);
const draw = sandbox.module.exports.draw_image;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
const gif = "R0lGODlhAgABAIEAAExpcQD/AP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAAAgABAAACAlQKACH5BAUPAAAALAAAAAACAAEAgUxpcf//AAAA/wAAAAICVAoAOw==";
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(config = {}, input = {}) {
  const controller = new AbortController(), requests = [], closes = [], stored = [], streams = new Map(); let serial = 0;
  const fx = { controller, requests, closes, stored, payload: { data: [{ b64_json: png }] }, chunks: null, status: 200 };
  const ctx = { config: { ...defaults, openaiImageModel: "gpt-image-2.6-sunburst", openaiTextModel: "fixture-chat", ...config },
    input: { prompt: "雨中的猫", ...input }, principal: { source: "channel", role: "owner", senderId: "owner", channelId: "fixture" },
    signal: controller.signal, deadlineAt: Date.now() + 60000, api: {
    async getConfig() { return plain(ctx.config); },
    async listModels() { return config.provider === "codex" ? [{ id: config.codexModelId || "signed-in", provider: "codex", primary: !config.codexModelId, loginConfigured: true }] : []; },
    database: mockDatabase(),
    sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(0, Number(ms) || 0)))); },
    async getSecret(key) { assert(["openaiKey", "compatibleKey"].includes(key)); return "fixture-secret"; },
    async openStream(url, options) {
      requests.push({ url, options: plain(options) });
      const id = "s" + ++serial, body = fx.chunks || [JSON.stringify(fx.payload)]; streams.set(id, [...body]);
      return { id, status: fx.status, headers: { "content-type": "application/json" } };
    },
    async readStream({ id }) { controller.signal.throwIfAborted(); const parts = streams.get(id), data = parts.shift() || ""; return { done: parts.length === 0, data }; },
    async closeStream({ id }) { closes.push(id); },
    async readMessageAttachment({ messageId, maxBytes }) { assert.equal(messageId, "reference"); assert.equal(maxBytes, 600 * 1024); return { data: png, mimeType: "image/png" }; },
    async assets(request) {
      if (request.action === "put") { stored.push(plain(request)); return { ref: "plugin-asset://fixture" }; }
      if (request.action === "publish") return { url: "openbot-plugin-asset://published" };
      if (request.action === "info") return { bytes: Buffer.from(png, "base64").length, mimeType: "image/png" };
      if (request.action === "read") return { data: png, done: true };
      throw Error(request.action);
    },
    async getCapabilities() { return { features: { nativeModelRequests: true, modelResponseSelection: true } }; },
    async modelRequest(request) { requests.push({ modelRequest: plain(request) }); return { modelId: "codex-test", output: [{ type: "image_generation_call", status: "completed", result: png }] }; },
  } };
  return { ...fx, ctx, state: fx };
}
(async () => {
  let fx = fixture(); let result = await draw(fx.ctx);
  assert.equal(fx.requests[0].url, "https://api.openai.com/v1/images/generations");
  assert.equal(fx.requests[0].options.body.model, "gpt-image-2.6-sunburst");
  assert.equal(fx.requests[0].options.body.n, 1); assert.equal(fx.requests[0].options.body.stream, true);
  assert.equal(fx.stored[0].data, png); assert.equal(result.images[0].mimeType, "image/png");
  assert(!JSON.stringify(result).includes(png)); assert(!JSON.stringify(result).includes("fixture-secret")); assert.equal(fx.closes.length, 1);
  fx = fixture({}, { references: [{ messageId: "reference", index: 0 }] }); await draw(fx.ctx);
  assert.equal(fx.requests[0].url, "https://api.openai.com/v1/images/edits");
  assert.equal(fx.requests[0].options.body.images[0].image_url, "data:image/png;base64," + png);
  fx = fixture({ openaiImageModel: "" });
  await assert.rejects(draw(fx.ctx), /选择画图模型/); assert.equal(fx.requests.length, 0);
  fx = fixture({ provider: "openai-responses", openaiTextModel: "" });
  await assert.rejects(draw(fx.ctx), /选择对话模型/); assert.equal(fx.requests.length, 0);
  fx = fixture(); fx.ctx.api.getSecret = async () => "fixture\u200b-secret";
  fx.ctx.api.database = async () => { throw Error("invalid key must not use drawing quota"); };
  await assert.rejects(draw(fx.ctx), /OpenAI API Key 格式无效/); assert.equal(fx.requests.length, 0);
  fx = fixture(); fx.ctx.principal.interactionOrigin = { requesterIds: ["owner", "member"] };
  await assert.rejects(draw(fx.ctx), /只允许主人画图/); assert.equal(fx.requests.length, 0);
  fx = fixture({ provider: "openai-images" }, { format: "gif", frameCount: 2, frameDurationMs: 150 });
  fx.state.payload = { data: [{ b64_json: gif }] }; result = await draw(fx.ctx);
  let body = fx.requests[0].options.body;
  assert.equal(body.model, "gpt-image-2.6-sunburst"); assert.equal(body.output_format, "gif");
  assert.equal(body.size, "auto"); assert.equal(body.frame_count, 2); assert.equal(body.frame_duration_ms, 150);
  assert(!("stream" in body)); assert(!("partial_images" in body));
  assert.equal(fx.stored[0].mimeType, "image/gif"); assert.equal(fx.stored[0].data, gif); assert.equal(result.images[0].mimeType, "image/gif");
  fx = fixture({ provider: "openai-images" }, { format: "gif", references: [{ messageId: "reference" }] });
  fx.state.payload = { data: [{ b64_json: gif }] }; await draw(fx.ctx);
  assert.equal(fx.requests[0].url, "https://api.openai.com/v1/images/edits"); assert.equal(fx.requests[0].options.body.images[0].image_url, "data:image/png;base64," + png);
  fx = fixture({ provider: "compatible-images", compatibleBaseUrl: "https://image.example/v1", compatibleImageModel: "custom" }, { format: "gif" });
  fx.state.payload = { data: [{ b64_json: gif }] }; await draw(fx.ctx);
  assert.equal(fx.requests[0].url, "https://image.example/v1/images/generations"); assert(!("stream" in fx.requests[0].options.body));
  fx = fixture({ provider: "codex" }, { format: "gif", frameCount: 2, frameDurationMs: 150 });
  fx.ctx.api.getSecret = async () => { throw Error("unexpected paid service"); };
  fx.ctx.api.modelRequest = async request => { fx.requests.push({ modelRequest: plain(request) });
    return { output: [{ type: "image_generation_call", status: "completed", result: gif }] }; };
  result = await draw(fx.ctx); body = fx.requests[0].modelRequest.tools[0];
  assert.equal(body.model, "gpt-image-2.6-flare"); assert.equal(body.output_format, "gif");
  assert.equal(body.frame_count, 2); assert.equal(body.frame_duration_ms, 150); assert.equal(result.images[0].mimeType, "image/gif");
  fx = fixture({ provider: "codex", codexImageModel: "gpt-image-2.6-sunburst" }, { format: "gif" });
  fx.ctx.api.getSecret = async () => { throw Error("Codex failure must not switch services"); };
  fx.ctx.api.modelRequest = async request => { fx.requests.push({ modelRequest: plain(request) }); throw Error("GIF unavailable"); };
  await assert.rejects(draw(fx.ctx), /GIF unavailable/); assert.equal(fx.requests.length, 1);
  assert.equal(fx.requests[0].modelRequest.tools[0].model, "gpt-image-2.6-sunburst");
  fx = fixture({ provider: "openai-responses" }, { format: "gif", frameCount: 2 });
  fx.state.payload = { status: "completed", output: [{ type: "image_generation_call", status: "completed", result: gif }] };
  await draw(fx.ctx); body = fx.requests[0].options.body;
  assert.equal(body.stream, true); assert.equal(body.tools[0].model, "gpt-image-2.6-sunburst");
  assert.equal(body.tools[0].output_format, "gif"); assert.equal(body.tools[0].frame_count, 2); assert(!("partial_images" in body.tools[0]));
  fx = fixture({ provider: "openai-images" }, { format: "gif" }); fx.state.payload = { data: [{ b64_json: png }] };
  await assert.rejects(draw(fx.ctx), /没有返回所请求的 GIF/); assert.equal(fx.stored.length, 0);
  fx = fixture({ provider: "openai-images" }, { format: "gif" });
  fx.state.payload = { data: [{ b64_json: "R0lGODlhAgABAIAAAExpcf8AACH5BAUAAAAALAAAAAACAAEAAAICTAoAOw==" }] };
  await assert.rejects(draw(fx.ctx), /静态图片/); assert.equal(fx.stored.length, 0);
  fx = fixture({ provider: "openai-images" }, { format: "gif" });
  fx.state.payload = { data: [{ b64_json: Buffer.from(gif, "base64").subarray(0, -2).toString("base64") }] };
  await assert.rejects(draw(fx.ctx), /有效的 GIF/); assert.equal(fx.stored.length, 0);
  for (const input of [{ format: "gif", frameCount: 17 }, { format: "gif", frameDurationMs: 19 }, { frameCount: 2 },
    { format: "gif", background: "transparent" }]) {
    fx = fixture({ provider: "openai-images" }, input); await assert.rejects(draw(fx.ctx)); assert.equal(fx.requests.length, 0);
  }
  fx = fixture({ provider: "openai-responses" });
  fx.state.payload = { status: "completed", output: [{ type: "image_generation_call", status: "completed", result: png }] }; await draw(fx.ctx);
  assert.equal(fx.requests[0].url, "https://api.openai.com/v1/responses");
  assert.equal(fx.requests[0].options.body.tools[0].type, "image_generation"); assert.equal(fx.requests[0].options.body.tool_choice.type, "image_generation");
  fx = fixture({ provider: "codex", codexModelId: "signed-in" }, { references: [{ assetRef: "plugin-asset://fixture" }] }); await draw(fx.ctx);
  const native = fx.requests[0].modelRequest;
  assert.equal(native.modelId, "signed-in"); assert.equal(native.tools[0].action, "edit");
  assert.equal(native.input[0].content[1].type, "input_image"); assert(!("headers" in native)); assert(!("model" in native));
  assert(!("responseModel" in native)); assert(!("model" in native.tools[0]));
  fx = fixture({ provider: "auto" }); fx.ctx.api.listModels = async () => [{ id: "logged-in", provider: "codex", primary: true, loginConfigured: true }];
  fx.ctx.api.getSecret = async () => { throw Error("auto Codex must not ask for a paid API key"); };
  await draw(fx.ctx); assert(!("responseModel" in fx.requests[0].modelRequest));
  assert(!("modelId" in fx.requests[0].modelRequest), "current chat's primary connection is reused");
  fx = fixture({ provider: "auto", codexResponseModel: "gpt-6-astra" });
  fx.ctx.api.listModels = async () => [{ id: "logged-in", provider: "codex", fallback: true, loginConfigured: true }];
  fx.ctx.api.getSecret = async () => { throw Error("Codex failure must not switch to a paid API key"); };
  fx.ctx.api.modelRequest = async request => { fx.requests.push({ modelRequest: plain(request) }); throw Error("provider unavailable"); };
  await assert.rejects(draw(fx.ctx), /provider unavailable/); assert.equal(fx.requests.length, 1);
  assert.equal(fx.requests[0].modelRequest.modelId, "logged-in");
  assert.equal(fx.requests[0].modelRequest.responseModel, "gpt-6-astra");
  fx = fixture({ provider: "codex" }); fx.ctx.api.getCapabilities = async () => ({ features: {} });
  await assert.rejects(draw(fx.ctx), /更新宿主/); assert.equal(fx.requests.length, 0);
  fx = fixture({ provider: "codex" }, { background: "transparent" });
  await draw(fx.ctx); assert.equal(fx.requests[0].modelRequest.tools[0].background, "transparent");
  fx = fixture({ provider: "compatible-images", compatibleBaseUrl: "https://image.example/v1", compatibleImageModel: "custom", compatibleStream: false }); await draw(fx.ctx);
  assert.equal(fx.requests[0].url, "https://image.example/v1/images/generations"); assert(!("stream" in fx.requests[0].options.body));
  fx = fixture({ provider: "compatible-images", compatibleBaseUrl: "https://image.example/v1", compatibleImageModel: "custom" }, { references: [{ messageId: "reference" }] });
  await assert.rejects(draw(fx.ctx), /JSON 参考图/); assert.equal(fx.requests.length, 0);
  fx.ctx.config.compatibleJsonEdits = true; await draw(fx.ctx); assert(fx.requests[0].options.body.images.length);
  fx = fixture({ provider: "compatible-responses", compatibleBaseUrl: "https://image.example/v1", compatibleImageModel: "image", compatibleTextModel: "text" });
  const event = { type: "response.completed", response: { status: "completed", output: [{ type: "image_generation_call", status: "completed", result: png }] } };
  const sse = "event: response.created\ndata: {\"type\":\"response.created\"}\n\nevent: response.completed\ndata: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n";
  fx.state.chunks = [sse.slice(0, 42), sse.slice(42, 140), sse.slice(140)]; await draw(fx.ctx);
  assert.equal(fx.requests[0].options.body.model, "text"); assert.equal(fx.requests[0].options.body.tools[0].model, "image");
  fx = fixture(); fx.state.chunks = ["data: " + JSON.stringify({ type: "image_generation.completed", b64_json: png }) + "\n\n"];
  await draw(fx.ctx); assert.equal(fx.stored[0].data, png);
  fx = fixture(); fx.state.payload = { data: [{ url: "https://cdn.example/image.png" }] };
  const open = fx.ctx.api.openStream;
  fx.ctx.api.openStream = async (url, options) => {
    if (url.startsWith("https://cdn")) { fx.state.chunks = [Buffer.from(png, "base64").subarray(0, 17).toString("base64"), Buffer.from(png, "base64").subarray(17).toString("base64")]; }
    return open(url, options);
  };
  await draw(fx.ctx); assert.equal(fx.stored[0].data, png); assert.equal(fx.requests[1].options.headers, undefined, "CDN never receives provider auth");
  fx = fixture(); fx.state.status = 429; await assert.rejects(draw(fx.ctx), /额度/); assert.equal(fx.requests.length, 1); assert.equal(fx.closes.length, 1);
  fx = fixture(); fx.state.chunks = ["data: {\"type\":\"response.failed\",\"error\":{\"message\":\"fixture-secret\"}}\n\n"];
  await assert.rejects(draw(fx.ctx), error => /未完成/.test(error.message) && !error.message.includes("fixture-secret")); assert.equal(fx.requests.length, 1);
  fx = fixture(); fx.state.chunks = ["x".repeat(8 * 1024 * 1024 + 1)]; await assert.rejects(draw(fx.ctx), /过大/); assert.equal(fx.closes.length, 1);
  fx = fixture(); fx.state.payload = { data: [{ b64_json: "AAAA" }] }; await assert.rejects(draw(fx.ctx), /有效/); assert.equal(fx.stored.length, 0);
  fx = fixture(); const tooManyPixels = Buffer.from(png, "base64"); tooManyPixels.writeUInt32BE(100000, 16); tooManyPixels.writeUInt32BE(100000, 20);
  fx.state.payload = { data: [{ b64_json: tooManyPixels.toString("base64") }] }; await assert.rejects(draw(fx.ctx), /尺寸/); assert.equal(fx.stored.length, 0);
  fx = fixture(); fx.state.payload = { data: [{ b64_json: png }, { b64_json: png }] }; await assert.rejects(draw(fx.ctx), /数量/);
  fx = fixture({ provider: "compatible-images", compatibleBaseUrl: "https://user:password@example.org/v1", compatibleImageModel: "custom" });
  await assert.rejects(draw(fx.ctx), /HTTPS/); assert.equal(fx.requests.length, 0);
  fx = fixture(); fx.state.chunks = ["data: {\"type\":\"response.created\"}\n\n"];
  await assert.rejects(draw(fx.ctx), /没有收到完成/); assert.equal(fx.stored.length, 0);
  fx = fixture({ provider: "codex" }); fx.ctx.api.modelRequest = async () => {
    fx.controller.abort(Error("late canceled")); return { output: [{ type: "image_generation_call", result: png }] };
  };
  await assert.rejects(draw(fx.ctx), /late canceled/); assert.equal(fx.stored.length, 0, "late model result cannot publish after cancellation");
  fx = fixture({}, { background: "transparent", format: "jpeg" }); await assert.rejects(draw(fx.ctx), /PNG/); assert.equal(fx.requests.length, 0);
  fx = fixture(); fx.ctx.api.readStream = async () => { fx.controller.abort(Error("cancel fixture")); throw fx.controller.signal.reason; };
  await assert.rejects(draw(fx.ctx), /cancel fixture/); assert.equal(fx.closes.length, 1); assert.equal(fx.stored.length, 0);
  console.log("Image studio: isolated VM; five adapters; JSON edits; SSE/binary chunks; scoped assets; no retry/auth leakage; limits and cancellation passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
