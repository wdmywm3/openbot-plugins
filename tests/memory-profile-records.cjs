"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const { createUnifiedMemoryRepository } = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs"));
const { factProjection } = require("../plugins/memory/lib/features/channels/channel-memory-write.cjs");
const forks = require("../plugins/memory/unified-fork-organizer.cjs"), migration = require("../plugins/memory/unified-profile-migration.cjs");
const usage = require("../plugins/memory/unified-profile-usage.cjs"), dream = require("../plugins/memory/unified-dream.cjs");
const { open, close } = require("../plugins/memory/storage.cjs"), { put } = require("../plugins/memory/unified-state.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-profile-records-")), db = new DatabaseSync(":memory:"), storage = open(temp);
const scope = { channelId: "bot", chatId: "onebot:group:a" }, messages = new Map(), base = Date.now() - 86400000;
const actor = { ...scope, id: "plugin:memory", permissions: ["memory:read", "memory:write", "memory:manage"], canReadChat: id => id === scope.chatId };
const repo = createUnifiedMemoryRepository(db, { source: (_, id) => messages.get(id) });
const ctx = { signal: new AbortController().signal, api: {
  memory: async input => repo.memory(actor, input), memorySpace: async input => repo.memorySpace(actor, input),
  sources: async input => ({ item: messages.get(input.id) }),
} };
let seq = 0;
const add = (content, minute, extra = {}) => {
  ++seq;
  const item = { ...scope, id: "m" + seq, version: "v" + seq, seq, createdAt: base + minute * 60000,
    sender: { id: "member", name: "小林" }, direction: "in", source: "chat", content, ...extra };
  messages.set(item.id, item); return item;
};
const search = input => repo.memory(actor, { action: "search", mode: "history", ...input }).items;
const read = id => repo.memory(actor, { action: "read", mode: "history", id }).item;
const seed = (record, requestKey) => repo.memory(actor, { action: "create", requestKey, record });
async function checkProfiles() {
  const source = add("我到现在不吃鱼", 1), content = "小林自述不吃鱼";
  const fact = { subjectId: "member", facet: "饮食偏好", value: "不吃鱼", assertion: "self" };
  const evidence = [{ id: source.id, quote: source.content }];
  const proposal = { kind: "fact", content, subjectId: "member", evidence, fact, retention: { basis: "stable", reason: "下次为这位成员推荐菜品时避开鱼。" } };
  const profile = { ...proposal, kind: "preference", profileSection: "habits" };
  const plan = await dream.plan(ctx, scope, { facts: [proposal, profile], topics: [] }, [source], []);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].record.category, "profile");
  assert.equal(plan.operations[0].record.kind, "preference");
  const original = { content, subjectRefs: ["member"], sources: [{ ...evidence[0], chatId: scope.chatId, version: source.version }],
    kind: "fact", tier: "long_term", status: "active", attributes: { fact: factProjection(fact, content), retention: { protected: false } } };
  const ordinary = seed(original, "old-fact"), canonical = seed(plan.operations[0].record, "old-profile");
  const protectedRecord = seed({ ...original, attributes: { ...original.attributes, retention: { protected: true } } }, "protected");
  const differentSource = add("我确实没吃鱼", 2);
  const distinct = seed({ ...original, sources: [{ chatId: scope.chatId, id: differentSource.id, version: differentSource.version, quote: differentSource.content }] }, "other-source");
  const soySource = add("我平时爱喝豆浆", 3), soyText = "小林平时爱喝豆浆";
  const soy = seed({ ...original, content: soyText, sources: [{ chatId: scope.chatId, id: soySource.id, version: soySource.version, quote: soySource.content }],
    attributes: { fact: factProjection({ ...fact, value: "爱喝豆浆" }, soyText), retention: { protected: false, basis: "stable" } } }, "standalone-food-fact");
  put(storage, migration.key(scope), { after: 200, complete: true });
  assert(migration.pending(storage, scope));
  while ((await migration.classify(ctx, storage, scope)).pending) {}
  assert(!migration.pending(storage, scope));
  assert.equal(read(protectedRecord.id).status, "active"); assert.equal(read(distinct.id).status, "active");
  assert.equal(read(ordinary.id).status, "archived");
  assert.equal(read(soy.id).category, "profile"); assert.equal(read(soy.id).attributes.profile.section, "habits");
  assert(read(canonical.id).relations.some(link => link.id === ordinary.id));
  assert.equal(read(canonical.id).content, content);
  assert.equal(repo.memory(actor, { action: "read", id: ordinary.id, revision: 1 }).item.content, content);
  const repeat = await dream.plan(ctx, scope, { facts: [profile], topics: [] }, [source], []);
  assert(!repeat.operations.some(op => op.action === "create"));
  assert.equal((await migration.classify(ctx, storage, scope)).pending, false);
  const likes = add("我一直很喜欢这套漫画", 4);
  const likePlan = await dream.plan(ctx, scope, { facts: [{ ...profile, content: "小林自述一直喜欢这套漫画", profileSection: "interests",
    fact: { ...fact, facet: "兴趣爱好", value: "喜欢这套漫画" }, evidence: [{ id: likes.id, quote: likes.content }] }], topics: [] }, [likes], []);
  assert.equal(likePlan.operations[0].record.attributes.profile.basis, "self_report");
}
async function checkUsage() {
  const attachment = { index: 0, type: "image", sticker: true, description: "[动画表情]", previewAvailable: true,
    name: "0123456789abcdef0123456789abcdef.gif" };
  const make = (minute, extra = {}) => add("收到啦[动画表情]", minute, { attachments: [attachment], ...extra });
  const a = make(0), b = make(12), c = make(45);
  const ignored = [make(50, { forwarded: true }), make(50, { direction: "out" }), make(50, { sender: { id: "bot", isBot: true } }),
    make(50, { memoryExcluded: true }), make(60, { sender: { id: "someone-else" } }), make(60, { chatId: "other" }),
    make(65, { attachments: [{ ...attachment, sticker: false }] }), make(66, { content: "[图片]", attachments: [{ type: "image", index: 0, name: attachment.name }] })];
  let pending = await usage.collect(ctx, storage, scope, [a, a, b, ...ignored]);
  assert.equal(pending.records.length, 0);
  assert.equal(pending.entries.find(e => e.subject === "member").refs.length, 2);
  const separate = { ...scope, chatId: "other" };
  assert.equal((await usage.collect(ctx, storage, separate, [{ ...c, chatId: "other" }])).records.length, 0);
  const shot = (m, i) => ({ id: "segment-" + i, at: m.createdAt, boundary: "segment" });
  let visible, snapshot, failWrite = false;
  ctx.api.conversationForks = async input => {
    if (input.action === "list") return { snapshots: [snapshot] };
    if (input.action === "sources") return { items: visible, nextOffset: null };
    return { results: input.branches.map(branch => ({ key: branch.key, output: JSON.stringify(branch.key === "profiles" ? {
      usages: visible.map(row => ({ type: "expression", messageId: row.id, expression: "收到啦" })),
      facts: [{ kind: "preference", subjectId: "member", profileSection: "interests", content: "小林喜欢这个表情包", evidence: [{ id: visible[0].id, quote: "[动画表情]" }],
        retention: { basis: "stable", reason: "以后根据偏好推荐表情包" } }],
    } : {}) })) };
  };
  const native = ctx.api.memory;
  ctx.api.memory = async input => {
    const result = await native(input);
    if (failWrite && input.action === "batch") { failWrite = false; throw Error("receipt lost"); }
    return result;
  };
  for (const [index, row] of [a, b].entries()) {
    visible = [row]; snapshot = shot(row, index);
    assert.equal((await forks.run(ctx, storage, scope, "manual")).saved, 0);
  }
  messages.set(a.id, { ...a, deleted: true });
  assert.equal((await usage.collect(ctx, storage, scope, [c])).records.length, 0);
  messages.set(a.id, a);
  visible = [c]; snapshot = shot(c, 3); failWrite = true;
  await assert.rejects(forks.run(ctx, storage, scope, "manual"), /receipt lost/);
  assert.equal((await usage.collect(ctx, storage, scope, [c])).records.length, 1, "unacknowledged writes do not consume observations");
  require("../plugins/memory/unified-fork-retries.cjs").clear(storage, scope, snapshot.id);
  await forks.run(ctx, storage, scope, "manual");
  const records = search({ category: "profile" }).map(hit => read(hit.id));
  const observed = records.filter(r => r.attributes.profile?.basis === "observed_use");
  assert.equal(observed.length, 2, "one sticker habit and one expression survive replay");
  assert(!records.some(r => r.content.includes("喜欢这个表情包")));
  const sticker = observed.find(r => r.attributes.profile.usage === "sticker");
  assert.equal(sticker.content, "小林聊天时常用这张表情，常和「收到啦」一起发。");
  assert.equal(sticker.kind, "fact"); assert.equal(sticker.attributes.fact.assertion, "observed");
  assert.deepEqual(sticker.sources.map(ref => ref.id), [a.id, b.id, c.id]);
  assert.equal(sticker.attributes.sourceImages[0].index, 0);
  assert.equal(observed.find(r => r.attributes.profile.usage === "expression").content, "小林发言时常用「收到啦」这个表达。");
  assert.equal((await usage.collect(ctx, storage, scope, [a, b, c])).records.length, 0);
  const sender = { id: "other" };
  assert.equal((await usage.collect(ctx, storage, scope, [make(2000, { sender }), make(2001, { sender }), make(2002, { sender })])).records.length, 0, "a burst never qualifies");
  assert.equal((await usage.collect(ctx, storage, scope, [make(0, { sender }), make(3, { sender }), make(32 * 1440, { sender })])).records.length, 0, "uses months apart do not qualify");
  assert.equal(usage.stickerId({ type: "image", name: attachment.name }, { content: "[动画表情]", attachments: [attachment] }), "file:" + attachment.name.slice(0, 32));
}
(async () => {
  try { await checkProfiles(); await checkUsage(); console.log("Personal memory: one shared assertion, scoped migration, repeated original sticker and phrase use, revocation and receipt replay passed."); }
  finally { db.close(); close(); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
