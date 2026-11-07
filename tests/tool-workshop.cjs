"use strict";
// Integration uses an explicit source checkout only for tests. The package never
// imports host internals or depends on another application's installation.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const host = path.resolve(process.env.OPENBOT_HOST_ROOT || path.join(__dirname, "../../openbot"));
const { executePluginWorker, shutdownPluginWorkers } = require(path.join(host, "electron/lib/features/channels/plugin-worker-pool.cjs"));
const { createPluginScriptRuntime } = require(path.join(host, "electron/lib/plugins/plugin-script.cjs"));
const { readPluginPackage } = require(path.join(host, "electron/lib/plugins/plugin-package.cjs"));
const source = fs.readFileSync(path.join(__dirname, "../plugins/tool-workshop/index.js"), "utf8");
const scripts = createPluginScriptRuntime();
const states = new Map();
const plain = value => JSON.parse(JSON.stringify(value));
const schema = { type: "object", properties: { text: { type: "string", maxLength: 2000 } }, required: ["text"], additionalProperties: false };
function fixture(chatId = "owner-private", requestAdapter, scriptAdapters = {}) {
  let config = { allowNetwork: false }, networkCalls = 0;
  const key = value => `${chatId}:${value}`;
  const api = {
    getState: async value => plain(states.get(key(value))?.value ?? null),
    getStateVersion: async value => ({ value: plain(states.get(key(value))?.value ?? null), version: String(states.get(key(value))?.version ?? 0) }),
    compareAndSetState: async (name, revision, value) => {
      const current = states.get(key(name));
      if (String(current?.version ?? 0) !== revision) return { applied: false };
      states.set(key(name), { value: plain(value), version: Number(revision) + 1 }); return { applied: true, value: plain(value) };
    },
  };
  return {
    setConfig(value) { config = value; }, get networkCalls() { return networkCalls; },
    call(exportName, input, principal = { role: "owner", messageType: "private" }, externalSignal) {
      const runScript = request => scripts.run(request, { ...scriptAdapters, owner: chatId, signal: externalSignal,
        request: async (url, options, signal) => {
          networkCalls++;
          return requestAdapter ? requestAdapter(url, options, signal) : { ok: true, status: 200, body: { seen: options.method || "GET" } };
        } });
      return executePluginWorker({ code: source, api: { ...api, runScript }, context: { input, principal, config }, filename: "tool-workshop/index.js", exportName,
        executionTimeoutMs: 200000, externalSignal });
    },
  };
}

