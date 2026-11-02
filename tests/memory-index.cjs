"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const host = path.resolve(process.env.OPENBOT_HOST_ROOT || path.join(__dirname, "../../openbot"));
const fromHost = require("node:module").createRequire(path.join(host, "package.json"));
const { createSharedModels } = fromHost("./electron/lib/features/retrieval/shared-models.cjs");
const { createVectorCollections } = fromHost("./electron/lib/features/retrieval/vector-collections.cjs");
const { createLocalEmbeddingIndex } = fromHost("./electron/lib/features/retrieval/local-embedding-index.cjs");
const { createPluginRetrieval } = fromHost("./electron/lib/plugins/plugin-retrieval.cjs");
const { open, close } = require("../plugins/memory/storage.cjs"), { createRetrieval, ids } = require("../plugins/memory/retrieval.cjs");
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-index-")), scope = { channelId: "bot", chatId: "onebot:private:u" };
  let models, vectors;
  try {
    models = createSharedModels({ root, getDefault: () => "fixture", providers: { fixture: { name: "fixture", dimension: 768, version: "fixture-768", modalities: ["text"], ready: () => true,
      create: () => createLocalEmbeddingIndex(root, { embed: async () => Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0) }) } } });
    vectors = createVectorCollections({ root, models });
    const api = createPluginRetrieval({ retrieval: { models, vectors } }), actor = { ...scope, pluginId: "memory" }, principal = { actor, requirePermission() {}, signal: new AbortController().signal };
    let calls = 0;
    const ctx = { config: {}, api: { embeddings: input => api.embeddings(principal, input), vectorIndex: input => { calls++; return api.vectorIndex(principal, input); } } }, storage = open(path.join(root, "plugin"));
    const note = { id: "long-note", revision: 900, content: "长笔记的后半部分也需要被检索。".repeat(60000) };
    let result, turns = 0;
    do { calls = 0; result = await createRetrieval(ctx, storage, scope).index("notes", [note]); assert(calls <= 32); if (++turns > 10) throw Error("Index checkpoint did not advance"); } while (result.pending);
    assert(turns > 1, "large notes index incrementally across bounded invocations");
    const first = await api.vectorIndex(principal, { action: "status", collection: "notes" }); assert.equal(first.indexed, ids(note).length);
    const edited = { ...note, revision: 2, content: "恢复旧版本后的新正文" };
    await createRetrieval(ctx, storage, scope).index("notes", [edited]);
    assert.equal((await api.vectorIndex(principal, { action: "status", collection: "notes" })).indexed, ids(edited).length, "rollback or hash ordering does not leave old passages");
    const search = await createRetrieval(ctx, storage, scope).search("notes", "原来那段经历", [edited]); assert.equal(search.mode, "hybrid");
    await createRetrieval(ctx, storage, scope).index("notes", []);
    assert.equal((await api.vectorIndex(principal, { action: "status", collection: "notes" })).indexed, 0, "forget physically removes shared index passages");
    assert.equal(storage.db.prepare("SELECT name FROM sqlite_master WHERE name='channel_memory_vectors'").get(), undefined, "plugin does not maintain a duplicate vector store");
    console.log("Memory index: large-note checkpoints, bounded writes, immutable passages, revision rollback, semantic search and physical deletion passed");
  } finally { close(); await vectors?.pause(); await models?.pause(); if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("openbot-memory-index-")) fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
