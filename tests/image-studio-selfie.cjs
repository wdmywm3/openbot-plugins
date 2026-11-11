"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const sourcePath = path.join(__dirname, "../plugins/image-studio/index.js");
const { defaults, mockDatabase } = require("./image-studio-test-helpers.cjs");
// Static 20x20 PNG/JPEG fixtures keep this unit check independent of a host checkout.
const PICTURES = {
  png: "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAIElEQVQ4jWNgYPhPAWIY1cwwGmAMo4mEYTRjMAxUYQAAFMCOgFYcALAAAAAASUVORK5CYII=",
  a: "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAUABQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AnQCOaRAAAAAAf//Z",
  b: "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAUABQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCcAI9AgAAAAAP/2Q==",
};
const STATE_KEY = "selfie.reference.v1";
const PROVIDERS = ["openai-images", "openai-responses", "compatible-images", "compatible-responses", "codex"];
const IDENTITY = "请把固定形象参考图中的角色作为同一个主体";
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function load() { const sandbox = vm.createContext({ module: { exports: {} } }); vm.runInContext(fs.readFileSync(sourcePath, "utf8"), sandbox); return sandbox.module.exports; }

function fixture(pictures, config = {}) {
  const handlers = load(), controller = new AbortController(), state = new Map(), versions = new Map(), streams = new Map();
  const assets = new Map([
    ["shape-a", { ref: "shape-a", revision: "asset-a", name: "形象 A", shared: true, chatId: "", chats: [], mimeType: "image/png", bytes: pictures.png.length, preview: pictures.a }],
    ["shape-b", { ref: "shape-b", revision: "asset-b", name: "形象 B", shared: true, chatId: "", chats: [], mimeType: "image/png", bytes: pictures.png.length, preview: pictures.b }],
    ["private", { ref: "private", revision: "private-a", name: "其他聊天私图", shared: false, chatId: "other-chat", chats: [], mimeType: "image/png", bytes: pictures.png.length, preview: pictures.a }],
  ]);
  let serial = 0;
  const fx = { handlers, controller, state, assets, calls: [], secretReads: [], puts: [], publications: [], removals: [], previews: [], onCharge: null };
  const key = (name, scope) => { assert.equal(scope, "channel", "fixed identity belongs to this instance"); return name; };
  const write = (name, value) => { state.set(name, plain(value)); versions.set(name, (versions.get(name) || 0) + 1); return plain(value); };
  const api = {
    getConfig: async () => plain(fx.ctx.config),
    database: mockDatabase(),
    listModels: async () => [{ id: "signed-in", provider: "codex", primary: true, loginConfigured: true }],
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    getState: async (name, scope) => plain(state.get(key(name, scope))),
    getStateVersion: async (name, scope) => ({ value: plain(state.get(key(name, scope))), version: String(versions.get(name) || 0) }),
    setState: async (name, value, scope) => write(key(name, scope), value),
    compareAndSetState: async (name, version, value, scope) => {
      key(name, scope); if (String(versions.get(name) || 0) !== version) return { applied: false };
      return { applied: true, value: write(name, value) };
    },
    updateState: async (name, reducer, scope) => { key(name, scope); return write(name, reducer(plain(state.get(name)))); },
    assets: async input => {
      if (input.action === "put") { fx.puts.push(plain(input)); return { ref: "result-" + ++serial }; }
      if (input.action === "publish") { fx.publications.push(input.ref); return { url: "openbot-asset://plugin-media/fixture/image" }; }
      if (input.action === "remove") { fx.removals.push(input.ref); assets.delete(input.ref); return { removed: true }; }
      const value = assets.get(input.ref); if (!value) throw Error("媒体不存在或当前范围不可用");
      if (input.action === "info") { const { preview, ...info } = value; return plain(info); }
      if (input.action === "preview") { fx.previews.push(plain(input)); return { ref: value.ref, mimeType: "image/jpeg", data: value.preview }; }
      if (input.action === "read") return { data: value.preview, done: true };
      throw Error("unexpected asset action " + input.action);
    },
    getSecret: async name => { fx.secretReads.push(name); return "fixture-secret"; },
    getCapabilities: async () => ({ features: { nativeModelRequests: true, modelResponseSelection: true } }),
    openStream: async (url, options) => {
      fx.calls.push({ url, body: plain(options.body) }); await fx.onCharge?.();
      const response = url.endsWith("/responses") ? { status: "completed", output: [{ type: "image_generation_call", status: "completed", result: pictures.png.toString("base64") }] }
        : { data: [{ b64_json: (options.body.output_format === "gif" ? pictures.gif : pictures.png).toString("base64") }] };
      const id = "stream-" + ++serial; streams.set(id, JSON.stringify(response)); return { id, status: 200, headers: { "content-type": "application/json" } };
    },
    readStream: async ({ id }) => { controller.signal.throwIfAborted(); const data = streams.get(id); streams.delete(id); return { data, done: true }; },
    closeStream: async ({ id }) => { streams.delete(id); },
    modelRequest: async request => {
      fx.calls.push({ native: plain(request) }); await fx.onCharge?.();
      return { output: [{ type: "image_generation_call", status: "completed",
        result: (request.tools[0].output_format === "gif" ? pictures.gif : pictures.png).toString("base64") }] };
    },
    readMessageAttachment: async () => { throw Error("selfies must not substitute a caller's chat attachment for fixed identity"); },
  };
  fx.ctx = { api, config: { ...defaults, provider: "openai-images", imageEnabled: true, selfieEnabled: false, allowNonOwnerDrawing: true,
    openaiImageModel: "gpt-image-2.6-sunburst", openaiTextModel: "fixture-chat", compatibleBaseUrl: "https://images.example/v1",
    compatibleImageModel: "fixture-image", compatibleTextModel: "fixture-text", compatibleJsonEdits: true, ...config },
    input: { mode: "selfie", prompt: "在樱花树下拍张照片" }, signal: controller.signal, deadlineAt: Date.now() + 60000,
    principal: { source: "channel", role: "member", senderId: "member", channelId: "fixture", messageType: "group", chatId: "chat-a" }, message: { chatId: "chat-a" } };
  fx.manage = input => handlers.selfie_reference({ ...fx.ctx, input, principal: { source: "desktop", role: "owner" }, message: { chatId: "" } });
  fx.draw = input => handlers.draw_image({ ...fx.ctx, input: { ...fx.ctx.input, ...input } });
  fx.set = (assetRef = "shape-a", expectedRevision = state.get(STATE_KEY)?.revision || 0) => fx.manage({ action: "set", assetRef, expectedRevision });
  return fx;
}

