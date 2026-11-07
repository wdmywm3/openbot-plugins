"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../plugins/meme-library/index.js"), "utf8");
let drawValue;
const testMath = Object.create(Math); testMath.random = () => drawValue ?? Math.random();
const moduleObject = { exports: {} }; vm.runInNewContext(source, { module: moduleObject, console, Math: testMath }, { timeout: 1000 });
const plugin = moduleObject.exports;
const copy = v => v === undefined ? v : JSON.parse(JSON.stringify(v));
const VERSION = "embeddinggemma-2-daa72c512439-q8-768-joint-v1";
const vector = Array(768).fill(0); vector[0] = 1;
function fixture() {
  const records = new Map(), assets = new Map(), jobs = [], state = new Map(), calls = [], events = new Map(), indices = new Map();
  let serial = 0, checkpoint = null, jobId = "fixture", beforeGenerate, beforeEmbed, modelReady = true;
  const ctx = { plugin: { id: "meme-library" }, profile: { id: "p" }, config: {}, message: { id: "message", chatId: "group", sender: { id: "u" } },
    signal: new AbortController().signal, api: {
      async embeddings(input) {
        const model = { id: "embeddinggemma-2", name: "Gemma", version: VERSION, dimension: 768, modalities: ["text", "image", "joint"], ready: modelReady };
        if (input.action === "models") return { defaultModelId: model.id, models: [model] };
        return { ...model, running: false, error: modelReady ? "" : "download unavailable" };
      },
      async vectorIndex(input) {
        if (input.action === "delete") { for (const id of input.ids) indices.delete(id); return { removed: true }; }
        if (!modelReady) throw Error("model unavailable");
        calls.push("embed");
        if (input.action === "upsert") {
          for (const row of input.records) {
            await beforeEmbed?.({ hash: assets.get(row.input.assetRef)?.sha256, text: row.input.text, query: false });
            indices.set(row.id, copy(row));
          }
          return { version: VERSION, records: input.records.map(row => ({ id: row.id, revision: row.revision, accepted: true })) };
        }
        assert.equal(input.timeoutMs, 1500, "interactive semantic lookup has a bounded deadline");
        await beforeEmbed?.({ query: true, text: input.query.text });
        const matches = input.candidates.filter(row => indices.get(row.id)?.revision === row.revision).map(row => ({ ...row, score: 1 }));
        return { version: VERSION, matches, missing: input.candidates.length - matches.length };
      },
      async journal(input) {
        const previous = events.get(input.key);
        if (input.action === "get") return { record: copy(previous) || null };
        if (input.action === "query") return { records: [...events.values()].filter(r => !input.where || Object.entries(input.where).every(([k,v]) => r.value[k] === v)).map(copy), nextCursor: null };
        assert.equal(previous?.revision || 0, input.expectedRevision);
        const row = { key: input.key, revision: (previous?.revision || 0) + 1, value: copy(input.value) }; events.set(input.key, row); return { record: copy(row) };
      },
      async database(input) {
        const key = input.collection + ":" + input.key, previous = records.get(key);
        if (input.action === "query") return { records: [...records.entries()].filter(([key, row]) => key.startsWith(input.collection + ":")
          && (!input.where?.["source.type"] || row.value.source?.type === input.where["source.type"])).map(([, value]) => copy(value)), nextCursor: null };
        if (input.action === "get") return { record: copy(previous) || null };
        if (input.action === "put") {
          if ((previous?.revision || 0) !== input.expectedRevision) throw Error("revision conflict");
          const row = { key: input.key, value: copy(input.value), revision: ++serial }; records.set(key, row); return { record: copy(row) };
        }
        throw Error("unexpected database action");
      },
      async assets(input) {
        if (input.action === "fromMessage") { assert.equal(input.messageId, "message"); return copy(assets.get("chat")); }
        if (input.action === "put") return copy(assets.get("qq"));
        const a = assets.get(input.ref); if (!a) throw Error("missing asset");
        if (input.action === "info") return copy(a);
        if (input.action === "read") return { ...copy(a), data: "aGk=", done: true };
        if (input.action === "publish") return { url: "openbot-asset://plugin-media/" + a.sha256 + "/image" };
        if (input.action === "grant") { Object.assign(a, { shared: input.shared, chats: input.chats, revision: String(++serial) }); return copy(a); }
        throw Error("unexpected asset action");
      },
      async jobs(input) {
        if (input.action === "start") { jobs.push(copy(input)); return { id: String(jobs.length), status: "queued" }; }
        if (input.action === "current") return { id: jobId, checkpoint };
        if (input.action === "checkpoint" || input.action === "yield") { checkpoint = input.checkpoint; return {}; }
        if (input.action === "list") return { jobs: [], nextCursor: null };
        return {};
      },
      async generate() { calls.push("recognize"); await beforeGenerate?.(); return { modelId: "vision", text: JSON.stringify({ caption: "捂住钱包的猫", meaning: "自嘲没钱", tags: ["钱包", "穷"], ocrText: "没钱了" }) }; },
      async callTool(request) {
        const p = request.arguments; calls.push(p.action);
        let out;
        if (p.action === "status") out = { ready: modelReady };
        else if (p.action === "install") out = { ready: modelReady, running: false, error: modelReady ? "" : "download unavailable" };
        else if (p.action === "has") out = { present: false };
        else if (p.action === "put") out = { done: true };
        else if (p.action === "prepare") out = { mimeType: "image/jpeg", data: "aGk=" };
        else if (p.action === "embed") { if (!modelReady) throw Error("model unavailable"); await beforeEmbed?.(p); out = { version: VERSION, vector }; }
        else throw Error("unexpected engine action");
        return { structuredContent: out };
      },
      async sleep() {}, async getState(key) { return state.get(key); }, async setState(key, value) { state.set(key, value); },
      async getCapabilities() { return { platform: "napcat", features: { persistentContextItems: true } }; },
      async callNapCat(action) { assert.equal(action, "fetch_custom_face"); return { data: [{ url: "https://qpic.cn/image", id: "face" }] }; },
      async request() { return { ok: true, headers: { "content-type": "image/png" }, body: "aGk=" }; },
      async listContexts() { return { profiles: [{ id: "p", name: "当前角色" }, { id: "other", name: "其他角色" }], chats: [{ id: "group", name: "当前聊天" }, { id: "other", name: "其他聊天" }] }; }, async listModels() { return []; },
    } };
  const asset = (ref, id, shared = true) => assets.set(ref, { ref, sha256: id.repeat(64), mimeType: "image/png", bytes: 2, revision: "1", shared, chatId: shared ? "" : "group", chats: [] });
  asset("import", "a"); asset("chat", "b", false); asset("qq", "c");
  return { ctx, records, assets, calls, jobs, state, events, get: id => copy(records.get("items:" + id.repeat(64))),
    async syncProfiles() { checkpoint = null; jobId = "fixture-" + ++serial; let result;
      do { result = await plugin.syncProfiles(ctx); } while (result.continuing);
      return result; },
    onGenerate(fn) { beforeGenerate = fn; }, onEmbed(fn) { beforeEmbed = fn; }, modelReady(value) { modelReady = value; } };
}
async function main() {
  const probability = fixture();
  await plugin.importFiles({ ...probability.ctx, input: { refs: ["import"] } });
  await plugin.process({ ...probability.ctx, input: { ids: ["a".repeat(64)] } });
  const picked = await plugin.stickers({ ...probability.ctx, input: { action: "search", query: "钱包" } });
  const url = picked.candidates[0].url, picture = `![钱包](${url})`, mixed = `钱包空了${picture}`;
  probability.records.set("settings:default", { value: { frequency: 90, cooldownSeconds: 0 } });
  const after = (replyId, content = mixed) => plugin.afterModel({ ...probability.ctx, hook: { type: "afterModel", replyId, content } });
  drawValue = 0.95;
  assert.equal((await after("miss")).content, "钱包空了");
  drawValue = 0.05;
  assert.equal((await after("miss")).content, "钱包空了", "retry must reuse the missed draw");
  assert.equal(Object.keys(await after("another-person")).length, 0, "independent replies draw independently");
  const otherImage = '![普通照片](https://example.com/photo.png)';
  drawValue = 0.95;
  assert.equal((await after("other-image", mixed + otherImage)).content, "钱包空了" + otherImage, "never remove another image provider's content");
  assert.equal(Object.keys(await after("text-only", "没有合适的表情，正常文字内容")).length, 0);
  assert.equal(Object.keys(await after("photo-only", otherImage)).length, 0);
  let retained = 0;
  for (let i = 0; i < 100; i++) {
    drawValue = (i + 0.5) / 100;
    if ((await after("sample-" + i)).content === undefined) retained++;
  }
  assert.equal(retained, 90, "90 percent controls mixed-message sticker retention, not searching");
  probability.records.get("settings:default").value.frequency = 0;
  assert.equal(Object.keys(await after("pure", picture)).length, 0, "pure stickers bypass even a zero-percent frequency");
  assert.equal(Object.keys(await after("pure-at", `[at:123] ${picture}`)).length, 0, "addressing a person does not turn a pure sticker into prose");
  assert.equal(probability.events.has("send:pure"), false, "pure replies never draw");
  assert.equal((await after("zero-mixed")).content, "钱包空了");
  assert((await plugin.stickers({ ...probability.ctx, input: { action: "search", query: "钱包" } })).candidates.length,
    "zero frequency does not disable search or proactive pure stickers");
  const pureSegments = [{ type: "image", data: { file: url } }];
  assert.equal((await plugin.beforeSend({ ...probability.ctx, hook: { content: pureSegments } })).content.length, 1);
  const prompt = await plugin.beforeModel(probability.ctx);
  assert.match(prompt.systemPromptAppend, /每条独立回复.*必须先/);
  assert.match(prompt.contextItems[0].content, /0%/);
  assert.doesNotMatch(prompt.systemPromptAppend, /needs_review|preparationId/);
  drawValue = undefined;
  const templated = fixture(), templateId = "a".repeat(64);
  await plugin.importFiles({ ...templated.ctx, input: { refs: ["import"] } });
  const template = { version: 1, rect: { x: .1, y: .1, width: .7, height: .3 }, color: "#192550", align: "center", maxFontSize: .075 };
  await plugin.save({ ...templated.ctx, input: { id: templateId, revision: templated.get("a").revision, textTemplate: template } });
  const engineCall = templated.ctx.api.callTool, assetCall = templated.ctx.api.assets;
  templated.ctx.api.callTool = async request => request.arguments.action === "renderText"
    ? { structuredContent: { data: "aGk=", mimeType: "image/webp" } } : engineCall(request);
  templated.ctx.api.assets = async input => {
    if (input.action !== "put") return assetCall(input);
    const result = { ref: "rendered", sha256: "e".repeat(64), mimeType: "image/webp", bytes: 2, revision: "1", shared: false, chatId: "group", chats: [] };
    templated.assets.set("rendered", result); return result;
  };
  const templates = await plugin.stickers({ ...templated.ctx, input: { action: "search" } });
  assert.equal(templates.candidates[0].textTemplate, true); assert.equal(templates.candidates[0].url, undefined, "blank templates are not offered as sendable images");
  assert.equal((await plugin.stickers({ ...templated.ctx, input: { action: "search", kind: "ordinary" } })).candidates.length, 0);
  assert.equal((await plugin.stickers({ ...templated.ctx, input: { action: "search", kind: "template" } })).candidates[0].id, templateId);
  const renderInput = { action: "render", searchId: templates.searchId, id: templateId, text: "白痴" };
  await assert.rejects(plugin.stickers({ ...templated.ctx, message: { chatId: "other" }, input: renderInput }), /当前聊天/);
  const rendered = await plugin.stickers({ ...templated.ctx, input: renderInput });
  assert(rendered.url.includes("e".repeat(64)));
  const renderedSegments = [{ type: "image", data: { file: rendered.url } }];
  assert.equal((await plugin.beforeSend({ ...templated.ctx, hook: { content: renderedSegments } })).content.length, 1);
  templated.records.set("settings:default", { value: { frequency: 0, cooldownSeconds: 0 } });
  assert.equal((await plugin.afterModel({ ...templated.ctx, hook: { replyId: "template-mixed", content: `文字![图](${rendered.url})` } })).content, "文字");
  await plugin.afterSend({ ...templated.ctx, hook: { result: { status: "sent", sentSegments: renderedSegments } } });
  assert(templated.state.get("lastSent"), "rendered stickers update cooldown");
  await plugin.save({ ...templated.ctx, input: { id: templateId, revision: templated.get("a").revision, enabled: false } });
  assert.equal((await plugin.beforeSend({ ...templated.ctx, hook: { content: renderedSegments } })).content.length, 0, "revocation also blocks previously rendered URLs");
  await assert.rejects(plugin.stickers({ ...templated.ctx, input: renderInput }), /不可用/);
  const variety = fixture();
  await plugin.importFiles({ ...variety.ctx, input: { refs: ["import", "chat"] } });
  await plugin.process({ ...variety.ctx, input: { ids: ["a".repeat(64), "b".repeat(64)] } });
  const firstChoice = await plugin.stickers({ ...variety.ctx, input: { action: "search", query: "钱包" } });
  const chosen = firstChoice.candidates[0];
  const varietySegments = [{ type: "image", data: { file: chosen.url } }];
  await plugin.afterSend({ ...variety.ctx, hook: { result: { status: "failed", sentSegments: varietySegments } } });
  assert.equal(variety.state.has("recentStickers"), false, "a failed send does not affect recent history");
  await plugin.afterSend({ ...variety.ctx, hook: { result: { status: "sent", sentSegments: varietySegments } } });
  const nextChoice = await plugin.stickers({ ...variety.ctx, input: { action: "search", query: "钱包" } });
  assert.notEqual(nextChoice.candidates[0].id, chosen.id, "among equally relevant pictures the recently sent one is gently deprioritized");
  const preset = fixture(), prepared = { schemaVersion: 1, analysis: { caption: "猫举起手", meaning: "主动打招呼", ocrText: "", tags: ["招呼"], usageExamples: ["刚见到朋友"], avoidContexts: ["对方正在认真求助"] } };
  prepared.textTemplate = template;
  const roleMedia = [{ profileId: "p", id: "hello", name: "嘻嘻正比：挥手", description: "旧版简短描述", tags: ["旧标签"], contentHash: "c".repeat(64), metadata: { "meme-library": prepared } }];
  preset.ctx.api.profileMedia = async input => input.action === "list" ? copy(roleMedia) : copy(preset.assets.get("qq"));
  await preset.syncProfiles();
  const presetKey = "c".repeat(64) + ":profile:p:hello", presetRow = () => copy(preset.records.get("items:" + presetKey));
  assert.equal(presetRow().value.meaning, "主动打招呼"); assert.equal(presetRow().value.indexStatus, "ready");
  assert.deepEqual(presetRow().value.textTemplate, template, "the role package supplies the editable template through generic media metadata");
  assert(!preset.calls.includes("recognize"), "package analysis is indexed directly without another model call");
  const cautionOnly = await plugin.stickers({ ...preset.ctx, input: { action: "search", query: "对方正在认真求助", mode: "text" } });
  assert.equal(cautionOnly.candidates.length, 0, "avoidance contexts do not recall the sticker");
  let editDuringCopy = true;
  const profileMediaApi = preset.ctx.api.profileMedia;
  preset.ctx.api.profileMedia = async input => {
    if (input.action === "copy" && editDuringCopy) {
      editDuringCopy = false;
      await plugin.save({ ...preset.ctx, input: { id: presetKey, revision: presetRow().revision, enabled: false } });
    }
    return profileMediaApi(input);
  };
  await preset.syncProfiles();
  assert.equal(presetRow().value.enabled, false, "an in-flight package sync cannot undo a user's disable action");
  // Continue the separate untouched-item update scenario.
  preset.ctx.api.profileMedia = profileMediaApi;
  preset.records.get("items:" + presetKey).value.userEdited = false;
  prepared.analysis.meaning = "友好应声或道别";
  await preset.syncProfiles();
  assert.equal(presetRow().value.meaning, "友好应声或道别", "meaning-only package updates propagate");
  await plugin.save({ ...preset.ctx, input: { id: presetKey, revision: presetRow().revision, meaning: "我的解释" } });
  prepared.analysis.meaning = "第三版解释"; await preset.syncProfiles();
  assert.equal(presetRow().value.meaning, "我的解释", "package updates retain locally edited analysis");
  await plugin.importFiles({ ...preset.ctx, input: { refs: ["import"] } });
  const ordinaryId = "a".repeat(64);
  await plugin.save({ ...preset.ctx, input: { id: ordinaryId, revision: preset.get("a").revision, roleProfileId: "p", profileIds: ["other"] } });
  assert.deepEqual(preset.get("a").value.profileIds, ["p"]);
  assert(plugin._test.isRoleSticker(preset.ctx, preset.get("a").value));
  assert(!plugin._test.visible({ ...preset.ctx, profile: { id: "other" } }, { ...preset.get("a").value, profileIds: [] }), "exclusive identity cannot be widened through ordinary scope");
  await plugin.save({ ...preset.ctx, input: { id: presetKey, revision: presetRow().revision, roleProfileId: "", profileIds: [] } });
  assert(!plugin._test.isRoleSticker(preset.ctx, presetRow().value), "an explicit ordinary setting overrides imported provenance");
  await assert.rejects(plugin.save({ ...preset.ctx, input: { id: ordinaryId, revision: preset.get("a").revision, roleProfileId: "missing" } }), /角色不存在/);

  const renamed = fixture(), firstId = "a".repeat(64), secondId = "b".repeat(64);
  await plugin.importFiles({ ...renamed.ctx, input: { refs: ["import", "chat"] } });
  let named = renamed.get("a");
  await plugin.save({ ...renamed.ctx, input: { id: firstId, revision: named.revision, name: "嘻嘻正比：开心" } });
  assert.equal(renamed.get("a").value.analysisStatus, "pending", "naming a new image must not skip recognition");
  assert.equal(renamed.get("a").value.manual, false);
  await plugin.process({ ...renamed.ctx, input: { ids: [firstId, secondId] } });
  named = renamed.get("a");
  await plugin.save({ ...renamed.ctx, input: { id: firstId, revision: named.revision, caption: "人工旧描述", meaning: "人工旧含义" } });
  const beforeCount = renamed.calls.filter(call => call === "recognize").length;
  const otherBefore = renamed.get("b");
  await plugin.update({ ...renamed.ctx, input: { ids: [firstId], reanalyze: true, requestKey: "selected" } });
  const requested = renamed.jobs.at(-1).input;
  assert.deepEqual(requested.ids, [firstId]); assert.equal(requested.reanalyze, true);
  await plugin.process({ ...renamed.ctx, input: requested });
  assert.equal(renamed.calls.filter(call => call === "recognize").length, beforeCount + 1);
  assert.equal(renamed.get("a").value.caption, "捂住钱包的猫");
  assert.equal(renamed.get("a").value.name, "嘻嘻正比：开心");
  assert.deepEqual(renamed.get("b"), otherBefore, "selected reanalysis does not touch other images");
  await plugin.process({ ...renamed.ctx, input: requested });
  assert.equal(renamed.calls.filter(call => call === "recognize").length, beforeCount + 1, "resuming the same job does not recognize successful rows twice");
  renamed.modelReady(false);
  const namedSearch = await plugin.stickers({ ...renamed.ctx, input: { action: "search", query: "嘻嘻正比", mode: "text" } });
  assert.equal(namedSearch.candidates[0].name, "嘻嘻正比：开心", "fixed names participate in search and reach the model");
  for (const ids of [[], Array(501).fill(firstId), [""]]) await assert.rejects(plugin.update({ ...renamed.ctx, input: { ids, reanalyze: true } }), /请选择/);
  // Old analysis fields remain readable, then collapse without duplication on edit.
  const old = renamed.records.get("items:" + firstId);
  Object.assign(old.value, { caption: "猫", literalDescription: "猫举手", meaning: "打招呼", tone: ["友好"], useCases: ["见面"], aliases: ["招手猫"] });
  const detail = await plugin.detail({ ...renamed.ctx, input: { id: firstId } });
  assert.equal(detail.caption, "猫；猫举手"); assert.equal(detail.meaning, "打招呼；友好"); assert(detail.tags.includes("招手猫")); assert(detail.usageExamples.includes("见面"));
  await plugin.save({ ...renamed.ctx, input: { id: firstId, revision: detail.revision, caption: detail.caption + "，微笑" } });
  assert.equal(renamed.get("a").value.caption, "猫；猫举手，微笑"); assert.equal(renamed.get("a").value.literalDescription, "");
  assert.equal(renamed.get("a").value.meaning, "打招呼；友好");

  const migrated = fixture(), provenance = { caption: "旧表情", tags: ["高兴"], displayedEmotion: ["开心"], inducedEffect: ["庆祝"],
    name: "嘻嘻正比：开心", safetyLabels: ["普通表情"], intensity: "medium", analysisModelId: "legacy-vision", analyzedAt: 1700000000000, textTemplate: template };
  const originalEngine = migrated.ctx.api.callTool; let exportedAnnotation;
  migrated.ctx.principal = { channelId: "bot" };
  migrated.ctx.api.jobs = async () => ({ id: "export", checkpoint: null });
  migrated.ctx.api.callTool = async request => {
    const input = request.arguments;
    if (input.action === "bundleInfo") return { structuredContent: { count: 1, preferences: [], sourceInstanceId: "legacy" } };
    if (input.action === "bundleItem") return { structuredContent: { legacyId: "legacy-sticker", mimeType: "image/png", data: "aGk=",
      annotation: { ...provenance, analysisStatus: "ready", scope: { enabled: false, chatMode: "include", chatIds: ["group"] } } } };
    if (input.action === "exportAdd") { exportedAnnotation = copy(input.item.annotation); return { structuredContent: {} }; }
    if (input.action === "exportFinish") return { structuredContent: { files: [] } };
    if (["bundlePut", "exportBegin"].includes(input.action)) return { structuredContent: {} };
    return originalEngine(request);
  };
  await plugin.importBundle({ ...migrated.ctx, input: { refs: ["import"] } });
  const migratedRow = [...migrated.records.values()].find(row => row.value.source?.legacyId === "legacy-sticker");
  for (const [key, value] of Object.entries(provenance)) assert.deepEqual(migratedRow.value[key], value);
  assert.equal(migratedRow.value.enabled, false); assert(!migrated.calls.includes("recognize"));
  await plugin.exportBundle({ ...migrated.ctx, input: {} });
  for (const [key, value] of Object.entries(provenance)) assert.deepEqual(exportedAnnotation[key], value);
  const f = fixture();
  await plugin.importFiles({ ...f.ctx, input: { refs: ["import"] } });
  assert.equal(f.jobs.length, 1); assert.equal(f.get("a").value.analysisStatus, "pending");
  await plugin.process({ ...f.ctx, input: { ids: ["a".repeat(64)] } });
  assert.equal(f.get("a").value.indexStatus, "ready");
  const promptContext = { ...f.ctx, hook: { requestId: "turn-123" } };
  const firstPrompt = await plugin.beforeModel(promptContext);
  assert.deepEqual(await plugin.beforeModel(promptContext), firstPrompt, "fallback keeps the same per-turn decision");
  await plugin.saveSettings({ ...f.ctx, input: { revision: 0, frequency: 0 } });
  const disabledPrompt = await plugin.beforeModel(promptContext);
  assert.equal(disabledPrompt.systemPromptAppend, firstPrompt.systemPromptAppend, "changing state preserves stable instructions");
  assert.match(disabledPrompt.contextItems[0].content, /图文混合中的表情按 0%/);
  await plugin.saveSettings({ ...f.ctx, input: { revision: f.records.get("settings:default").revision, frequency: 100, cooldownSeconds: 60 } });
  f.state.set("lastSent", Date.now());
  assert.match((await plugin.beforeModel(promptContext)).contextItems[0].content, /冷却至/);
  f.state.delete("lastSent");
  assert.match((await plugin.beforeModel(promptContext)).contextItems[0].content, /图文混合中的表情按 100%/);
  assert(f.calls.indexOf("recognize") < f.calls.indexOf("embed"), "recognition completes before indexing");
  let row = f.get("a");
  await plugin.save({ ...f.ctx, input: { id: row.key, revision: row.revision, tags: ["破产"] } });
  assert.equal(f.get("a").value.indexStatus, "pending"); assert.equal(f.jobs.length, 2);
  const recognized = f.calls.filter(x => x === "recognize").length;
  let indexedText;
  f.onEmbed(p => { if (!p.query) indexedText = p.text; });
  await plugin._test.processItem(f.ctx, row.key, {});
  assert(indexedText.includes("破产")); assert.equal(f.calls.filter(x => x === "recognize").length, recognized, "manual edits are not overwritten by recognition");
  await plugin.collect({ ...f.ctx, input: { messageId: "message" } }); assert.equal(f.get("b").value.analysisStatus, "pending");
  f.onGenerate(async () => {
    const current = f.get("b");
    await plugin.save({ ...f.ctx, input: { id: current.key, revision: current.revision, caption: "人工描述", meaning: "人工含义", tags: ["人工"] } });
  });
  await plugin._test.processItem(f.ctx, "b".repeat(64), {});
  assert.equal(f.get("b").value.caption, "人工描述"); assert.equal(f.get("b").value.indexStatus, "pending");
  f.onGenerate(null); await plugin._test.processItem(f.ctx, "b".repeat(64), {}); assert.equal(f.get("b").value.indexStatus, "ready");
  await plugin.sync(f.ctx); assert.equal(f.get("c").value.indexStatus, "ready", "QQ sync runs the same complete pipeline");
  assert.equal(f.calls.filter(x => x === "recognize").length, recognized + 2);
  const found = await plugin.stickers({ ...f.ctx, input: { action: "search", query: "没钱", limit: 4 } });
  assert(found.candidates.length); assert(found.attachments.length); assert.equal(found.retrieval, "semantic");
  await plugin.stickers({ ...f.ctx, input: { action: "no_match", searchId: found.searchId } });
  assert.equal((await f.ctx.api.journal({ action: "get", key: found.searchId })).record.value.status, "no_match");
  await assert.rejects(plugin.stickers({ ...f.ctx, message: { chatId: "other" }, input: { action: "no_match", searchId: found.searchId } }), /当前聊天/);
  const recognition = await plugin.history({ ...f.ctx, input: { id: "b".repeat(64) } });
  assert(recognition.records.some(row => row.value.status === "superseded"), "manual edit races retain the unapplied recognition output");
  assert.equal(plugin._test.visible({ ...f.ctx, message: { chatId: "other" } }, f.get("b").value), false, "chat collections do not leak to another chat");
  row = f.get("a"); await plugin.save({ ...f.ctx, input: { id: row.key, revision: row.revision, profileIds: ["other"] } });
  assert.equal(plugin._test.visible(f.ctx, f.get("a").value), false);
  row = f.get("c"); await plugin.remove({ ...f.ctx, input: { id: row.key, revision: row.revision } });
  const staleUrl = "openbot-asset://plugin-media/" + row.key + "/image";
  const guarded = await plugin.beforeSend({ ...f.ctx, hook: { content: [{ type: "image", data: { file: staleUrl } }, { type: "text", data: { text: "hello" } }] } });
  assert.equal(guarded.content.length, 1, "removed images are filtered even when a model reuses an old URL");
  await assert.rejects(plugin.save({ ...f.ctx, input: { id: "a".repeat(64), revision: 0, tags: [] } }), /刷新/);
  const profileMedia = [{ profileId: "p", id: "proud", name: "得意", description: "得意的蓝猫", tags: ["得意"], contentHash: "a".repeat(64), enabled: true }];
  f.ctx.api.profileMedia = async input => input.action === "list" ? copy(profileMedia) : copy(f.assets.get("import"));
  await f.syncProfiles();
  const profileKey = "a".repeat(64) + ":profile:p:proud";
  let profile = copy(f.records.get("items:" + profileKey));
  assert.equal(profile.value.indexStatus, "ready"); assert.deepEqual(profile.value.profileIds, ["p"]);
  assert.equal(plugin._test.visible({ ...f.ctx, profile: { id: "other" } }, profile.value), false);
  await plugin.save({ ...f.ctx, input: { id: profileKey, revision: profile.revision, caption: "我的修改" } });
  profileMedia[0].description = "新版描述"; await f.syncProfiles();
  assert.equal(f.records.get("items:" + profileKey).value.caption, "我的修改", "profile updates preserve manual changes");
  profile = copy(f.records.get("items:" + profileKey));
  await plugin.remove({ ...f.ctx, input: { id: profileKey, revision: profile.revision } });
  await f.syncProfiles(); assert.equal(f.records.get("items:" + profileKey).value.deleted, true, "profile updates do not resurrect deleted items");
  const preference = fixture();
  await plugin.importFiles({ ...preference.ctx, input: { refs: ["import"] } });
  await plugin.process({ ...preference.ctx, input: { ids: ["a".repeat(64)] } });
  preference.ctx.api.profileMedia = async input => input.action === "list"
    ? [{ profileId: "p", id: "own", name: "嘻嘻", description: "嘻嘻没钱", tags: ["嘻嘻"], contentHash: "c".repeat(64), enabled: true }]
    : copy(preference.assets.get("qq"));
  await preference.syncProfiles();
  const ownKey = "c".repeat(64) + ":profile:p:own", genericKey = "a".repeat(64);
  const generic = preference.get("a");
  await plugin.save({ ...preference.ctx, input: { id: genericKey, revision: generic.revision, profileIds: ["p"] } });
  const vectorIndex = preference.ctx.api.vectorIndex;
  let ownScore = 0.74;
  preference.ctx.api.vectorIndex = async input => input.action !== "search" ? vectorIndex(input) : {
    version: VERSION, missing: 0, matches: input.candidates.map(row => ({ ...row, score: row.id === ownKey ? ownScore : 0.78 })),
  };
  const preferred = await plugin.stickers({ ...preference.ctx, input: { action: "search", query: "求抱抱", limit: 4 } });
  assert.equal(preferred.candidates[0].id, ownKey, "relevant role stickers receive a modest ranking preference");
  assert.equal(preferred.candidates[0].roleSticker, true);
  assert.equal(preferred.candidates.find(item => item.id === genericKey).roleSticker, false, "role scope alone does not identify the character");
  assert.match(preferred.attachments[0].caption, /专属角色表情/);
  assert.match(preferred.instruction, /符合当前语境的专属角色表情时优先/);
  assert.match((await plugin.beforeModel(preference.ctx)).systemPromptAppend, /专属角色表情.*贴合语境时优先/);
  ownScore = 0.1;
  const unrelated = await plugin.stickers({ ...preference.ctx, input: { action: "search", query: "求抱抱", limit: 4 } });
  assert(!unrelated.candidates.some(item => item.id === ownKey), "priority does not admit irrelevant role images");
  const literal = await plugin.stickers({ ...preference.ctx, input: { action: "search", query: "没钱", mode: "text", limit: 4 } });
  assert.equal(literal.candidates[0].id, genericKey, "text search preserves exact picture-text ranking");
  await plugin.save({ ...preference.ctx, input: { id: genericKey, revision: preference.get("a").revision, ocrText: "你好，我吃一点" } });
  const containing = preference.records.get("items:" + ownKey);
  await plugin.save({ ...preference.ctx, input: { id: ownKey, revision: containing.revision, ocrText: "请等一下，你好我吃一点" } });
  const punctuation = await plugin.stickers({ ...preference.ctx, input: { action: "search", query: "你好， 我吃一点！", mode: "text" } });
  assert.deepEqual(Array.from(punctuation.candidates, item => item.id), [genericKey, ownKey], "complete normalized OCR outranks partial OCR");
  assert.equal(plugin._test.isRoleSticker({ profile: { id: "other" } }, { source: { type: "profile", profileId: "p" }, profileIds: ["other"] }), false);
  assert.equal(plugin._test.isRoleSticker(preference.ctx, { source: { type: "profile", legacyId: "profile:p:old" }, profileIds: ["p"] }), true);
  const paged = fixture(), profileRows = Array.from({ length: 205 }, (_, i) => ({ profileId: "p", id: `page-${i}`,
    name: `表情 ${i}`, description: "角色表情", tags: ["角色"], contentHash: "c".repeat(64), enabled: true }));
  let pageCalls = 0;
  paged.ctx.api.profileMedia = async input => {
    if (input.action !== "list") return copy(paged.assets.get("qq"));
    pageCalls++; assert.equal(input.limit, 5);
    const offset = Number(input.cursor || 0), next = offset + input.limit;
    return { items: copy(profileRows.slice(offset, next)), nextCursor: next < profileRows.length ? String(next) : null };
  };
  await paged.syncProfiles();
  assert.equal(pageCalls, 41); assert.equal([...paged.records.values()].filter(row => row.value.source?.type === "profile").length, 205,
    "all pages of role media are synchronized");
  const offline = fixture(); offline.modelReady(false);
  await plugin.importFiles({ ...offline.ctx, input: { refs: ["import"] } });
  const fallback = await plugin.process({ ...offline.ctx, input: { ids: ["a".repeat(64)] } });
  assert.equal(fallback.mode, "bm25"); assert.equal(fallback.failed, 0);
  assert.equal(offline.get("a").value.analysisStatus, "ready", "failed model downloads never block recognition");
  assert.equal(offline.get("a").value.indexStatus, "fallback"); assert.equal(offline.get("a").value.textIndex.version, "bm25-cjk-v3");
  const matched = await plugin.stickers({ ...offline.ctx, input: { action: "search", query: "钱包" } });
  assert.equal(matched.retrieval, "bm25"); assert.equal(matched.candidates.length, 1);
  const priorRecognition = offline.calls.filter(action => action === "recognize").length;
  offline.modelReady(true); await plugin.process({ ...offline.ctx, input: { ids: ["a".repeat(64)] } });
  assert.equal(offline.get("a").value.indexStatus, "ready");
  assert.equal(offline.calls.filter(action => action === "recognize").length, priorRecognition, "model recovery backfills vectors without overwriting descriptions");
  assert.equal((await plugin.stickers({ ...offline.ctx, input: { action: "search", query: "钱包" } })).retrieval, "semantic");
  const pending = offline.get("a");
  await plugin.save({ ...offline.ctx, input: { id: pending.key, revision: pending.revision, tags: ["等待重建"] } });
  await plugin.stop(offline.ctx);
  const scheduled = offline.jobs.length; await plugin.recover(offline.ctx);
  assert.equal(offline.jobs.length, scheduled, "stop suspends automatic recovery");
  await plugin.update({ ...offline.ctx, input: {} }); assert.equal(offline.state.get("recoveryPaused"), false);
  console.log("Meme plugin: import/chat/QQ pipeline, manual edit races, tag reindexing, joint retrieval, role/chat scopes and stale candidate filtering passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
