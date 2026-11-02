"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const host = require("node:module").createRequire(path.join(path.resolve(process.env.OPENBOT_HOST_ROOT || "../openbot"), "package.json"));
const { createSharedModels } = host("./electron/lib/features/retrieval/shared-models.cjs"), { createVectorCollections } = host("./electron/lib/features/retrieval/vector-collections.cjs");
const { createLocalEmbeddingIndex } = host("./electron/lib/features/retrieval/local-embedding-index.cjs"), { createPluginRetrieval } = host("./electron/lib/plugins/plugin-retrieval.cjs");
const { createUnifiedMemoryRepository } = host("./electron/lib/context/unified-memory-repository.cjs");
const { DatabaseSync } = require("node:sqlite"), plus = require("../plugins/memory/unified-runtime.cjs");
const { open, close } = require("../plugins/memory/storage.cjs"), { createRetrieval } = require("../plugins/memory/retrieval.cjs");
const unified = require("../plugins/memory/unified-retrieval.cjs");
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-plus-multimodal-")), db = new DatabaseSync(path.join(root, "host.sqlite"));
  const scope = { channelId: "bot", chatId: "onebot:group:one" }, principal = { actor: { ...scope, pluginId: "memory" }, requirePermission() {}, signal: new AbortController().signal };
  let models, vectors, grant = true, missing = true, imageQueries = 0, imported = 0;
  try {
    models = createSharedModels({ root, getDefault: () => "fixture", providers: { fixture: { name: "joint", dimension: 768, version: "joint-v1", modalities: ["text", "image", "joint"], ready: () => true,
      create: () => createLocalEmbeddingIndex(root, { embed: async input => {
        if (input.query && input.image) imageQueries++;
        return Array.from({ length: 768 }, (_, i) => Number(i === (input.image ? 1 : 0))); } }) } } });
    vectors = createVectorCollections({ root, models });
    const media = { info() { if (!grant) throw Error("revoked"); }, read() { this.info(); return { mimeType: "image/png", data: Buffer.from("fixture-image") }; } };
    const api = createPluginRetrieval({ retrieval: { models, vectors }, assets: media }), repo = createUnifiedMemoryRepository(db);
    const actor = { ...scope, id: "user:owner", explicitForget: true, permissions: ["memory:read", "memory:write", "memory:manage", "memory:forget"] };
    const receipt = repo.memory(actor, { action: "create", requestKey: "picture", record: { content: "旅行时拍的照片", status: "active" } });
    const record = { ...repo.memory(actor, { action: "read", id: receipt.id }).item, sources: [{ id: "source", version: "v1", chatId: scope.chatId }] };
    const dataRoot = path.join(root, "plugin"), storage = open(dataRoot);
    const ctx = { dataRoot, config: {}, plugin: { namespace: "bot" }, principal: { ...scope, senderId: "owner" }, signal: principal.signal,
      message: { id: "query", chatId: scope.chatId, content: "", media: [{ type: "image" }] }, hook: { requestId: "turn", messages: [], inputMessages: [] },
      api: {
        memory: async input => repo.memory(actor, input), embeddings: input => api.embeddings(principal, input),
        vectorIndex: input => api.vectorIndex({ ...principal, readAttachment: async () => ({ data: Buffer.from("fixture-image").toString("base64") }) }, input),
        sources: async () => ({ item: grant ? { id: "source", version: "v1", attachments: [{ type: "image", index: 0 }] } : null }),
        assets: async input => { if (input.action === "fromMessage") { imported++; if (missing) throw Error("temporary download error"); return { ref: "image-ref" }; } media.info(); return { ref: input.ref }; },
      } };
    await createRetrieval(ctx, storage, scope).index(unified.COLLECTION, [record]);
    assert(storage.db.prepare("SELECT 1 FROM embedding_media_retry").get(), "transient image failure receives an independent retry checkpoint");
    assert.equal((await unified.search(ctx, storage, scope, "旅行")).records.length, 1, "text stays searchable while image is unavailable");
    missing = false; storage.db.prepare("UPDATE embedding_receipts SET complete=0,cursor=0").run();
    await createRetrieval(ctx, storage, scope).index(unified.COLLECTION, [record]);
    assert.equal(storage.db.prepare("SELECT 1 FROM embedding_media_retry").get(), undefined);
    const prior = imported; await createRetrieval(ctx, storage, scope).index(unified.COLLECTION, [record]); assert.equal(imported, prior, "unchanged sources do not download or index again");
    const recalled = await plus.recall({ ...ctx, input: { imageMessageId: "query" } });
    assert.equal(recalled.attachments.length, 1); assert(imageQueries > 0, "read-only image query reaches the shared multimodal model");
    const first = await plus.beforeModel(ctx), second = await plus.beforeModel(ctx);
    assert.equal(first.contextItems.filter(item => item.memory).length, 1); assert.deepEqual(second.contextItems, first.contextItems);
    grant = false;
    const revoked = await plus.recall({ ...ctx, input: { imageMessageId: "query" } });
    assert.equal((revoked.attachments || []).length, 0); assert.equal(revoked.items.length, 0, "revoked image vector cannot identify an otherwise text-only memory from an image query");
    await unified.remove(ctx, storage, scope, receipt.id); assert.equal(storage.db.prepare("SELECT 1 FROM embedding_media").get(), undefined);
    console.log("Memory multimodal: transient image retry, shared joint indexing, image-only explicit/automatic recall, stable references, source revocation and deletion passed (deterministic provider; real SQLite and public retrieval API)");
  } finally { close(); db.close(); await models?.pause(); await vectors?.pause(); assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith("openbot-plus-multimodal-")); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