(async () => {
  const png = Buffer.from(PICTURES.png, "base64"), { a, b } = PICTURES;
  const gif = Buffer.from("R0lGODlhAgABAIEAAExpcQD/AP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAAAgABAAACAlQKACH5BAUPAAAALAAAAAACAAEAgUxpcf//AAAA/wAAAAICVAoAOw==", "base64");
  const pictures = { png, gif, a, b };
  let fx = fixture(pictures);
  assert.equal(typeof fx.handlers.selfie_reference, "function", "the plugin exposes its declared desktop reference action");
  const empty = await fx.manage({ action: "get" });
  assert.equal(empty.assetRef, ""); assert.equal(empty.name, ""); assert.equal(empty.revision, 0); assert.equal(empty.updatedAt, 0);
  const selected = await fx.set(); assert.equal(selected.revision, 1); assert.equal(selected.assetRef, "shape-a");
  assert.equal(fx.state.get(STATE_KEY).assetRef, "shape-a"); assert.ok(!JSON.stringify(fx.state.get(STATE_KEY)).includes(a), "persistent reference state contains no image payload");
  assert.equal((await load().selfie_reference({ ...fx.ctx, input: { action: "get" }, principal: { source: "desktop", role: "owner" } })).assetRef, "shape-a", "reference survives a new plugin VM");
  await assert.rejects(fx.set("shape-b", 0), /变化|版本|revision|刷新|更新/);
  assert.equal((await fx.set("shape-b", 1)).revision, 2);
  await assert.rejects(fx.manage({ action: "clear", expectedRevision: 1 }), /变化|版本|revision|刷新|更新/);
  const cleared = await fx.manage({ action: "clear", expectedRevision: 2 }); assert.equal(cleared.revision, 3); assert.equal(cleared.assetRef, "");
  assert.equal(fx.assets.has("shape-a"), true); assert.equal(fx.assets.has("shape-b"), true); assert.equal(fx.removals.length, 0, "changing identity must preserve media already used by history");
  await assert.rejects(fx.set("shape-a", 0), /变化|版本|revision|刷新|更新/);
  await fx.set("shape-a", 3);
  const concurrent = await Promise.allSettled([fx.set("shape-a", 4), fx.set("shape-b", 4)]);
  assert.equal(concurrent.filter(value => value.status === "fulfilled").length, 1, "two edits cannot both commit the same expected revision");
  for (const principal of [{ source: "channel", role: "owner" }, { source: "desktop", role: "member" }]) {
    await assert.rejects(fx.handlers.selfie_reference({ ...fx.ctx, input: { action: "clear", expectedRevision: 5 }, principal }), /管理|桌面|主人/);
  }
  await assert.rejects(fx.set("private", 5), /共享|实例|聊天|私/);
  fx.assets.set("oversized", { ...fx.assets.get("shape-a"), ref: "oversized", bytes: 10 * 1024 * 1024 + 1 });
  await assert.rejects(fx.set("oversized", 5), /大小|过大|10|MiB/);

  for (const imageEnabled of [false, true]) for (const selfieEnabled of [false, true]) {
    for (const mode of ["image", "selfie"]) {
      fx = fixture(pictures, { imageEnabled, selfieEnabled }); await fx.set();
      if (mode === "image" ? imageEnabled : selfieEnabled) {
        const result = await fx.draw({ mode }); assert.equal(result.mode, mode); assert.equal(fx.calls.length, 1);
      } else {
        await assert.rejects(fx.draw({ mode }), /关闭|未开启|未启用/); assert.equal(fx.calls.length, 0); assert.equal(fx.secretReads.length, 0);
      }
    }
  }
  fx = fixture(pictures, { imageEnabled: false, selfieEnabled: true }); await fx.set();
  await assert.rejects(fx.draw({ mode: undefined }), /关闭|未开启|未启用/, "omitting mode remains ordinary generation even when selfies are enabled");
  for (const mode of ["portrait", "SELFIE", true]) await assert.rejects(fx.draw({ mode }), /模式|方式|mode|无效/);
  await assert.rejects(fx.draw({ mode: "selfie", references: [{ assetRef: "shape-b" }] }), /参考|形象/);
  assert.equal(fx.calls.length, 0);

  for (const provider of PROVIDERS) {
    fx = fixture(pictures, { provider, imageEnabled: false, selfieEnabled: true }); await fx.set();
    const result = await fx.draw(); assert.equal(result.mode, "selfie"); assert.equal(result.selfieReferenceRevision, 1);
    const request = fx.calls[0].native || fx.calls[0].body;
    const prompt = request.input ? request.input[0].content[0].text : request.prompt;
    const first = request.input ? request.input[0].content.find(part => part.type === "input_image") : request.images[0];
    assert.equal(first.image_url, "data:image/jpeg;base64," + a, provider + " must send the configured identity image");
    assert.ok(prompt.includes(IDENTITY), provider + " must preserve the explicit identity constraint");
    assert.ok(prompt.includes(fx.ctx.input.prompt));
    if (request.tools) assert.equal(request.tools[0].action, "edit"); else assert.ok(fx.calls[0].url.endsWith("/images/edits"));
    assert.equal(fx.puts.length, 1); assert.equal(fx.publications.length, 1);
    assert.ok(!JSON.stringify(result).includes(a));
  }
  for (const provider of ["openai-images", "codex"]) {
    fx = fixture(pictures, { provider, imageEnabled: false, selfieEnabled: true }); await fx.set();
    const animatedSelfie = await fx.draw({ format: "gif", frameCount: 2 });
    assert.equal(animatedSelfie.images[0].mimeType, "image/gif");
    const request = fx.calls[0].native || fx.calls[0].body;
    const first = request.input ? request.input[0].content.find(part => part.type === "input_image") : request.images[0];
    assert.equal(first.image_url, "data:image/jpeg;base64," + a);
    assert.equal((request.tools?.[0] || request).output_format, "gif");
    if (!request.tools) assert(!("stream" in request));
  }
  fx = fixture(pictures, { imageEnabled: true, selfieEnabled: false }); await fx.set();
  await fx.draw({ mode: "image" }); assert.equal(fx.calls[0].body.prompt, fx.ctx.input.prompt); assert.equal(fx.calls[0].body.images, undefined, "ordinary generation does not inherit the fixed selfie reference");

  for (const problem of ["missing", "deleted", "private", "preview-error"]) {
    fx = fixture(pictures, { selfieEnabled: true });
    if (problem !== "missing") await fx.set();
    if (problem === "deleted") fx.assets.delete("shape-a");
    if (problem === "private") fx.assets.get("shape-a").shared = false;
    if (problem === "preview-error") fx.ctx.api.assets = async () => { throw Error("reference inaccessible"); };
    await assert.rejects(fx.draw()); assert.equal(fx.calls.length, 0, problem + " cannot consume provider quota"); assert.equal(fx.secretReads.length, 0);
    assert.equal(fx.puts.length, 0);
  }
  fx = fixture(pictures, { provider: "compatible-images", compatibleJsonEdits: false, selfieEnabled: true }); await fx.set();
  await assert.rejects(fx.draw(), /参考图|JSON/); assert.equal(fx.calls.length, 0, "a provider without reference editing never falls back to text-only generation");

  for (const change of ["replace", "clear", "revoke", "disable", "cancel"]) {
    fx = fixture(pictures, { selfieEnabled: true, provider: "codex" }); await fx.set();
    fx.onCharge = async () => {
      if (change === "replace") await fx.set("shape-b", 1);
      if (change === "clear") await fx.manage({ action: "clear", expectedRevision: 1 });
      if (change === "revoke") fx.assets.get("shape-a").shared = false;
      if (change === "disable") fx.ctx.config.selfieEnabled = false;
      if (change === "cancel") fx.controller.abort(Error("cancel selfie"));
    };
    await assert.rejects(fx.draw()); assert.equal(fx.publications.length, 0, change + " must prevent publication of a stale or unauthorized selfie");
  }
  console.log("Image studio selfies: independent switches, five provider identity edits, persistent CAS reference, no caller substitution/no-quota failures, cancellation/revocation and stale-result isolation passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
