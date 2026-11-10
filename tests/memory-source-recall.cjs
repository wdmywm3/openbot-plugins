"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const host = require("node:module").createRequire(path.join(path.resolve(process.env.OPENBOT_HOST_ROOT || "../openbot"), "package.json"));
const { createSharedModels } = host("./electron/lib/features/retrieval/shared-models.cjs"), { createVectorCollections } = host("./electron/lib/features/retrieval/vector-collections.cjs");
const { createPluginRetrieval } = host("./electron/lib/plugins/plugin-retrieval.cjs");
const { createPluginSources } = host("./electron/lib/plugins/plugin-sources.cjs"), { createChannelStorageRepository } = host("./electron/lib/context/channel-storage-repository.cjs");
const { createContextPaths } = host("./electron/lib/context/context-paths.cjs"), { applyPluginPrompt } = host("./electron/lib/plugins/plugin-prompt.cjs");
const { open, close } = require("../plugins/memory/storage.cjs"), sources = require("../plugins/memory/source-retrieval.cjs"), plus = require("../plugins/memory/unified-runtime.cjs");
const { get } = require("../plugins/memory/unified-state.cjs");
const unified = require("../plugins/memory/unified-retrieval.cjs");
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-source-recall-")), scope = { channelId: "bot", chatId: "onebot:group:one" };
  const signal = new AbortController().signal; let models, vectors, repo;
  try {
    const embeddings = [], assets = new Map(), excluded = new Set(); let failBlue = true, imports = 0;
    models = createSharedModels({ root, getDefault: () => "fixture", providers: { fixture: { name: "joint", dimension: 768, version: "joint-v1", modalities: ["text", "image", "joint"], ready: () => true,
      create: () => ({ close() {}, async vector(input, { query }) {
        embeddings.push({ query, image: input.image?.toString(), text: input.text });
        const value = input.image?.toString() || input.text, axis = /blue|蓝色/.test(value) ? 2 : /red|红色/.test(value) ? 1 : 0;
        if (input.image && value.startsWith("oversized")) throw Object.assign(Error("Input image exceeds pixel limit"), { code: "EMBEDDING_IMAGE_PIXEL_LIMIT" });
        if (input.image && value === "damaged") throw Object.assign(Error("Invalid image"), { code: "EMBEDDING_IMAGE_DECODE" });
        if (/会议地点的补充说明/.test(value)) return Array.from({ length: 768 }, (_, index) => index === 0 ? 0.8 : index === 3 ? 0.6 : 0);
        return Array.from({ length: 768 }, (_, index) => Number(index === axis)); } }) } } });
    vectors = createVectorCollections({ root, models });
    repo = createChannelStorageRepository({ fs, paths: createContextPaths({ root }) });
    const original = repo.sourceRepository;
    const sourceApi = createPluginSources({ repository: original, excludedFromMemory: (_scope, id) => excluded.has(id) });
    const record = (id, content, media = [], createdAt = 100) => original.record(scope, { id, content, direction: "in", sender: { id: "u", name: "甲" }, createdAt, media });
    record("red", "去年红色海报的制作讨论", [{ type: "image", name: "red.png" }]);
    record("blue", "", [{ type: "image", name: "blue.png" }]);
    record("words", "会议地点在三楼", [], 110);
    const principal = { actor: { ...scope, pluginId: "memory" }, signal, requirePermission() {} };
    const retrieval = createPluginRetrieval({ retrieval: { models, vectors }, assets: {
      info(_actor, ref) { if (!assets.has(ref)) throw Error("missing"); return {}; },
      read(_actor, ref) { if (!assets.has(ref)) throw Error("missing"); return { mimeType: "image/png", data: assets.get(ref) }; },
    } });
    const dataRoot = path.join(root, "plugin"), storage = open(dataRoot);
    const ctx = { dataRoot, config: {}, signal, plugin: { namespace: "bot" }, principal: { ...scope, senderId: "u" },
      message: { id: "q1", chatId: scope.chatId }, hook: {}, api: {
        sources: async input => sourceApi(scope, input),
        memory: async input => repo.unifiedMemoryRepository.memory({ ...scope, id: "plugin:memory", permissions: ["memory:read"] }, input),
        embeddings: input => retrieval.embeddings(principal, input),
        vectorIndex: input => retrieval.vectorIndex({ ...principal, readAttachment: async input => ({ data: Buffer.from(input.index === 1 ? "blue" : "red").toString("base64") }) }, input),
        assets: async input => {
          if (input.action !== "fromMessage") return { ref: input.ref };
          imports++; if (input.messageId === "blue" && failBlue) throw Error("transient download");
          const source = sourceApi(scope, { action: "read", id: input.messageId, version: input.sourceVersion }).item; assert(source && !source.deleted);
          const ref = `${source.id}:${source.version}:${input.index}`;
          assets.set(ref, Buffer.from(source.id === "mixed" ? (input.index === 0 ? "oversized-mixed" : "blue") : source.id));
          return { ref };
        },
      } };
    const first = await sources.index(ctx, storage, scope); assert.equal(first.pending, false);
    assert(embeddings.some(value => value.image === "red" && !value.query), "an ordinary user image is embedded without creating a memory");
    assert.equal(repo.unifiedMemoryRepository.memory({ ...scope, id: "test", permissions: ["memory:read"] }, { action: "search", query: "" }).items.length, 0);
    assert(storage.db.prepare("SELECT retry_at FROM source_embedding_receipts WHERE id='blue'").get().retry_at > 0);
    failBlue = false; storage.db.prepare("UPDATE source_embedding_receipts SET retry_at=1 WHERE id='blue'").run(); await sources.index(ctx, storage, scope);
    const previousImports = imports; await sources.index(ctx, storage, scope); assert.equal(imports, previousImports, "unchanged originals are reused");
    const messages = [
      { id: "q1", content: "这张红色海报以前讨论过吗", media: [{ type: "image" }, { type: "image" }] },
      { id: "q2", content: "会议地点在哪", media: [] },
      { id: "q3", content: "", media: [{ type: "image" }] },
    ].map(item => ({ ...item, ...scope, direction: "in", createdAt: 1000, sender: { id: "u" } }));
    const delta = `<qq_conversation_delta trust="untrusted">\n${messages.map(item => JSON.stringify({ id: item.id, role: "user", content: item.content })).join("\n")}\n</qq_conversation_delta>`;
    ctx.message = messages[0]; ctx.hook = { requestId: "turn", inputMessages: messages, messages: [{ role: "user", contextRecordId: "turn", content: delta }] };
    const initialQueries = embeddings.filter(value => value.query).length;
    assert.deepEqual((await plus.beforeModel(ctx)).contextItems.filter(item => !item.remove), [], "an empty memory library never falls back to raw group history");
    assert.equal(embeddings.filter(value => value.query).length, initialQueries, "empty-memory turns do not start text or bystander-image inference");
    const actor = { ...scope, id: "fixture", permissions: ["memory:read", "memory:write", "memory:manage"] };
    const saved = repo.unifiedMemoryRepository.memory(actor, { action: "create", requestKey: "formal", record: { content: "会议地点在哪：正式记录是二楼", status: "active" } });
    for (let i = 0; i < 6; i++) repo.unifiedMemoryRepository.memory(actor, { action: "create", requestKey: `extra-${i}`, record: { content: `会议地点的补充说明 ${i}`, status: "active" } });
    await unified.index(ctx, storage, scope);
    ctx.message = messages[1]; ctx.principal = { ...ctx.principal, primaryMessageId: "q2", replyTargetMessageIds: ["q2"] };
    const calls = [];
    const result = await plus.beforeModel({ ...ctx, api: { ...ctx.api, vectorIndex: input => { calls.push(input); return ctx.api.vectorIndex(input); } } });
    const memoryItems = result.contextItems.filter(item => item.memory);
    assert(memoryItems.some(item => item.memory.id === saved.id));
    assert.equal(memoryItems.length, 4, "automatic recall injects only a small top-k from saved memories");
    assert(memoryItems.every(item => !item.source && item.placement.afterMessageId === "q2"));
    assert(!result.contextItems.some(item => item.source));
    assert.equal(calls.length, 1, "only the current reply target starts a vector query");
    assert(calls.every(call => call.collection === unified.COLLECTION && !call.query?.messageImage), "bystander images and raw chat indices are outside automatic recall");
    const historical = await plus.recall({ ...ctx, input: { searchIn: "chat_history", query: "红色海报" } });
    assert(historical.chatHistory.some(item => item.id === "red"));
    assert.equal(historical.items, undefined, "historical messages are not represented as confirmed memories");
    const imageHistory = await plus.recall({ ...ctx, input: { searchIn: "chat_history", imageMessageId: "q1", imageIndex: 1 } });
    assert(imageHistory.chatHistory.some(item => item.id === "blue"), "explicit tools still search the requested second image");
    assert(embeddings.some(value => value.query && value.image === "blue"));
    await assert.rejects(plus.recall({ ...ctx, input: { searchIn: "chat_history" } }), /检索词/);
    await assert.rejects(plus.recall({ ...ctx, input: { searchIn: "unknown", query: "会议" } }), /请选择记忆库、聊天记录/);
    const payload = structuredClone(ctx.hook);
    applyPluginPrompt(payload, result, { id: "memory", permissions: ["prompt:system"] }, { scope, resolveResource: item => ({ readable: true, current: true,
      value: item.resource ? repo.unifiedMemoryRepository.memory(actor, { action: "read", id: item.resource.id, revision: item.resource.revision }).item : undefined }) });
    const wire = payload.messages.find(item => item.contextRecordId === "turn").content;
    assert(wire.indexOf("正式记录是二楼") > wire.indexOf('"id":"q2"'));
    assert(wire.indexOf("正式记录是二楼") < wire.indexOf('"id":"q3"'));
    assert(!wire.includes("会议地点在三楼"), "raw historical messages are never injected by automatic memory recall");
    const started = Date.now(); let timed = 0;
    await plus.beforeModel({ ...ctx, deadlineAt: started + 300, api: { ...ctx.api,
      vectorIndex: input => { timed++; assert(input.timeoutMs <= 200); return new Promise((_resolve, reject) => setTimeout(() => reject(Error("query timeout")), input.timeoutMs)); },
    } });
    assert(timed > 0 && Date.now() - started < 900, "slow vector queries return before the foreground hook deadline");
    excluded.add("red");
    assert.equal((await sources.search(ctx, scope, "", { imageOnly: true, queryImage: { messageId: "q1", index: 0 } })).records.length, 0, "forgotten source is excluded immediately");
    record("blue", "", [], 100); await sources.index(ctx, storage, scope);
    assert.equal((await sources.search(ctx, scope, "", { imageOnly: true, queryImage: { messageId: "q1", index: 1 } })).records.length, 0, "removed images leave no usable stale hit");
    const recallSkipped = input => plus.recall({ ...ctx, input: { searchIn: "skipped_images", ...input } });
    const receiptFor = id => storage.db.prepare("SELECT ids_json,retry_at FROM source_embedding_receipts WHERE id=?").get(id);
    record("oversized-untagged", "开关关闭时的长截图", [{ type: "image", name: "long.jpg" }], 180);
    await sources.index(ctx, storage, scope);
    assert.deepEqual(JSON.parse(receiptFor("oversized-untagged").ids_json), ["oversized-untagged:text"]);
    assert.equal(receiptFor("oversized-untagged").retry_at, 0);
    assert.equal((await recallSkipped({})).count, 0, "isolation is active while marking is off");

    ctx.config.skipOversizedSourceImages = true;
    record("mixed", "蓝色海报讨论", [{ type: "image", name: "ＰＡＮＯＲＡＭＡ.JPG" }, { type: "image", name: "blue.jpg" }], 210);
    record("damaged", "", [{ type: "image", name: "damaged.jpg" }], 211);
    record("later", "同页稍后的可检索消息", [], 212);
    const cursor = get(storage, sources.cursorKey(scope)).after;
    await sources.index(ctx, storage, scope);
    assert(get(storage, sources.cursorKey(scope)).after > cursor, "a page with deterministic image failures advances the cursor");
    assert.deepEqual(JSON.parse(receiptFor("mixed").ids_json), ["mixed:text", "mixed:image:1"]);
    assert.deepEqual(JSON.parse(receiptFor("later").ids_json), ["later:text"]);
    assert.deepEqual(JSON.parse(receiptFor("damaged").ids_json), []);
    assert.equal(receiptFor("damaged").retry_at, 0, "deterministic decode failures are not retried");
    const beforeLookup = embeddings.length;
    assert.equal((await recallSkipped({})).count, 2, "enabling marking makes known oversized originals findable");
    const { skippedImages: [mark] } = await recallSkipped({ query: "panorama.jpg" });
    assert.equal(mark.messageId, "mixed"); assert.equal(mark.imageIndex, 0);
    assert.equal(mark.version, original.get(scope, "mixed").version);
    assert.equal((await recallSkipped({ query: "蓝色海报" })).count, 1);
    assert.equal((await recallSkipped({ imageMessageId: "mixed", imageIndex: 1 })).count, 0);
    assert.equal(embeddings.length, beforeLookup, "looking up a mark does not load or embed the oversized original");
    await sources.index(ctx, storage, scope);
    assert.equal(embeddings.length, beforeLookup, "an unchanged failed attachment is not re-embedded");
    ctx.config.skipOversizedSourceImages = false;
    assert.equal((await recallSkipped({ imageMessageId: "mixed" })).count, 1, "a saved mark survives turning the setting off");
    excluded.add("mixed");
    assert.equal((await recallSkipped({ imageMessageId: "mixed" })).count, 0, "a mark cannot expose excluded source material");
    excluded.delete("mixed");
    record("mixed", "消息已编辑", [], 210);
    assert.equal((await recallSkipped({ imageMessageId: "mixed" })).count, 0, "a mark is bound to the original message version");

    const beforeFailure = get(storage, sources.cursorKey(scope)).after;
    const failedService = { ...ctx, api: { ...ctx.api, vectorIndex: async () => { throw Error("vector service unavailable"); } } };
    await assert.rejects(sources.index(failedService, storage, scope), /vector service unavailable/);
    assert.equal(get(storage, sources.cursorKey(scope)).after, beforeFailure, "infrastructure failures remain retryable");
    await sources.index(ctx, storage, scope);
    assert.equal(storage.db.prepare("SELECT 1 FROM source_image_failures WHERE source_id='mixed'").get(), undefined);
    console.log("Recall boundary: focused automatic recall, explicit text/image history, oversized-image marks, failure isolation, retry and source revocation passed.");
  } finally { close(); repo?.close(); await vectors?.pause(); await models?.pause(); assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith("openbot-source-recall-")); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
