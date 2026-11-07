"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const { createUnifiedMemoryRepository } = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs"));
const { candidates, identity } = require("../plugins/memory/unified-candidates.cjs");
const { resolveExisting, MAX_PAGES, PAGE_SIZE } = require("../plugins/memory/unified-existing.cjs");
const { factProjection } = require("../plugins/memory/lib/features/channels/channel-memory-write.cjs");
const db = new DatabaseSync(":memory:"), sources = new Map();
const scope = { channelId: "bot", chatId: "onebot:group:one" }, other = { ...scope, chatId: "onebot:group:other" };
const actor = { ...scope, id: "plugin:memory", permissions: ["read", "write", "manage", "share"].map(key => `memory:${key}`), canReadChat: () => true };
const repo = createUnifiedMemoryRepository(db, { source: (_scope, id) => sources.get(id), ownerAllowed: (who, kind, id) => kind === "chat" && (who.chatId === id || who.managementChats?.includes(id)) });
let serial = 0;
const make = (content, subject = "alice", value = "6GB", extra = {}) => ({ content, kind: "fact", status: "active", tier: "working", subjectRefs: [subject], sources: [],
  attributes: { fact: factProjection({ subjectId: subject, facet: "显存", value, conditions: [], assertion: "self" }, content) }, ...extra });
