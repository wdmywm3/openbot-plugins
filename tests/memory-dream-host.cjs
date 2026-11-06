"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { DatabaseSync } = require("node:sqlite");
const host = path.resolve(process.env.OPENBOT_HOST_ROOT || path.join(__dirname, "../../openbot"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-dream-host-")), db = new DatabaseSync(path.join(root, "host.sqlite"));
db.exec("CREATE TABLE channel_events(channel_id TEXT,chat_id TEXT,event_id TEXT,event_encoding TEXT,event_json BLOB,PRIMARY KEY(channel_id,chat_id,event_id))");
const source = require(path.join(host, "electron/lib/context/conversation-source-repository.cjs")).createConversationSourceRepository(db);
const memory = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs")).createUnifiedMemoryRepository(db, { source: (scope, id) => source.get(scope, id) });
const reads = require(path.join(host, "electron/lib/plugins/plugin-sources.cjs")).createPluginSources({ repository: source });
const runtime = require("../plugins/memory/unified-runtime.cjs"), storage = require("../plugins/memory/storage.cjs");
const chatId = "onebot:private:owner", scope = { channelId: "bot", chatId }, jobs = [], prompts = [];
const actor = { ...scope, id: "plugin:memory", permissions: ["memory:read", "memory:write", "memory:manage"], canReadChat: id => id === chatId };
let modelReply, peer = "owner", role = "owner", messageId = "request", agentCalls = 0;
function context(input = {}) {
  const chat = input.chatId || `onebot:private:${peer}`;
  return require("./helpers/organizer-model.cjs").organizerModel({ dataRoot: path.join(root, "plus"), plugin: { id: "memory", namespace: "bot" }, config: {}, signal: new AbortController().signal,
    principal: { source: "channel", channelId: "bot", chatId: chat, senderId: peer, role }, message: { id: messageId, chatId: chat, content: "测试消息" },
    input: { chatId: chat, ...input }, hook: { requestId: messageId, messages: [], inputMessages: [] }, api: {
      getCapabilities: async () => ({ features: { unifiedMemory: true, persistentContextItems: true, visibleContextItems: true, sourceHead: true } }),
      memory: async input => memory.memory({ ...actor, chatId: input.chatId || chat }, input),
      sources: async input => input.action === "scopes" ? { scopes: [{ chatId: chat }] } : reads({ channelId: "bot", chatId: input.chatId || chat }, input),
      generate: async input => { assert.equal(input.usageCategory, "memory"); prompts.push({ system: input.systemPrompt, body: JSON.parse(input.prompt) }); return { modelId: "controlled-fixture", text: JSON.stringify(modelReply) }; },
      jobs: async input => {
        if (input.action === "list") return { jobs: jobs.filter(job => (!input.statuses || input.statuses.includes(job.status))) };
        if (input.action === "start") { const job = { ...input, id: `job-${jobs.length}`, action: input.actionId, status: "queued" }; jobs.push(job); return job; }
        if (input.action === "cancel") { jobs.find(job => job.id === input.id).status = "canceled"; return {}; }
        return jobs.find(job => job.id === input.id);
      },
      runAgent: async () => { agentCalls++; throw Error("No stale job may call the model"); },
    } });
}
function message(id, content, chat = chatId, senderId = "owner") { messageId = id; source.record({ channelId: "bot", chatId: chat }, { id, content, direction: "in", source: "chat", sender: { id: senderId }, createdAt: Date.now() }); return [{ id, quote: content }]; }
const all = () => memory.memory(actor, { action: "search" }).items;
const read = id => memory.memory(actor, { action: "read", id }).item;
async function edit(record, patch, quote) {
  const evidence = message("update-" + record.revision, quote);
  modelReply = { facts: [], topics: [], updates: [{ id: record.id, revision: record.revision, content: quote, evidence, ...patch }] };
  await runtime.process(context({ dream: true })); return read(record.id);
}
(async () => {
  try {
    await runtime.initialize(context());
    const evidence = message("request", "请从现在开始每小时复查项目进展，有新资料时也检查一下。");
    await runtime.beforeModel(context()); await runtime.afterModel(context());
    modelReply = { facts: [], topics: [], records: [{ kind: "matter", subtype: "followup", content: "复查项目进展", progress: "waiting", evidence,
      nextReviewAt: Date.now() - 1000, reviewIntervalMinutes: 60, reviewOnChange: true }] };
    await runtime.process(context({ dream: true })); let record = read(all()[0].id);
    assert.equal(record.attributes.reviewIntervalMinutes, 60); assert.equal(record.attributes.reviewOnChange, true);
    assert.deepEqual(record.subjectRefs, ["owner"]); assert.equal(prompts.at(-1).body.context.relationship, "owner");
    assert.match(prompts.at(-1).system, /并行的事项/);
    await runtime.manage(context({ action: "settings", settings: { enabled: true, schedule: "daily", dailyTime: "03:00", idleMinutes: 0 } }));
    await runtime.recover(context()); const oldJob = jobs.find(job => job.action === "followup"); assert(oldJob);
    const newTime = Date.now() + 2 * 86400000;
    record = await edit(record, { nextReviewAt: newTime, reviewIntervalMinutes: 120 }, "改到后天开始，每两小时复查，有新资料仍然继续检查。");
    assert.equal(record.attributes.nextReviewAt, newTime); assert.equal(record.attributes.reviewIntervalMinutes, 120); assert.equal(record.attributes.reviewOnChange, true);
    assert((await runtime.followup(context(oldJob.input))).skipped); assert.equal(agentCalls, 0, "old queued job cannot run after postponement");
    record = await edit(record, {}, "同一项目仍在等待对方回复。"); assert.equal(record.attributes.nextReviewAt, newTime);
    record = await edit(record, { nextReviewAt: null }, "先停止这个项目的全部自动复查。"); assert.deepEqual(record.attributes, {});
    record = await edit(record, { nextReviewAt: Date.now() + 10000, reviewOnChange: true }, "现在授权再次复查，有新资料也检查。");
    record = await edit(record, { progress: "canceled" }, "取消这个项目，不再继续。"); assert.equal(record.progress, "canceled"); assert.deepEqual(record.attributes, {});
    record = await edit(record, { progress: "active", reopen: true }, "重新开启这个项目，先记录目标，不要自动检查。"); assert.equal(record.progress, "active"); assert.deepEqual(record.attributes, {});
    assert.equal(all().filter(item => item.kind === "matter").length, 1, "edits reuse one durable matter");
    const history = memory.memory(actor, { action: "history", id: record.id }); assert(history.items.length >= 6);
    peer = "member"; role = "member"; message("private-member", "我是普通对话方。", "onebot:private:member", "member");
    modelReply = { facts: [], topics: [] }; await runtime.beforeModel(context()); await runtime.afterModel(context()); await runtime.process(context({ dream: true }));
    assert.equal(prompts.at(-1).body.context.relationship, "member"); assert.doesNotMatch(prompts.at(-1).system, /宿主最近一次确认此私聊对话方为主人/);
    message("group", "两位群员在讨论不同的事情。", "onebot:group:g", "member"); await runtime.process(context({ chatId: "onebot:group:g", dream: true }));
    assert.equal(prompts.at(-1).body.context.chatType, "group"); assert.match(prompts.at(-1).system, /不能把 A 的话记到 B 身上/);
    source.record({ channelId: "bot", chatId: "onebot:group:g" }, { id: "large-image-source", content: "这一条带有图片资料。",
      direction: "in", source: "chat", sender: { id: "member" }, createdAt: Date.now(),
      media: [{ type: "image", name: "原图", mimeType: "image/gif", url: "data:image/gif;base64," + "A".repeat(2 * 1024 * 1024) }] });
    await runtime.process(context({ chatId: "onebot:group:g", dream: true }));
    const input = prompts.at(-1).body, attachment = input.messages.find(item => item.id === "large-image-source").attachments[0];
    assert.deepEqual(attachment, { index: 0, type: "image", mimeType: "image/gif", name: "原图" });
    assert(JSON.stringify(input).length < 64000, "dream receives paged source text and attachment metadata rather than inline image bodies");
    const payload = storage.open(path.join(root, "plus")).db.prepare("SELECT MAX(bytes) AS size FROM channel_dream_run_payloads").get();
    assert(payload.size < 128000, "dream traces must not persist the source image body");
    console.log("Dream host: real source feed/memory revisions/plugin SQLite, three scene prompts, periodic/change rules, reschedule, stale queued job, explicit stop/cancel/reopen, and single-record history passed (controlled generation).");
  } finally { await runtime.stopping(); storage.close(); db.close(); assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith("openbot-dream-host-")); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
