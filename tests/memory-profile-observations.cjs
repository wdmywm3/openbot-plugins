"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const { createUnifiedMemoryRepository } = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs"));
const runtime = require("../plugins/memory/unified-runtime.cjs"), review = require("../plugins/memory/unified-profile-review.cjs");
const obs = require("../plugins/memory/unified-profile-observations.cjs");
const { get, put, state, save } = require("../plugins/memory/unified-state.cjs");
const { open, close } = require("../plugins/memory/storage.cjs");
const { DAY } = require("../plugins/memory/unified-profile-usage.cjs");
const scheduling = require("../plugins/memory/unified-scheduling.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "profile-observations-")), db = new DatabaseSync(":memory:");
const chat = "onebot:group:home", other = "onebot:group:away", scope = { channelId: "instance", chatId: chat };
const now = Date.now, start = now(), base = start - 40 * DAY;
let time = start, storage = open(temp), loseReceipt = false;
const changes = [], latest = new Map(), revoked = new Set(), batches = [], modelCalls = [], jobs = [];
const repo = createUnifiedMemoryRepository(db, { source: (s, id) => latest.get(JSON.stringify([s.chatId, id])) });
const actor = chatId => ({ ...scope, chatId, id: "plugin:memory", permissions: ["memory:read", "memory:write", "memory:manage"], canReadChat: id => id === chatId });
const icon = { type: "image", index: 0, sticker: true, name: "0123456789abcdef0123456789abcdef.gif", previewAvailable: true };
const marks = ["先把报错贴出来，我们先看看出错的位置。", "你已经试过哪些设置了？一起逐个排查。", "先按这三个步骤操作，再把结果发来一起看。"];
function add(subject, day, content, extra = {}) {
  const seq = changes.length + 1;
  const row = { ...scope, seq, id: "source-" + seq, version: "v" + seq, createdAt: base + day * DAY,
    sender: { id: subject }, source: "chat", direction: "in", content, ...extra };
  changes.push(row); latest.set(JSON.stringify([row.chatId, row.id]), row); return row;
}
const sticker = (subject, day, extra = {}) => add(subject, day, "[动画表情]", { attachments: [icon], ...extra });
const api = {
  conversationForks: async input => { assert.equal(input.action, "list", "the member reviewer cannot depend on a conversation fork"); return { snapshots: [] }; },
  sources: async input => {
    const rows = changes.filter(r => r.chatId === input.chatId);
    if (input.action === "scopes") return { scopes: [{ chatId: chat }, { chatId: other }] };
    if (input.action === "head") return { upper: rows.at(-1)?.seq || 0 };
    if (input.action === "changes") {
      const upper = Math.min(input.upper ?? Infinity, rows.at(-1)?.seq || 0);
      const page = rows.filter(r => r.seq > input.after && r.seq <= upper);
      return { upper, items: page.slice(0, input.limit), nextCursor: page.length > input.limit ? page[input.limit - 1].seq : null };
    }
    assert.equal(input.action, "read");
    const item = latest.get(JSON.stringify([input.chatId, input.id]));
    return revoked.has(input.id) ? { item: { ...item, memoryExcluded: true }, revoked: true }
      : { item: item?.version === input.version ? item : null };
  },
  memory: async input => {
    const result = repo.memory(actor(input.chatId || chat), input);
    if (input.action === "batch") {
      batches.push(input.requestKey);
      if (loseReceipt) { loseReceipt = false; throw Error("receipt lost"); }
    }
    return result;
  },
  memorySpace: async input => repo.memorySpace(actor(input.chatId), input),
  generate: async input => {
    assert.equal(input.usageCategory, "memory");
    const { subjectId, messages } = JSON.parse(input.prompt);
    modelCalls.push(subjectId);
    assert(messages.every(m => latest.get(JSON.stringify([chat, m.id]))?.sender.id === subjectId));
    const evidence = messages.filter(m => marks.includes(m.text)).map(m => ({ id: m.id, quote: m.text }));
    return { text: JSON.stringify({ impressions: evidence.length >= 3 ? [{ subjectId, behavior: "讨论问题时常先了解对方已经试过什么，再分步排查", impression: "耐心而有条理", evidence }] : [],
      expressions: subjectId === "speaker" ? ["先摆摆手", "从未说过的话"] : [] }) };
  },
  jobs: async input => { jobs.push(input); return input.action === "list" ? { jobs: [] } : { id: input.requestKey }; },
};
const ctx = (chatId = chat, input = {}) => ({ dataRoot: temp, principal: scope, plugin: { id: "memory" }, signal: new AbortController().signal,
  message: { chatId }, input: { chatId, mode: "observations", ...input }, api });
const tick = (id = chat) => runtime.process(ctx(id));
const active = id => repo.memory(actor(id), { action: "search", category: "profile", mode: "history" }).items
  .map(hit => repo.memory(actor(id), { action: "read", mode: "history", id: hit.id }).item);
const restart = () => { close(); storage = open(temp); };
async function run() {
  Date.now = () => time;
  save(storage, scope, { settingsOverride: { enabled: true } });
  const original = sticker("quiet", 0), first = add("helper", 0, marks[0]);
  put(storage, "plus:profile-usage:" + chat, [{ subject: "quiet", type: "sticker", value: "file:" + icon.name.slice(0, 32),
    refs: [{ id: original.id, version: original.version, seq: original.seq, at: original.createdAt }] }]);
  sticker("quiet", -60); // older than the 90-day window
  const edited = sticker("quiet", 0, { id: original.id }); // same send, revised version
  for (let i = 0; i < 170; i++) { sticker("member-" + i, 1); add("member-" + i, 1, "今天聊聊群里的近况。"); }
  sticker("quiet", 3, { forwarded: true }); sticker("quiet", 3, { sender: { id: "quiet", isBot: true } });
  sticker("quiet", 3, { routeBlocked: true }); sticker("quiet", 3, { attachments: [{ ...icon, sticker: false }] });
  const second = sticker("quiet", 8); add("helper", 8, marks[1]);
  const ignored = sticker("withdrawn", 0); sticker("withdrawn", 4); sticker("withdrawn", 8); revoked.add(ignored.id);
  sticker("burst", 1); sticker("burst", 1.01); sticker("burst", 1.12);
  sticker("quiet", 4, { chatId: other });
  assert((await tick()).pending, "a bounded scan persists a continuation");
  assert.equal(modelCalls.length, 0);
  restart();
  assert.equal((await tick()).saved, 0);
  assert.equal(get(storage, "plus:profile-usage:" + chat), null);
  assert.equal(active(chat).length, 0);
  assert(get(storage, obs.cursorKey(scope)) >= second.seq);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM profile_observations WHERE chat=? AND id=?").get(chat, original.id).n, 1);
  assert(!storage.db.prepare("SELECT 1 FROM profile_observations WHERE chat=? AND id=?").get(chat, ignored.id));
  const third = sticker("quiet", 32);
  add("helper", 32, marks[2]);
  add("last-speaker", 38, "最后一个分段只有别人发言。");
  time += 16 * 60000;
  scheduling.activity(storage, scope, "chatting", true);
  await runtime.recover(ctx());
  assert(jobs.some(j => j.input?.mode === "observations" && j.chatId === chat));
  assert((await tick()).pending); assert(get(storage, obs.cursorKey(scope)) >= third.seq);
  assert.equal(modelCalls.length, 0); assert.equal(active(chat).length, 0);
  scheduling.activity(storage, scope, "chatting", false);
  time += 2 * 60000; loseReceipt = true;
  await assert.rejects(tick(), /receipt lost/);
  assert.equal(active(chat).length, 1);
  restart(); time += 2 * 60000;
  assert.equal((await tick()).saved, 2, "including the recovered receipt");
  const records = active(chat);
  assert.equal(records.length, 2); assert.equal(batches[0], batches[1]);
  const habit = records.find(r => r.subjectRefs[0] === "quiet"), impression = records.find(r => r.subjectRefs[0] === "helper");
  assert.equal(habit.content, "常用这张表情。"); assert.equal(habit.attributes.profile.basis, "observed_use");
  assert.deepEqual(habit.sources.map(s => [s.id, s.version]), [edited, second, third].map(s => [s.id, s.version]));
  assert.equal(impression.attributes.profile.basis, "chat_observation"); assert.equal(impression.sources[0].id, first.id);
  assert.deepEqual(modelCalls, ["helper"]); assert.equal(state(storage, scope).cursor, 0, "the fork cursor is independent");
  time += 16 * 60000; assert.equal((await tick()).saved, 0); assert.deepEqual(modelCalls, ["helper"]);
  assert.equal((await tick(other)).saved, 0); assert.equal(active(other).length, 0);
  await runtime.manage(ctx(other, { action: "run" }));
  const queued = jobs.find(j => j.action === "start" && j.chatId === other);
  const manual = await runtime.process(ctx(other, { ...queued.input, mode: "manual" }));
  assert.equal(manual.observations.saved, 0); assert.equal(active(other).length, 0, "no pooling across groups");
  const fourth = sticker("quiet", 39);
  time += DAY;
  assert.equal((await tick()).saved, 0, "receipt of a new send and review of an existing habit have independent cadences");
  time += 7 * DAY;
  await runtime.recover(ctx());
  assert(jobs.some(j => j.input?.mode === "observations" && j.chatId === chat), "a quiet chat can qualify for review without a new fork or a new send");
  assert.equal((await tick()).saved, 1);
  const updated = active(chat).find(r => r.id === habit.id);
  assert.equal(updated.revision, 2); assert(updated.sources.some(ref => ref.id === fourth.id));
  repo.memory({ ...actor(chat), id: "desktop:owner", desktop: true }, { action: "transition", id: habit.id, expectedRevision: updated.revision,
    patch: { status: "archived" }, reason: "用户归档", requestKey: "user-archive" });
  sticker("quiet", 46); time += 8 * DAY;
  assert.equal((await tick()).saved, 0);
  assert.equal(active(chat).filter(r => r.subjectRefs[0] === "quiet").length, 1, "new signals do not recreate an archived profile");
  save(storage, scope, { settingsOverride: { enabled: false } }); const oldCursor = get(storage, obs.cursorKey(scope));
  sticker("paused", 40); await tick(); assert.equal(get(storage, obs.cursorKey(scope)), oldCursor);
  await runtime.manage(ctx(chat, { action: "startFromNow", requestKey: "start-now" }));
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM profile_observations WHERE chat=?").get(chat).n, 0);
  save(storage, scope, { settingsOverride: { enabled: true } }); await tick();
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM profile_observations WHERE chat=?").get(chat).n, 0);
  assert(!review.due(storage, scope, state(storage, scope)));
  for (const day of [45, 48, 51]) add("speaker", day, "先摆摆手");
  time += 16 * 60000;
  assert.equal((await tick()).saved, 1);
  const expression = active(chat).find(r => r.subjectRefs[0] === "speaker");
  assert.equal(expression.content, "常用「先摆摆手」这个表达。"); assert.equal(expression.sources.length, 3);
  const owner = { ...actor(chat), id: "desktop:owner", desktop: true, permissions: [...actor(chat).permissions, "memory:forget"], explicitForget: true };
  repo.memory(owner,
    { action: "forget", id: expression.id, expectedRevision: expression.revision,
    reason: "用户遗忘", requestKey: "forget-expression" });
  add("speaker", 54, "先摆摆手"); time += 8 * DAY;
  const forgotten = await tick();
  assert.equal(forgotten.saved, 0); assert.equal(forgotten.pending, false, "a forgotten phrase must not strand the review queue");
  assert(!active(chat).some(r => r.subjectRefs[0] === "speaker"));
  console.log("Profile observations survive restart and missed segments, verify original sends, recover receipts, respect scope, archive, disabled settings and checkpoint.");
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  Date.now = now; close(); db.close(); fs.rmSync(temp, { recursive: true, force: true });
});
