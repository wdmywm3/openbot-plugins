"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../plugins/meme-library/index.js"), "utf8");
const moduleObject = { exports: {} }; vm.runInNewContext(source, { module: moduleObject, console }, { timeout: 1000 });
const plugin = moduleObject.exports;
const copy = v => v === undefined ? v : JSON.parse(JSON.stringify(v));
const VERSION = "embeddinggemma-2-daa72c512439-q8-768-joint-v1";
const vector = Array(768).fill(0); vector[0] = 1;
function fixture() {
  const records = new Map(), assets = new Map(), jobs = [], state = new Map(), calls = [], events = new Map(), indices = new Map();
  let serial = 0, checkpoint = null, beforeGenerate, beforeEmbed, modelReady = true;
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
        if (input.action === "query") return { records: [...records.entries()].filter(([key]) => key.startsWith(input.collection + ":")).map(([, value]) => copy(value)), nextCursor: null };
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
        if (input.action === "current") return { checkpoint };
        if (input.action === "checkpoint") { checkpoint = input.checkpoint; return {}; }
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
      async listContexts() { return { profiles: [], chats: [] }; }, async listModels() { return []; },
    } };
  const asset = (ref, id, shared = true) => assets.set(ref, { ref, sha256: id.repeat(64), mimeType: "image/png", bytes: 2, revision: "1", shared, chatId: shared ? "" : "group", chats: [] });
  asset("import", "a"); asset("chat", "b", false); asset("qq", "c");
  return { ctx, records, assets, calls, jobs, state, get: id => copy(records.get("items:" + id.repeat(64))),
    onGenerate(fn) { beforeGenerate = fn; }, onEmbed(fn) { beforeEmbed = fn; }, modelReady(value) { modelReady = value; } };
}
async function main() {
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
  assert.match(disabledPrompt.contextItems[0].content, /关闭/);
  await plugin.saveSettings({ ...f.ctx, input: { revision: f.records.get("settings:default").revision, frequency: 100, cooldownSeconds: 60 } });
  f.state.set("lastSent", Date.now());
  assert.match((await plugin.beforeModel(promptContext)).contextItems[0].content, /冷却至/);
  f.state.delete("lastSent");
  assert.match((await plugin.beforeModel(promptContext)).contextItems[0].content, /主动使用倾向 100%/);
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
  await plugin.syncProfiles(f.ctx);
  const profileKey = "a".repeat(64) + ":profile:p:proud";
  let profile = copy(f.records.get("items:" + profileKey));
  assert.equal(profile.value.indexStatus, "ready"); assert.deepEqual(profile.value.profileIds, ["p"]);
  assert.equal(plugin._test.visible({ ...f.ctx, profile: { id: "other" } }, profile.value), false);
  await plugin.save({ ...f.ctx, input: { id: profileKey, revision: profile.revision, caption: "我的修改" } });
  profileMedia[0].description = "新版描述"; await plugin.syncProfiles(f.ctx);
  assert.equal(f.records.get("items:" + profileKey).value.caption, "我的修改", "profile updates preserve manual changes");
  profile = copy(f.records.get("items:" + profileKey));
  await plugin.remove({ ...f.ctx, input: { id: profileKey, revision: profile.revision } });
  await plugin.syncProfiles(f.ctx); assert.equal(f.records.get("items:" + profileKey).value.deleted, true, "profile updates do not resurrect deleted items");
  const offline = fixture(); offline.modelReady(false);
  await plugin.importFiles({ ...offline.ctx, input: { refs: ["import"] } });
  const fallback = await plugin.process({ ...offline.ctx, input: { ids: ["a".repeat(64)] } });
  assert.equal(fallback.mode, "bm25"); assert.equal(fallback.failed, 0);
  assert.equal(offline.get("a").value.analysisStatus, "ready", "failed model downloads never block recognition");
  assert.equal(offline.get("a").value.indexStatus, "fallback"); assert.equal(offline.get("a").value.textIndex.version, "bm25-cjk-v1");
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
