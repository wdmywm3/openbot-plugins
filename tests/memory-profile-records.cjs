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
async function checkImpressionAndGender() {
  const policy = require("../plugins/memory/unified-profile-impressions.cjs"), sender = { id: "helper", name: "小青" };
  const a = add("先把完整的报错发出来，我帮你看看。", -4500, { sender });
  const b = add("你之前试过哪几种办法？我们可以先排除那些。", -2940, { sender });
  const c = add("我把设置分成三步，你先试第一步，有问题再一起看。", -1350, { sender });
  const first = await policy.prepare(ctx, storage, scope, [a, b]);
  policy.save(storage, scope, first.entries);
  const next = await policy.prepare(ctx, storage, scope, [c]);
  assert.deepEqual(next.history.map(r => r.id), [a.id, b.id]);
  const evidence = [a, b, c].map(s => ({ id: s.id, quote: s.content }));
  const entry = { subjectId: sender.id, behavior: "常先问清别人试过什么，再一步步帮忙排查", impression: "愿意帮人，也讲究条理", evidence };
  const proposed = async (row, current = [c], history = next.history) => dream.plan(ctx, scope, { facts: [], topics: [], impressions: [row] }, current, [], { impressionHistory: history });
  const plan = await proposed(entry);
  assert.equal(plan.operations.length, 1);
  const record = plan.operations[0].record;
  assert.equal(record.attributes.profile.field, "impression"); assert.equal(record.attributes.profile.basis, "chat_observation");
  assert.match(record.content, /给人的印象是愿意帮人/); assert.deepEqual(record.sources.map(r => r.id), evidence.map(r => r.id));
  assert.equal((await proposed({ ...entry, subjectId: "somebody-else" })).operations.length, 0);
  assert.equal((await proposed({ ...entry, behavior: "很喜欢吃鱼", impression: "喜欢吃鱼的人" })).operations.length, 0);
  const tastes = ["我喜欢吃鱼，尤其是清蒸鱼。", "我爱吃鲈鱼，今天又点了一份。", "我喜欢吃鱼丸，也喜欢烤鱼。"].map((s, i) => add(s, -4000 + i * 1500, { sender }));
  assert.equal((await proposed({ ...entry, evidence: tastes.map(s => ({ id: s.id, quote: s.content })) }, tastes)).operations.length, 0);
  assert.equal((await proposed(entry, [c], [a, { ...b, forwarded: true }])).operations.length, 0);
  assert.equal((await proposed(entry, [c], [a, b].map(s => ({ ...s, createdAt: c.createdAt })))).operations.length, 0);
  const saved = seed(record, "first-impression"); assert.equal((await proposed(entry)).operations.length, 0);
  const d = add("先把你看到的选项贴一下，我们可以一起核对。", 0, { sender });
  const e = add("这次从第二个开关开始看，你把结果发给我。", 250, { sender });
  const changed = { ...entry, impression: "帮助别人时很耐心", evidence: [c, d, e].map(s => ({ id: s.id, quote: s.content })) };
  const revision = await proposed(changed, [d, e], [c]);
  assert.equal(revision.operations[0].id, saved.id);
  repo.memory({ ...actor, id: "desktop:owner", desktop: true }, { action: "revise", id: saved.id, expectedRevision: 1, changeType: "edit",
    patch: { content: "我自己编辑过的聊天印象" }, requestKey: "manual-impression" });
  assert.equal((await proposed(changed, [d, e], [c])).operations.length, 0);
  const gender = async (source, value) => dream.plan(ctx, scope, { facts: [{ kind: "fact", content: `小青自述性别为${value}`, subjectId: sender.id, profileSection: "identity",
    retention: { basis: "stable", reason: "在后续需要本人性别资料时使用本人确认的说法。" },
    fact: { subjectId: sender.id, facet: "性别", value, assertion: "self" }, evidence: [{ id: source.id, quote: source.content }] }], topics: [] }, [source], []);
  const g = add("我是女生。", 5, { sender }), gp = await gender(g, "女");
  assert.equal(gp.operations[0].record.attributes.profile.value, "女");
  const originalGender = seed(gp.operations[0].record, "first-gender");
  const updated = await gender(add("之前写错了，我的性别是非二元。", 10, { sender }), "非二元");
  assert.equal(updated.operations[0].id, originalGender.id); assert.equal(updated.operations[0].patch.attributes.profile.value, "非二元");
  for (const quote of ["我不是女生。", "她是女生。", "我是女生的朋友。", "头像看着像女生。", "她说：“我是女生。”"]) {
    assert.equal((await gender(add(quote, 12, { sender }), "女")).operations.length, 0);
  }
  const otherSender = { id: "guide", name: "小安" };
  const days = [a, b, c].map((s, i) => add(s.content, -7500 + i * 1560, { sender: otherSender }));
  let visible = [days[0], days[1]], id = "first-help";
  ctx.api.conversationForks = async req => {
    if (req.action === "list") return { snapshots: [{ id, boundary: "segment", at: visible.at(-1).createdAt }] };
    if (req.action === "sources") return { items: visible, nextOffset: null };
    if (id === "later-help") assert(req.branches.find(branch => branch.key === "profiles").instruction.includes(days[0].id));
    return { results: req.branches.map(branch => ({ key: branch.key, output: JSON.stringify(branch.key === "profiles" && id === "later-help"
      ? { impressions: [{ ...entry, subjectId: "guide", evidence: days.map(s => ({ id: s.id, quote: s.content })) }] } : {}) })) };
  };
  await forks.run(ctx, storage, scope, "manual");
  visible = [days[2]]; id = "later-help";
  assert.equal((await forks.run(ctx, storage, scope, "manual")).saved, 1);
  const persisted = search({ category: "profile", subjectId: "guide" });
  assert.deepEqual(read(persisted[0].id).sources.map(r => r.id), days.map(s => s.id));
}
async function checkActiveTool() {
  const runtime = require("../plugins/memory/unified-runtime.cjs"), sender = { id: "active-member", name: "阿晓" };
  const source = add("我不吃香菜。", -65, { sender });
  const fields = { category: "profile", kind: "preference", content: "阿晓自述不吃香菜", subjectRefs: [sender.id],
    attributes: { profile: { section: "habits" }, fact: { subjectId: sender.id, facet: "饮食偏好", value: "不吃香菜", assertion: "self" } } };
  const call = input => runtime.memory({ ...ctx, dataRoot: temp, message: source, principal: scope, plugin: { id: "memory" }, input });
  const first = await call({ action: "remember", record: fields, sourceQuote: source.content });
  assert.equal(read(first.id).category, "profile"); assert.equal(read(first.id).sources[0].quote, source.content);
  const duplicate = await call({ action: "remember", record: fields, sourceQuote: source.content, requestKey: "another-request" });
  assert.equal(duplicate.id, first.id);
  await assert.rejects(call({ action: "remember", record: { ...fields, subjectRefs: ["other"] }, sourceQuote: source.content }), /原话/);
  await assert.rejects(call({ action: "remember", record: fields, sourceQuote: "我喜欢香菜" }), /原话/);
  const prepared = await dream.plan(ctx, scope, { facts: [{ kind: "preference", subjectId: sender.id, content: fields.content, fact: fields.attributes.fact,
    profileSection: "habits", retention: { basis: "stable", reason: "以后在群内推荐饮食时避开香菜。" }, evidence: [{ id: source.id, quote: source.content }] }], topics: [] }, [source], []);
  assert(!prepared.operations.some(op => op.action === "create"));
}
(async () => {
  try { await checkProfiles(); await checkUsage(); await checkImpressionAndGender(); await checkActiveTool(); console.log("Personal memory: active tool and organizer share profiles, with sourced sticker use, gender self-report and multi-occasion impressions."); }
  finally { db.close(); close(); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
