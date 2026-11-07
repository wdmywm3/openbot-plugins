"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const { createUnifiedMemoryRepository } = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs"));
const dream = require("../plugins/memory/unified-dream.cjs");
const retention = require("../plugins/memory/unified-retention.cjs");
const { close } = require("../plugins/memory/storage.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-retention-")), db = new DatabaseSync(path.join(root, "host.sqlite"));
const scope = { channelId: "bot", chatId: "onebot:group:team" }, otherScope = { ...scope, chatId: "onebot:group:other" };
const sources = new Map(), requests = [];
let clock = Date.now(), sequence = 0;
const repo = createUnifiedMemoryRepository(db, { now: () => clock,
  source: (who, id) => sources.get(JSON.stringify([who.chatId, id])) });
const actor = who => ({ ...who, id: "plugin:memory", permissions: ["read", "write", "manage"].map(name => `memory:${name}`),
  canReadChat: chatId => chatId === who.chatId });
function context(who = scope, signal = new AbortController().signal) {
  return { dataRoot: path.join(root, "plugin"), plugin: { id: "memory", namespace: "bot" }, principal: { ...who, senderId: "alice" }, signal,
    api: {
      memory: async input => { signal.throwIfAborted(); requests.push(input); const { chatId = who.chatId, ...request } = input;
        return repo.memory(actor({ ...who, chatId }), request); },
      memorySpace: async input => { signal.throwIfAborted(); const { chatId = who.chatId, ...request } = input;
        return repo.memorySpace(actor({ ...who, chatId }), request); },
    } };
}
function source(content, who = scope, id = `message-${++sequence}`) {
  const value = { id, seq: sequence, version: `version-${sequence}`, chatId: who.chatId, createdAt: clock,
    direction: "in", source: "chat", sender: { id: "alice", name: "阿明", isBot: false }, content };
  sources.set(JSON.stringify([who.chatId, id]), value); return value;
}
function proposal(material, content, retention, patch = {}) {
  return { kind: "fact", subjectId: "alice", content, evidence: [{ id: material.id, quote: material.content }],
    ...(retention ? { retention } : {}), ...patch };
}
async function extract(item, material, who = scope, extra = {}) {
  return dream.plan(context(who), who, { facts: [item], topics: [], ...extra }, [material], []);
}
function commit(plan, who = scope) {
  if (!plan.operations.length) return [];
  return repo.memory(actor(who), { action: "batch", requestKey: `proposal-${++sequence}`, operations: plan.operations }).items;
}
const read = (id, who = scope) => repo.memory(actor(who), { action: "read", id, mode: "history" }).item;
const current = (who = scope) => repo.memory(actor(who), { action: "search" }).items;

