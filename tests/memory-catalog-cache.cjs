"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const repo = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs")).createUnifiedMemoryRepository(new DatabaseSync(":memory:"));
const cache = require("../plugins/memory/unified-catalog-cache.cjs"), retrieval = require("../plugins/memory/unified-retrieval.cjs");
const { open, close } = require("../plugins/memory/storage.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-catalog-"));
const scope = { channelId: "bot", chatId: "onebot:group:test" }, actor = { ...scope, id: "plugin:memory", permissions: ["read", "write", "manage", "forget"].map(key => `memory:${key}`), canReadChat: () => true };
let searches = 0, revoked = false;
const ctx = { principal: { ...scope, source: "channel", role: "member", senderId: "a" }, config: {}, signal: new AbortController().signal,
  api: { memory: async input => { if (input.action === "search") searches++;
    if (input.action === "read" && revoked) throw Object.assign(Error("已撤销访问"), { code: "MEMORY_NOT_FOUND" });
    return repo.memory(actor, input); } } };
(async () => {
  try {
    const storage = open(root), first = repo.memory(actor, { action: "create", requestKey: "first", record: { content: "供水阀门 HX-73", status: "active" } });
    const initial = await cache.candidates(ctx, storage, scope); assert.equal(initial.length, 1); const initialSearches = searches;
    assert.deepEqual(await cache.candidates(ctx, storage, scope), initial); assert.equal(searches, initialSearches, "unchanged turns reuse the catalog rather than page all records again");
    await Promise.all([cache.candidates(ctx, storage, scope), cache.candidates(ctx, storage, scope)]); assert.equal(searches, initialSearches);
    repo.memory(actor, { action: "create", requestKey: "new", record: { content: "新的 HX-74", status: "active" } });
    const updated = await cache.candidates(ctx, storage, scope); assert.equal(updated.length, 2); assert(searches > initialSearches);
    const beforeIdentity = searches;
    await cache.candidates({ ...ctx, principal: { ...ctx.principal, senderId: "b" } }, storage, scope); assert(searches > beforeIdentity, "different principals never share an entry");
    revoked = true;
    const result = await retrieval.search(ctx, storage, scope, "HX-73", 4, { catalog: updated }); assert.deepEqual(result.records, [], "cached candidates cannot bypass a current read denial");
    revoked = false;
    repo.memory({ ...actor, explicitForget: true }, { action: "forget", id: first.id, expectedRevision: first.revision, reason: "遗忘这条", requestKey: "forget" });
    const remaining = await cache.candidates(ctx, storage, scope); assert.equal(remaining.length, 1); assert(!remaining.some(item => item.id === first.id));
    function coldFixture(name) {
      let started, release, reads = 0;
      const begun = new Promise(resolve => { started = resolve; });
      const selected = [{ id: `cold-${name}`, revision: 1, preview: "共享候选" }];
      const make = signal => ({ ...ctx, signal, api: { memory: async input => {
        if (input.action === "changes") return { upper: 0 };
        if (++reads === 1) {
          started();
          await new Promise((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            release = () => { signal.removeEventListener("abort", abort); resolve(); };
          });
        }
        return { items: selected, nextOffset: null };
      } } });
      return { make, begun, release: () => release(), reads: () => reads, selected,
        scope: { ...scope, chatId: `onebot:group:cold-${name}` } };
    }
    const ownerCancel = coldFixture("owner-cancel"), owner = new AbortController(), follower = new AbortController();
    const original = cache.candidates(ownerCancel.make(owner.signal), storage, ownerCancel.scope);
    const canceledOriginal = assert.rejects(original, /owner-canceled/); await ownerCancel.begun;
    const continued = cache.candidates(ownerCancel.make(follower.signal), storage, ownerCancel.scope);
    await new Promise(resolve => setImmediate(resolve)); owner.abort(Error("owner-canceled")); await canceledOriginal;
    assert.deepEqual(await continued, ownerCancel.selected, "a live joined request rebuilds candidates after its original owner cancels");
    assert.equal(ownerCancel.reads(), 2); assert.equal(follower.signal.aborted, false);

    const followerCancel = coldFixture("follower-cancel"), liveOwner = new AbortController(), stoppedFollower = new AbortController();
    const live = cache.candidates(followerCancel.make(liveOwner.signal), storage, followerCancel.scope); await followerCancel.begun;
    const joined = cache.candidates(followerCancel.make(stoppedFollower.signal), storage, followerCancel.scope);
    const canceledFollower = assert.rejects(joined, /follower-canceled/);
    await new Promise(resolve => setImmediate(resolve)); stoppedFollower.abort(Error("follower-canceled"));
    let timer;
    try { await Promise.race([canceledFollower, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("joined cancellation did not settle promptly")), 500); })]); }
    finally { clearTimeout(timer); followerCancel.release(); }
    assert.deepEqual(await live, followerCancel.selected); assert.equal(liveOwner.signal.aborted, false);
    await cache.candidates(followerCancel.make(new AbortController().signal), storage, followerCancel.scope);
    assert.equal(followerCancel.reads(), 1, "a canceled follower leaves the owner's result available for cache reuse");
    console.log("Memory catalog cache: unchanged-turn reuse, change invalidation, principal separation, and current authority checks passed.");
  } finally { close(); assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith("openbot-memory-catalog-")); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