async function main() {
  const parsed = readPluginPackage(path.join(__dirname, "../plugins/tool-workshop"));
  assert.equal(parsed.manifest.permissions.includes("script:run"), true);
  assert.equal(parsed.skills.length, 1); assert.equal(parsed.mcpServers.length, 0);
  const f = fixture();
  assert.equal((await f.call("manage", { action: "list" })).tools.length, 0);
  await assert.rejects(f.call("manage", { action: "list" }, { role: "member", messageType: "private" }), /主人私聊/);
  await assert.rejects(f.call("manage", { action: "list" }, { role: "owner", messageType: "group" }), /主人私聊/);
  const draft = { action: "draft", id: "normalize-space", revision: 0, title: "整理空白", description: "整理用户提供文本中的多余空白", inputSchema: schema,
    code: "module.exports.run = ctx => ({text:ctx.input.text.trim().replace(/\\s+/g,' ')});" };
  const created = await f.call("manage", draft); assert.equal(created.revision, 1); assert.equal(created.tested, false);
  await assert.rejects(f.call("manage", { action: "save", id: draft.id, revision: 1 }), /先让当前草稿通过/);
  await assert.rejects(f.call("run", { id: draft.id, revision: 1, input: { text: "a" } }), /尚未保存/);
  const test = await f.call("manage", { action: "test", id: draft.id, revision: 1, input: { text: "  a \n b   c " }, expectedJson: JSON.stringify({ text: "a b c" }) });
  assert.equal(test.passed, true); assert.equal(test.result.text, "a b c");
  await f.call("manage", { action: "test", id: draft.id, revision: 1, input: { text: "" }, expectedJson: JSON.stringify({ text: "" }) });
  const saved = await f.call("manage", { action: "save", id: draft.id, revision: 1 }); assert.equal(saved.savedRevision, 1);
  assert.equal((await f.call("run", { id: draft.id, revision: 1, input: { text: " x   y " } })).result.text, "x y");
  await assert.rejects(f.call("run", { id: draft.id, revision: 1, input: { text: 123 } }), /类型应为 string/);
  await assert.rejects(f.call("run", { id: draft.id, revision: 1, input: { text: "a", unexpected: true } }), /未声明/);
  await assert.rejects(f.call("run", { id: draft.id, revision: 1, input: {} }), /必填/);
  await assert.rejects(f.call("manage", draft), /版本已变化/);
  const edited = await f.call("manage", { ...draft, revision: 1, code: "module.exports.run = ctx => ({text:ctx.input.text.toUpperCase()});" });
  assert.equal(edited.revision, 2); assert.equal(edited.savedRevision, 1); assert.equal(edited.tested, false);
  assert.equal((await f.call("run", { id: draft.id, revision: 1, input: { text: " x   y " } })).result.text, "x y", "draft edits retain the published version");
  assert.equal((await f.call("manage", { action: "test", id: draft.id, revision: 2, input: { text: "a" }, expectedJson: JSON.stringify({ text: "wrong" }) })).passed, false);
  await assert.rejects(f.call("manage", { action: "save", id: draft.id, revision: 2 }), /先让当前草稿通过/);
  await f.call("manage", { action: "test", id: draft.id, revision: 2, input: { text: "a" }, expectedJson: JSON.stringify({ text: "A" }) });
  await f.call("manage", { action: "save", id: draft.id, revision: 2 });
  await assert.rejects(f.call("run", { id: draft.id, revision: 1, input: { text: "a" } }), /保存版本已变化/);
  assert.equal((await f.call("run", { id: draft.id, revision: 2, input: { text: "a" } })).result.text, "A");
  assert.equal((await fixture("other-chat").call("manage", { action: "list" })).tools.length, 0);
  await assert.rejects(f.call("manage", { ...draft, id: "invalid-schema", inputSchema: { ...schema, pattern: "a+" } }), /不支持/);
  await assert.rejects(f.call("manage", { ...draft, id: "invalid-schema", inputSchema: { ...schema, additionalProperties: true } }), /additionalProperties/);
  await assert.rejects(f.call("manage", { ...draft, id: "forbidden-capability", capabilities: ["getSecret"] }), /只支持可选/);
  const apiDraft = { ...draft, id: "public-api", capabilities: ["request"], code: "module.exports.run = async ctx => { const r = await ctx.api.request('https://example.test', {responseType:'json'}); if(!r.ok) throw Error('HTTP '+r.status); return r.body; };" };
  await assert.rejects(f.call("manage", apiDraft), /尚未允许工具联网/);
  f.setConfig({ allowNetwork: true });
  const apiCreated = await f.call("manage", apiDraft), apiRevision = apiCreated.revision;
  assert.equal((await f.call("manage", { action: "test", id: apiDraft.id, revision: apiRevision, input: { text: "unused" }, expectedJson: JSON.stringify({ seen: "GET" }) })).passed, true);
  await f.call("manage", { action: "save", id: apiDraft.id, revision: apiRevision });
  assert.equal((await f.call("run", { id: apiDraft.id, revision: apiRevision, input: { text: "unused" } })).result.seen, "GET");
  f.setConfig({ allowNetwork: false }); const previousCalls = f.networkCalls;
  await assert.rejects(f.call("run", { id: apiDraft.id, revision: apiRevision, input: { text: "unused" } }), /尚未允许/);
  assert.equal(f.networkCalls, previousCalls, "network revocation prevents dispatch");
  const loop = await f.call("manage", { ...draft, id: "infinite-loop", code: "module.exports.run = () => { for (;;) {} };" });
  await assert.rejects(f.call("manage", { action: "test", id: "infinite-loop", revision: loop.revision, input: { text: "a" }, timeoutMs: 200 }), /timed out/);
  assert.equal((await f.call("manage", { action: "list" })).tools.some(row => row.id === "infinite-loop" && !row.tested), true);
  await f.call("manage", { action: "remove", id: "infinite-loop", revision: loop.revision });
  assert.equal((await f.call("manage", { action: "list" })).tools.some(row => row.id === "infinite-loop"), false);
  assert.equal((await f.call("manage", { action: "read", id: draft.id })).saved.code.includes("toUpperCase"), true);
  await revisionRaces();
  await generatedDrawing();
  console.log("tool workshop: real host VM + isolated scripts, generated drawing/model/media workflow, schema checks, draft/test/save/run, version conflicts, deletion/recreation and test-attempt races, chat isolation, capability opt-in/revocation and cancellation passed");
}

