"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const sandbox = vm.createContext({ module: { exports: {} } });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../plugins/image-studio/index.js"), "utf8"), sandbox);
const catalog = sandbox.module.exports.model_catalog;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(source, target = "image") {
  const calls = [], closes = [], streams = new Map(), controller = new AbortController();
  const state = { body: JSON.stringify({ data: [{ id: "text-model" }, { id: "gpt-image-2.6-flare" }] }), status: 200, key: "test-secret" };
  const ctx = { input: { source, target }, config: { compatibleBaseUrl: "https://service.example/v1" },
    principal: { source: "desktop", role: "owner" }, signal: controller.signal, deadlineAt: Date.now() + 30000,
    api: {
      async getSecret() { return state.key; },
      async openStream(url, options) { calls.push({ url, options: plain(options) }); streams.set("one", [state.body]); return { id: "one", status: state.status, ok: state.status === 200 }; },
      async readStream({ id }) { const chunks = streams.get(id), data = chunks.shift() || ""; return { data, done: !chunks.length }; },
      async closeStream({ id }) { closes.push(id); },
      async listModels() { return [{ id: "logged-in", name: "连接一", provider: "codex", loginConfigured: true, primary: true }]; },
      async modelCatalog(request) { calls.push({ modelCatalog: plain(request) }); return { models: [{ id: "gpt-6-sol" }, { id: "gpt-image-2.6-flare" }] }; },
    } };
  return { ctx, state, calls, closes };
}

(async () => {
  let fx = fixture("openai"), result = plain(await catalog(fx.ctx));
  assert.equal(fx.calls[0].url, "https://api.openai.com/v1/models");
  assert.equal(fx.calls[0].options.method, "GET"); assert.equal(fx.calls[0].options.redirect, "error");
  assert.equal(result.models[0].id, "gpt-image-2.6-flare", "image names are suggested first without hiding other provider IDs");
  assert.equal(result.models.length, 1); assert(!JSON.stringify(result).includes("test-secret")); assert.equal(fx.closes.length, 1);
  fx.state.body = JSON.stringify({ data: ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-1.5"].map(id => ({ id })) });
  fx.state.key = "\ufeff Bearer test-secret\r\n";
  assert.equal((await catalog(fx.ctx)).models.length, 5, "all returned image model generations and variants remain selectable");
  assert.equal(fx.calls[1].options.headers.authorization, "Bearer test-secret");
  fx.state.key = "test\u200b-secret";
  await assert.rejects(catalog(fx.ctx), /OpenAI API Key 格式无效/);
  assert.equal(fx.calls.length, 2, "invalid credentials never reach the network broker");
  fx = fixture("compatible"); await catalog(fx.ctx); assert.equal(fx.calls[0].url, "https://service.example/v1/models");
  fx.state.status = 401; await assert.rejects(catalog(fx.ctx), /HTTP 401/); assert.equal(fx.closes.length, 2);
  fx.state.status = 200; fx.state.body = "invalid"; await assert.rejects(catalog(fx.ctx), /格式无效/);
  fx.state.body = "x".repeat(2 * 1024 * 1024 + 1); await assert.rejects(catalog(fx.ctx), /过大/);
  fx = fixture("codex-connections"); result = plain(await catalog(fx.ctx)); assert.equal(result.models[0].id, "logged-in");
  fx = fixture("codex"); result = plain(await catalog(fx.ctx)); assert.deepEqual(result.models.map(m => m.id), ["gpt-image-2.6-flare"]);
  assert.equal(fx.calls[0].modelCatalog.modelId, "logged-in");
  fx.ctx.api.modelCatalog = async () => ({ models: [{ id: "gpt-6-sol" }] });
  assert.deepEqual(plain(await catalog(fx.ctx)).models, [], "chat models are not presented as image models");
  fx.ctx.principal.source = "channel"; await assert.rejects(catalog(fx.ctx), /设置/);
  console.log("Image model catalog: real provider IDs, manual fallback, Codex filtering, bounds and credentials passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