const create = (record, who = actor) => repo.memory(who, { action: "create", requestKey: `seed-${++serial}`, record });
const memory = async ({ chatId, ...input }) => repo.memory(actor, input);
const ctx = { signal: new AbortController().signal, api: { memory, memorySpace: async ({ chatId, ...input }) => repo.memorySpace(actor, input) } };
async function main() {
  try {
    const initial = make("小林的显卡显存为 6GB。"), paraphrase = make("小林表示自己有 6GB 显存。");
    assert.equal(identity(initial), identity(paraphrase), "a prose hash must not turn the same structured fact into a new identity");
    for (const different of [make("小林显存 8GB", "alice", "8GB"), make("小王显存 6GB", "bob"),
      { ...paraphrase, validFrom: 1000 }, { ...paraphrase, conditions: ["工作电脑"] },
      { ...paraphrase, attributes: { fact: { ...paraphrase.attributes.fact, assertion: "reported" } } },
      { ...paraphrase, attributes: { fact: { ...paraphrase.attributes.fact, conditions: ["工作电脑"] } } },
      { ...paraphrase, attributes: { fact: { ...paraphrase.attributes.fact, value: "不是6GB" } } }]) {
      assert.notEqual(identity(initial), identity(different), "subject, value, conditions, assertion and time remain distinct");
    }
    assert.notEqual(identity(initial), identity({ ...initial, content: "手动改成了8GB但未更新结构化字段" }), "stale projections cannot override the current prose");
    const first = create(initial), foreign = create(make("别的群的相同规格"), { ...actor, chatId: other.chatId });
    const bob = create(make("另一成员的显存", "bob", "8GB", { status: "pending" }));
    const seen = [];
    const found = await resolveExisting({ ...ctx, api: { ...ctx.api, memory: input => { if (input.action === "search") seen.push(input); return memory(input); } } }, scope, [], [paraphrase, make("另一位成员是8GB", "bob", "8GB")]);
    assert(found.some(item => item.id === first.id)); assert(found.some(item => item.id === bob.id), "pending candidates participate in duplicate lookup");
    assert(!found.some(item => item.id === foreign.id), "another chat's record never joins the merge set");
    assert(seen.some(input => input.subjectId === "alice") && seen.some(input => input.subjectId === "bob"), "every proposed subject is checked independently");
    assert(seen.every(input => input.spaceId === first.spaceId && input.limit === PAGE_SIZE && ["active", "pending"].includes(input.status)));
    const nextSource = { chatId: scope.chatId, id: "evidence-2", version: "v2", quote: "6GB" };
    const operations = [], before = [];
    candidates(found, operations, before)({ ...paraphrase, sources: [nextSource] });
    assert.equal(operations.length, 1); assert.equal(operations[0].action, "revise"); assert.equal(operations[0].id, first.id);
    assert.equal(operations[0].expectedRevision, first.revision); assert.equal(operations[0].patch.content, undefined, "merging evidence preserves the already stored prose");
    assert.equal(operations[0].patch.attributes, undefined, "a paraphrase must not corrupt the stored fact's contentHash");
    const noChange = [];
    candidates([{ ...initial, id: first.id, revision: 1, sources: [nextSource] }], noChange, [])({ ...paraphrase, sources: [nextSource] });
    assert.equal(noChange.length, 0, "the same evidence and same fact make no revision");
    const changed = [];
    candidates(found, changed, [])(make("小林现在显存为8GB", "alice", "8GB"));
    assert.equal(changed[0].action, "create", "a changed value never silently replaces the old fact");
    const pending = { ...initial, id: "pending", revision: 1, status: "pending", attributes: { ...initial.attributes,
      retention: { version: 1, basis: "stable", reason: "帮助后续配置", protected: false, observedAt: 1 } } };
    const promoted = [];
    candidates([pending], promoted, [])({ ...paraphrase, status: "active", tier: "long_term", expiresAt: null,
      attributes: { ...paraphrase.attributes, retention: { version: 1, basis: "explicit", reason: "本人要求记住", protected: true, observedAt: 2 } } });
    assert.equal(promoted[0].id, pending.id); assert.equal(promoted[0].patch.status, "active");
    assert.equal(promoted[0].patch.attributes.fact.contentHash, initial.attributes.fact.contentHash);
    const protectedOld = { ...pending, status: "active", tier: "long_term", attributes: promoted[0].patch.attributes };
    const retained = [];
    candidates([protectedOld], retained, [])({ ...paraphrase, status: "pending", sources: [nextSource],
      attributes: { ...paraphrase.attributes, retention: { ...pending.attributes.retention, observedAt: 3 } } });
    assert.equal(retained[0].patch.status, undefined); assert.equal(retained[0].patch.tier, undefined);
    assert.equal(retained[0].patch.attributes, undefined, "new ordinary mentions cannot weaken protected retention");
    const renewed = [], candidateExpiry = 1000;
    candidates([{ ...pending, expiresAt: candidateExpiry }], renewed, [])({ ...paraphrase, status: "pending", expiresAt: 2000,
      attributes: { ...paraphrase.attributes, retention: { ...pending.attributes.retention, observedAt: 2 } }, sources: [nextSource] });
    assert.equal(renewed[0].patch.expiresAt, 2000, "a genuinely later human observation renews the same candidate");
    const oldObservation = [];
    candidates([{ ...pending, expiresAt: candidateExpiry }], oldObservation, [])({ ...paraphrase, status: "pending", expiresAt: 500,
      attributes: { ...paraphrase.attributes, retention: pending.attributes.retention }, sources: [] });
    assert.equal(oldObservation.length, 0, "replaying an older observation neither extends nor shortens the candidate lifetime");
    const materials = [
      { id: "new-alice", version: "alice-v1", content: "请记住，我的显卡显存是6GB。", sender: { id: "alice" } },
      { id: "new-bob", version: "bob-v1", content: "请记住，我的显卡显存是8GB。", sender: { id: "bob" } },
    ].map(item => ({ ...item, chatId: scope.chatId, direction: "in", source: "chat", createdAt: Date.now() }));
    materials.forEach(item => sources.set(item.id, item));
    const parsed = { facts: materials.map((source, index) => ({ kind: "fact", subjectId: source.sender.id,
      content: index ? "另一位成员使用8GB显存。" : "小林表示自己有6GB显存。",
      fact: { subjectId: source.sender.id, facet: "显存", value: index ? "8GB" : "6GB", conditions: [], assertion: "self" },
      evidence: [{ id: source.id, quote: source.content }], retention: { basis: "explicit", reason: "本人明确要求记住，以便后续按硬件能力给部署建议" } })), topics: [] };
    const dream = require("../plugins/memory/unified-dream.cjs");
    const prepared = await dream.plan(ctx, scope, parsed, materials, []);
    assert.equal(prepared.operations.length, 2); assert(prepared.operations.every(operation => operation.action === "revise"), "plan independently finds both old facts without a model-supplied search result");
    assert.deepEqual(new Set(prepared.operations.map(operation => operation.id)), new Set([first.id, bob.id]));
    repo.memory(actor, { action: "batch", requestKey: "apply-verified-merges", operations: prepared.operations });
    assert.equal(repo.memory(actor, { action: "read", id: bob.id }).item.status, "active", "an explicit request promotes the existing pending record");
    assert.equal(repo.memory(actor, { action: "search", spaceId: first.spaceId }).items.length, 2);
    assert.equal((await dream.plan(ctx, scope, parsed, materials, [])).operations.length, 0, "replaying the same supported proposals makes no writes");
    const rejected = await dream.plan(ctx, scope, { facts: [{ ...parsed.facts[0], retention: { basis: "ephemeral", reason: "只涉及这一次聊天的暂时状态" } }], topics: [] }, materials, []);
    assert.equal(rejected.operations.length, 0); assert.equal(rejected.omitted, 1);
    repo.memorySpace({ ...actor, chatId: other.chatId, managementChats: [scope.chatId] }, { action: "grant", requestKey: "share-for-scope-check",
      spaceId: foreign.spaceId, targetSpaceId: first.spaceId, capabilities: ["read"] });
    await assert.rejects(resolveExisting(ctx, scope, [foreign], []), /其他聊天/);
    const canceled = new AbortController(); let checks = 0;
    await assert.rejects(resolveExisting({ ...ctx, signal: canceled.signal, api: { ...ctx.api,
      memory: async input => { if (input.action === "search") { checks++; canceled.abort(Error("stopped")); } return memory(input); } } }, scope, [], [paraphrase]), /stopped/);
    assert(checks <= 2, "cancellation stops the bounded lookup lanes");
    let changedDuringRead = false;
    await assert.rejects(resolveExisting({ ...ctx, api: { ...ctx.api, memory: async input => {
      if (input.action === "read" && input.id === first.id && !changedDuringRead) {
        changedDuringRead = true; repo.memory(actor, { action: "revise", id: first.id, expectedRevision: 2, changeType: "edit", requestKey: "concurrent-edit", patch: { content: "后来修改的记忆" } });
      }
      return memory(input);
    } } }, scope, [], [paraphrase]), /查重期间已变化/);
    let pages = 0;
    await assert.rejects(resolveExisting({ signal: new AbortController().signal, api: { memory: async input => {
      assert.equal(input.action, "search"); pages++;
      return { items: [], nextOffset: (input.offset || 0) + PAGE_SIZE, snapshot: "same", at: 1 };
    } } }, scope, [], [paraphrase]), /缩小查重范围/);
    assert(pages <= MAX_PAGES * 2, "an unfinished range is rejected instead of assumed empty");
    console.log("Memory deduplication: per-proposal scope lookup, pending reuse, structured paraphrases, source merging, changed-value isolation, protection, cancellation and version races passed.");
  } finally { db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