async function generatedDrawing() {
  const { createPluginAssetsBackground } = require(path.join(host, "electron/lib/plugins/plugin-assets-background.cjs"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-generated-drawing-")), media = createPluginAssetsBackground({ root });
  const actor = { channelId: "workshop", pluginId: "tool-workshop", chatId: "drawing-owner" };
  const tiny = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64");
  const data = Buffer.concat([tiny, Buffer.alloc(800000)]).toString("base64");
  let modelCalls = 0, mediaCalls = 0, waitForCancel = false, modelSignal, started;
  const modelEntered = new Promise(resolve => { started = resolve; });
  const f = fixture(actor.chatId, undefined, {
    async modelRequest(request, signal) {
      modelCalls++; assert(!("headers" in request)); assert(!("token" in request)); assert(!("model" in request));
      assert.equal(request.tools[0].type, "image_generation");
      modelSignal = signal;
      if (waitForCancel) { started(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
      return { modelId: "signed-in", output: [{ type: "image_generation_call", status: "completed", result: data }] };
    },
    assets(input, signal) { mediaCalls++; return media.call(actor, input, { signal }); },
  });
  const draft = { action: "draft", id: "my-drawing", revision: 0, title: "我的画图工具", description: "用实例模型绘图并保存到当前聊天",
    inputSchema: { type: "object", properties: { prompt: { type: "string", minLength: 1, maxLength: 1000 } }, required: ["prompt"], additionalProperties: false },
    capabilities: ["modelRequest", "assets"],
    code: `module.exports.run=async ctx=>{
      const generated=await ctx.api.modelRequest({input:[{role:'user',content:[{type:'input_text',text:ctx.input.prompt}]}],tools:[{type:'image_generation',output_format:'png'}],timeoutMs:120000});
      const images=(generated.output||[]).filter(item=>item.type==='image_generation_call');
      if(images.length!==1||images[0].status!=='completed'||!images[0].result.startsWith('iVBORw0KGgo')) throw Error('没有收到PNG图片');
      const stored=await ctx.api.assets({action:'put',data:images[0].result,mimeType:'image/png',name:'my-drawing.png',kind:'image'});
      const published=await ctx.api.assets({action:'publish',ref:stored.ref});
      return {assetRef:stored.ref,url:published.url};
    }`,
  };
  try {
    await assert.rejects(f.call("manage", draft), /尚未允许工具调用模型/);
    f.setConfig({ allowModelRequests: true }); await assert.rejects(f.call("manage", draft), /尚未允许工具保存媒体/);
    f.setConfig({ allowModelRequests: true, allowMedia: true });
    const created = await f.call("manage", draft);
    const test = await f.call("manage", { action: "test", id: draft.id, revision: created.revision, input: { prompt: "蓝色小猫" } });
    assert.equal(test.passed, true); assert(test.result.url.startsWith("openbot-asset://plugin-media/"));
    assert(!JSON.stringify(test).includes(data)); assert.equal(modelCalls, 1); assert.equal(mediaCalls, 2);
    assert.equal((await media.info(actor, test.result.assetRef, {})).bytes, Buffer.from(data, "base64").length);
    await assert.rejects(media.info({ ...actor, chatId: "different-owner" }, test.result.assetRef, {}), /不可用/);
    await f.call("manage", { action: "save", id: draft.id, revision: created.revision });
    const reused = await f.call("run", { id: draft.id, revision: created.revision, input: { prompt: "再次画猫" } });
    assert(reused.result.url); assert.equal(modelCalls, 2, "saved generated code invokes model and publishes again");
    f.setConfig({ allowMedia: true }); await assert.rejects(f.call("run", { id: draft.id, revision: created.revision, input: { prompt: "blocked" } }), /尚未允许工具调用模型/);
    f.setConfig({ allowModelRequests: true }); await assert.rejects(f.call("run", { id: draft.id, revision: created.revision, input: { prompt: "blocked" } }), /尚未允许工具保存媒体/);
    assert.equal(modelCalls, 2, "capability revocation prevents dispatch");
    f.setConfig({ allowModelRequests: true, allowMedia: true }); waitForCancel = true;
    const controller = new AbortController(), before = mediaCalls;
    const canceled = f.call("run", { id: draft.id, revision: created.revision, input: { prompt: "cancel this" } }, undefined, controller.signal);
    const rejected = assert.rejects(canceled, /cancel generated drawing/);
    let timer;
    try {
      await Promise.race([modelEntered, new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error("native drawing never started")), 5000); })]);
    } finally { clearTimeout(timer); controller.abort(Error("cancel generated drawing")); }
    await rejected;
    assert.equal(modelSignal.aborted, true); assert.equal(mediaCalls, before, "canceled generation never saves or publishes an image");
  } finally {
    await media.pause();
    const resolved = path.resolve(root); assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("openbot-generated-drawing-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

async function revisionRaces() {
  const waits = [];
  const f = fixture("revision-races", async () => new Promise(resolve => waits.push(resolve)));
  f.setConfig({ allowNetwork: true });
  const inputSchema = { type: "object", properties: {}, additionalProperties: false };
  const draft = { action: "draft", id: "recreated", revision: 0, title: "查询", description: "查询公开数据", inputSchema,
    capabilities: ["request"], code: "module.exports.run=async ctx=>(await ctx.api.request('https://example.test')).body" };
  const started = async count => {
    for (let n = 0; waits.length < count && n < 200; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(waits.length, count, "real script worker reached its network request");
  };
  const initial = await f.call("manage", draft);
  const old = f.call("manage", { action: "test", id: draft.id, revision: initial.revision, input: {}, expectedJson: "1" });
  const oldRejected = assert.rejects(old, /版本已变化/);
  await started(1);
  await f.call("manage", { action: "remove", id: draft.id, revision: initial.revision });
  const recreated = await f.call("manage", { ...draft, code: "module.exports.run=()=>999" });
  assert(recreated.revision > initial.revision, "ID recreation never reuses revisions");
  waits[0]({ ok: true, body: 1 }); await oldRejected;
  await assert.rejects(f.call("manage", { action: "save", id: draft.id, revision: recreated.revision }), /先让当前草稿通过/);
  await assert.rejects(f.call("manage", { action: "save", id: draft.id, revision: initial.revision }), /版本已变化/);
  await f.call("manage", { action: "test", id: draft.id, revision: recreated.revision, input: {}, expectedJson: "999" });
  await f.call("manage", { action: "save", id: draft.id, revision: recreated.revision });
  await assert.rejects(f.call("run", { id: draft.id, revision: initial.revision, input: {} }), /保存版本已变化/);
  assert.equal((await f.call("run", { id: draft.id, revision: recreated.revision, input: {} })).result, 999);

  const concurrent = await f.call("manage", { ...draft, id: "concurrent" });
  const testInput = { action: "test", id: "concurrent", revision: concurrent.revision, input: {}, expectedJson: "1" };
  const older = f.call("manage", testInput), olderRejected = assert.rejects(older, /更新的试运行/); await started(2);
  const newer = f.call("manage", testInput); await started(3);
  waits[2]({ ok: true, body: 1 }); assert.equal((await newer).passed, true);
  waits[1]({ ok: true, body: 0 }); await olderRejected;
  assert.equal((await f.call("manage", { action: "read", id: "concurrent" })).test.passed, true, "late failed test cannot replace newer success");
  await f.call("manage", { action: "save", id: "concurrent", revision: concurrent.revision });

  const oldSuccess = f.call("manage", testInput), superseded = assert.rejects(oldSuccess, /更新的试运行/); await started(4);
  const newFailure = f.call("manage", testInput); await started(5);
  waits[4]({ ok: true, body: 0 }); assert.equal((await newFailure).passed, false);
  waits[3]({ ok: true, body: 1 }); await superseded;
  await assert.rejects(f.call("manage", { action: "save", id: "concurrent", revision: concurrent.revision }), /先让当前草稿通过/);
}
main().then(() => shutdownPluginWorkers(), error => { console.error(error); shutdownPluginWorkers(); process.exitCode = 1; });