(async () => {
  try {
    const download = source("上午下载了一个 RVC 模型，还没有接入和测试。");
    const downloaded = "阿明上午下载了一个 RVC 模型，尚未接入测试。";
    assert.equal((await extract(proposal(download, downloaded), download)).operations.length, 0,
      "an older proposal without a retention decision cannot become a permanent fact");
    assert.equal((await extract(proposal(download, downloaded, { basis: "ephemeral", reason: "这只是本次聊天的临时下载进度。" }), download)).operations.length, 0);
    assert.equal(current().length, 0, "ordinary one-off progress stays in searchable source history");
    for (const value of [{ basis: "stable", reason: "有原话依据" }, { basis: "stable", reason: "" },
      { basis: "stable", reason: "以后可能有用" }, { basis: "unknown", reason: "后续回答使用这条没有分类的内容。" }]) {
      assert.equal(retention.admission(proposal(download, downloaded, value), [download], scope), null,
        "unclassified proposals and generic save reasons cannot claim durable value");
    }
    const allegedBoundary = proposal(download, "阿明的长期边界", { basis: "boundary", reason: "后续创作必须遵守阿明本人的明确要求。" });
    for (const material of [{ ...download, direction: "out" }, { ...download, sender: { id: "alice", isBot: true } },
      { ...download, event: { type: "notice" } }, { ...download, source: "task_report" }, { ...download, sender: { id: "bob" } }]) {
      assert.equal(retention.admission(allegedBoundary, [material], scope), null,
        "bot, platform, task output and another speaker cannot create a person's durable boundary");
    }

    // Even an overly generous extraction model cannot make a first observation
    // durable merely by calling it stable. It must pass the later review lane.
    const fact = { subjectId: "alice", facet: "rvc_setup", value: "downloaded_not_tested", conditions: [], assertion: "self" };
    const pendingPlan = await extract(proposal(download, downloaded, { basis: "stable", reason: "可能有助于下次排查这台设备上的语音部署。" }, { fact }), download);
    const candidate = read(commit(pendingPlan)[0].id);
    assert.equal(candidate.status, "pending"); assert.equal(candidate.tier, "working");
    assert.equal(candidate.attributes.retention.protected, false);
    assert(candidate.expiresAt > clock && candidate.expiresAt <= Date.now() + 14 * 86400000 + 1000);
    assert.equal(current().length, 0, "unreviewed candidates do not appear as current facts or automatic recall material");

    const repeated = source("RVC 模型已经下载到本地了，但还没有测试。");
    const merged = await extract(proposal(repeated, "阿明表示已把 RVC 模型下载到本地，目前未测试。",
      { basis: "stable", reason: "可能有助于后续语音部署排查。" }, { fact }), repeated);
    const updated = commit(merged)[0];
    assert.equal(updated.id, candidate.id, "rewriting the same structured fact adds evidence to its existing candidate");
    assert.equal(read(candidate.id).sources.length, 2);
    assert.equal(read(candidate.id).status, "pending");
    assert.equal(repo.memory(actor(scope), { action: "search", mode: "history", status: "pending" }).items.length, 1);

    for (const section of ["interests", "habits", "self_description"]) {
      const classified = retention.admission(proposal(download, downloaded,
        { basis: "stable", reason: "后续语音部署排查需要核对这个状态。" }, { profileSection: section }), [download], scope);
      assert.equal(classified.status, "pending", "a profile heading cannot turn an ordinary event fact into an immediately effective trait");
      assert.equal(classified.attributes.retention.protected, false);
    }

    const boundary = source("请不要把我作为生成视频的素材，以后都不要。");
    const protectedBoundary = read(commit(await extract(proposal(boundary, "阿明明确要求以后不要将自己用于生成视频素材。",
      { basis: "boundary", reason: "后续创作和素材建议必须遵守本人的明确边界。" }, { kind: "preference", profileSection: "boundaries" }), boundary))[0].id);
    assert.equal(protectedBoundary.status, "active"); assert.equal(protectedBoundary.attributes.retention.protected, true);

    const requested = source("请记住，我的 NAS 备份目录是 /srv/backup，之后讨论备份时按这个目录。");
    const protectedRequest = read(commit(await extract(proposal(requested, "阿明的 NAS 备份目录为 /srv/backup。",
      { basis: "explicit", reason: "本人明确要求在后续备份讨论中保留和使用此目录。" }), requested))[0].id);
    assert.equal(protectedRequest.status, "active"); assert.equal(protectedRequest.attributes.retention.protected, true);

    const preference = source("以后回答我请先给结论，再给必要的解释。");
    const profile = read(commit(await extract(proposal(preference, "阿明希望后续回答先给结论，再给必要解释。",
      { basis: "stable", reason: "后续回答持续遵守本人明确的表达偏好。" }, { kind: "preference", profileSection: "communication" }), preference))[0].id);
    assert.equal(profile.status, "active"); assert.equal(profile.category, "profile");

    const elsewhere = source("RVC 模型已经下载到本地了，但还没有测试。", otherScope);
    const otherCandidate = commit(await extract(proposal(elsewhere, downloaded,
      { basis: "stable", reason: "后续处理这个聊天的语音部署问题。" }, { fact }), elsewhere, otherScope), otherScope)[0];
    assert.notEqual(otherCandidate.id, candidate.id, "same member and wording in another chat do not combine its history");
    assert.equal(read(candidate.id).sources.length, 2);
    assert(requests.filter(input => input.action === "search").every(input => input.chatId === scope.chatId || input.chatId === otherScope.chatId));

    const canceled = new AbortController(); canceled.abort(Error("用户停止整理"));
    await assert.rejects(dream.plan(context(scope, canceled.signal), scope, { facts: [proposal(preference, "已取消的新提案",
      { basis: "stable", reason: "后续回答使用稳定偏好。" })], topics: [] }, [preference], []), /用户停止整理/);
    assert.equal(current().length, 3, "canceling an extraction cannot create another active memory");

    function seedCandidates(who, count, size) {
      for (let i = 0; i < count; i++) repo.memory(actor(who), { action: "create", requestKey: `budget-${who.chatId}-${i}`,
        record: { content: String(i).padStart(4, "0") + "候".repeat(size - 4), kind: "fact", status: "pending", tier: "working",
          expiresAt: clock + 14 * 86400000, attributes: { retention: { version: 1, basis: "stable", reason: "后续具体技术协助时核对这一候选事实。", protected: false, observedAt: clock } } } });
    }
    const countScope = { ...scope, chatId: "onebot:group:count-budget" }, characterScope = { ...scope, chatId: "onebot:group:character-budget" };
    const longCharacterScope = { ...scope, chatId: "onebot:group:long-character-budget" };
    seedCandidates(countScope, 64, 100); seedCandidates(characterScope, 48, 500); seedCandidates(longCharacterScope, 24, 1000);
    for (const who of [countScope, characterScope, longCharacterScope]) {
      const material = source("我有另一台尚未完成部署的测试设备。", who); material.sender.id = "bob";
      const bounded = await extract(proposal(material, "另一位成员的测试设备尚未完成部署。",
        { basis: "ongoing", reason: "后续继续排查这台测试设备的部署条件。" }, { subjectId: "bob" }), material, who);
      assert.equal(bounded.operations.length, 0, "candidate count and text budgets stop growth without removing an older record");
    }
    assert(repo.memory(actor(longCharacterScope), { action: "search", mode: "history", status: "pending" }).items.every(item => item.preview.length < 1000),
      "the long-record budget exercises truncated host previews rather than full candidate content");

    const editedScope = { ...scope, chatId: "onebot:group:manually-edited" };
    const editedSource = source("我有一台临时测试设备，还没有完成部署。", editedScope);
    const editedFact = { subjectId: "alice", facet: "test_device", value: "deployment_incomplete", conditions: [], assertion: "self" };
    const editProposal = material => proposal(material, "阿明的测试设备尚未完成部署。",
      { basis: "ongoing", reason: "后续继续处理这台测试设备的部署问题。" }, { fact: editedFact });
    const editedId = commit(await extract(editProposal(editedSource), editedSource, editedScope), editedScope)[0].id;
    const priorEdit = read(editedId, editedScope);
    repo.memory({ ...actor(editedScope), id: "user:memory-editor" }, { action: "revise", id: editedId, expectedRevision: priorEdit.revision,
      changeType: "edit", requestKey: "manual-review", patch: { attributes: { ...priorEdit.attributes, note: "已人工确认需要暂时保留。" } } });
    assert.equal(retention.protected(read(editedId, editedScope)), true, "a user's manual revision protects a previously automatic candidate");
    const anotherSource = source("测试设备还是没有完成部署。", editedScope);
    commit(await extract(editProposal(anotherSource), anotherSource, editedScope), editedScope);
    assert.equal(read(editedId, editedScope).sources.length, 2);
    assert.equal(retention.protected(read(editedId, editedScope)), true, "merging later evidence must preserve manual protection after updatedBy returns to the plugin");
    const important = source("请记住，以后不要公开我的工作地址。", countScope);
    const importantId = commit(await extract(proposal(important, "阿明要求以后不要公开自己的工作地址。",
      { basis: "boundary", reason: "后续交流和内容分享必须遵守本人的隐私边界。" }, { kind: "preference", profileSection: "boundaries" }), important, countScope), countScope)[0].id;
    assert.equal(read(importantId, countScope).status, "active", "a full candidate queue cannot discard an explicit personal boundary");
    assert.equal(repo.memory(actor(countScope), { action: "search", mode: "history", status: "pending", limit: 100 }).items.length, 64,
      "admission limits do not silently delete or mutate old candidates");

    clock += 30 * 86400000;
    assert(current().some(item => item.id === protectedBoundary.id), "a rarely needed personal boundary stays valid without repeated recalls");
    assert(current().some(item => item.id === protectedRequest.id), "an explicit remember request is not silently expired like a candidate");
    console.log("Memory retention behavior: one-off progress rejected, generous classifications staged, paraphrased evidence merged, explicit/boundary/profile facts preserved, scoped count/text budgets, chat isolation and cancellation passed.");
  } finally {
    close(); db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith("openbot-memory-retention-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
