"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const host = require("node:module").createRequire(path.join(path.resolve(process.env.OPENBOT_HOST_ROOT || "../openbot"), "package.json"));
const { createSharedModels } = host("./electron/lib/features/retrieval/shared-models.cjs"), { createVectorCollections } = host("./electron/lib/features/retrieval/vector-collections.cjs");
const { createLocalEmbeddingIndex } = host("./electron/lib/features/retrieval/local-embedding-index.cjs"), { createPluginRetrieval } = host("./electron/lib/plugins/plugin-retrieval.cjs");
const { createPluginSources } = host("./electron/lib/plugins/plugin-sources.cjs"), { createChannelStorageRepository } = host("./electron/lib/context/channel-storage-repository.cjs");
const { createContextPaths } = host("./electron/lib/context/context-paths.cjs"), { applyPluginPrompt } = host("./electron/lib/plugins/plugin-prompt.cjs");
const { open, close } = require("../plugins/memory/storage.cjs"), sources = require("../plugins/memory/source-retrieval.cjs"), plus = require("../plugins/memory/unified-runtime.cjs");
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-source-recall-")), scope = { channelId: "bot", chatId: "onebot:group:one" };
  const signal = new AbortController().signal; let models, vectors, repo;
  try {
    const embeddings = [], assets = new Map(), excluded = new Set(); let failBlue = true, imports = 0;
    models = createSharedModels({ root, getDefault: () => "fixture", providers: { fixture: { name: "joint", dimension: 768, version: "joint-v1", modalities: ["text", "image", "joint"], ready: () => true,
      create: () => createLocalEmbeddingIndex(root, { embed: async input => {
        embeddings.push({ query: input.query, image: input.image?.toString(), text: input.text });
        const value = input.image?.toString() || input.text, axis = /blue|蓝色/.test(value) ? 2 : /red|红色/.test(value) ? 1 : 0;
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
          const ref = `${source.id}:${source.version}:${input.index}`; assets.set(ref, Buffer.from(source.id)); return { ref };
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
    const result = await plus.beforeModel(ctx);
    assert(result.contextItems.some(item => item.source?.id === "red")); assert(result.contextItems.some(item => item.source?.id === "blue"));
    assert(result.contextItems.some(item => item.source?.id === "words" && item.placement.afterMessageId === "q2"));
    const red = result.contextItems.find(item => item.source?.id === "red");
    assert.deepEqual(red.placement.related.map(item => item.messageId), ["q1", "q3"], "duplicate hits preserve each utterance association");
    assert.deepEqual(red.placement.related[0].imageIndexes, [0]);
    assert.equal(result.contextItems.find(item => item.source?.id === "blue").placement.related[0].imageIndexes[0], 1);
    assert(embeddings.some(value => value.query && value.image === "blue"), "the second image is queried too");
    const payload = structuredClone(ctx.hook);
    applyPluginPrompt(payload, result, { id: "memory", permissions: ["prompt:system"] }, { scope, resolveResource: item => ({ readable: true, current: true,
      value: item.resource ? { content: original.get(scope, item.resource.id).content, sourceImage: item.resource.id } : undefined }) });
    const wire = payload.messages.find(item => item.contextRecordId === "turn").content;
    assert(wire.indexOf("去年红色海报的制作讨论") < wire.indexOf('"id":"q2"'));
    assert(wire.indexOf("会议地点在三楼") > wire.indexOf('"id":"q2"'));
    const started = Date.now(); let timed = 0;
    await plus.beforeModel({ ...ctx, deadlineAt: started + 1600, api: { ...ctx.api,
      vectorIndex: input => { timed++; assert(input.timeoutMs <= 200); return new Promise((_resolve, reject) => setTimeout(() => reject(Error("query timeout")), input.timeoutMs)); },
    } });
    assert(timed > 0 && Date.now() - started < 900, "slow vector queries return before the foreground hook deadline");
    excluded.add("red");
    assert.equal((await sources.search(ctx, scope, "", { imageOnly: true, queryImage: { messageId: "q1", index: 0 } })).records.length, 0, "forgotten source is excluded immediately");
    record("blue", "", [], 100); await sources.index(ctx, storage, scope);
    assert.equal((await sources.search(ctx, scope, "", { imageOnly: true, queryImage: { messageId: "q1", index: 1 } })).records.length, 0, "removed images leave no usable stale hit");
    console.log("Raw source recall: real SQLite/feed/shared vectors, ordinary images without memories, image-only/text/mixed batches, second image, deduped associations, insertion, retry, forget and media removal passed.");
  } finally { close(); repo?.close(); await vectors?.pause(); await models?.pause(); assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith("openbot-source-recall-")); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
