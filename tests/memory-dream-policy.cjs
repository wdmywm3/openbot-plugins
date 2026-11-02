"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const dream = require("../plugins/memory/unified-dream.cjs"), { candidates } = require("../plugins/memory/unified-candidates.cjs");
const prompts = require("../plugins/memory/unified-dream-prompts.cjs"), peer = require("../plugins/memory/unified-peer.cjs");
const storage = require("../plugins/memory/storage.cjs"), root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-dream-policy-"));
const store = storage.open(root), scope = { channelId: "bot", chatId: "onebot:private:owner" };
const material = { id: "m", version: "v1", chatId: scope.chatId, direction: "in", source: "chat", sender: { id: "owner" }, content: "改到后天复查，每小时继续检查；有新资料时再查。" };
const evidence = [{ id: "m", quote: material.content }], when = Date.now() + 86400000;
const previous = { id: "existing", revision: 4, content: "检查项目进展", kind: "matter", subtype: "followup", progress: "waiting", status: "active", tier: "working",
  attributes: { nextReviewAt: when, reviewIntervalMinutes: 60, reviewOnChange: true, watchActivityId: "work-one", custom: "preserve" }, sources: [], nextOffset: null };
let current = previous, activityReads = [];
const ctx = { signal: new AbortController().signal, principal: {}, api: {
  memory: async () => ({ item: current }), activities: async input => { activityReads.push(input); if (input.id !== "work-one") throw Error("activity access denied"); return { activity: { id: input.id } }; },
} };
const update = async patch => (await dream.plan(ctx, scope, { facts: [], topics: [], updates: [{ id: current.id, revision: current.revision, content: "更新后进展", evidence, ...patch }] }, [material], [current])).operations[0].patch;
let passed = 0;
async function check(name, action) { await action(); passed++; console.log("Dream policy passed: " + name); }
(async () => {
  try {
    await check("延期保存时间、周期和新资料策略，并保留其他属性", async () => {
      const patch = await update({ nextReviewAt: when + 86400000, reviewIntervalMinutes: 120, reviewOnChange: true });
      assert.equal(patch.attributes.nextReviewAt, when + 86400000); assert.equal(patch.attributes.reviewIntervalMinutes, 120);
      assert.equal(patch.attributes.reviewOnChange, true); assert.equal(patch.attributes.custom, "preserve"); assert.equal(patch.progress, "waiting");
      assert.equal(activityReads.at(-1).id, "work-one");
    });
    await check("普通进度更新不会清掉已有复查设置", async () => { assert.deepEqual((await update({})).attributes, previous.attributes); });
    await check("null 和 false 明确清除指定策略", async () => {
      const patch = await update({ reviewIntervalMinutes: null, reviewOnChange: false, watchActivityId: null });
      assert.deepEqual(patch.attributes, { nextReviewAt: when, custom: "preserve" });
      assert.deepEqual((await update({ nextReviewAt: null })).attributes, { custom: "preserve" });
    });
    await check("完成、取消和关闭都会停止复查", async () => {
      for (const progress of ["completed", "canceled", "closed"]) assert.deepEqual((await update({ progress })).attributes, { custom: "preserve" });
    });
    await check("清除复查时间也会关闭已有后台事项", async () => {
      const { put, get } = require("../plugins/memory/unified-state.cjs");
      put(store, "plus:followup-link:existing", { chatId: scope.chatId, memoryId: "existing", activityId: "review-work" });
      current = { ...previous, attributes: {} }; const canceled = [];
      await require("../plugins/memory/unified-followup.cjs").sweep({ ...ctx, api: { ...ctx.api, activities: async input => { canceled.push(input); return {}; } } }, store, scope);
      assert.deepEqual(canceled.map(item => [item.action, item.id]), [["cancel", "review-work"]]);
      assert.equal(get(store, "plus:followup:existing").paused, true); current = previous;
    });
    await check("重开必须明确，不能恢复历史订阅", async () => {
      current = { ...previous, progress: "completed" };
      await assert.rejects(update({ progress: "active" }), /明确重新开启/);
      assert.deepEqual((await update({ progress: "active", reopen: true })).attributes, { custom: "preserve" });
      const reopened = await update({ progress: "active", reopen: true, nextReviewAt: when + 86400000 });
      assert.deepEqual(reopened.attributes, { custom: "preserve", nextReviewAt: when + 86400000 }); current = previous;
    });
    await check("无效状态、日期、周期和订阅不能写入", async () => {
      for (const patch of [{ progress: "maybe" }, { nextReviewAt: "tomorrow" }, { reviewIntervalMinutes: 4 }, { reviewIntervalMinutes: 43201 },
        { reviewOnChange: "true" }, { watchActivityId: 7 }, { watchActivityId: "inaccessible" }]) await assert.rejects(update(patch));
    });
    await check("平台通知、bot 自述、其他成员不能安排当前私聊事项", async () => {
      for (const other of [{ ...material, source: "task_report" }, { ...material, direction: "out" }, { ...material, sender: { id: "other" } }, { ...material, event: { type: "notice" } }])
        await assert.rejects(dream.plan(ctx, scope, { facts: [], topics: [], records: [{ content: "后天复查", kind: "matter", subtype: "followup", nextReviewAt: when, evidence }] }, [other], []), /原消息依据/);
    });
    await check("不将经历或未约定复查的目标默默变成后台任务", async () => {
      for (const kind of ["experience", "matter"]) assert.throws(() => dream.recordFields({ content: "了解新进展", kind, subtype: "goal", nextReviewAt: when, evidence }, [material], true, { scope }));
    });
    await check("具有不同周期的提案不会因正文相同而丢失策略", () => {
      const operations = [], before = [], add = candidates([], operations, before);
      add({ ...previous, attributes: { nextReviewAt: when, reviewIntervalMinutes: 60 } });
      add({ ...previous, attributes: { nextReviewAt: when, reviewIntervalMinutes: 120 } }); assert.equal(operations.length, 2);
    });
    await check("私聊偏好和风格必须属于本人，群聊不提取私人事项", async () => {
      const value = { facts: [{ kind: "preference", content: "喜欢茶", subjectId: "other", evidence }], topics: [], style: { values: { tone: "warm" }, evidence } };
      const own = await dream.plan(ctx, scope, value, [material], []); assert.equal(own.operations.length, 0); assert(own.style);
      const foreign = await dream.plan(ctx, scope, value, [{ ...material, sender: { id: "other" } }], []); assert.equal(foreign.style, null);
      const group = await dream.plan(ctx, { ...scope, chatId: "onebot:group:g" }, { ...value, records: [{ kind: "matter" }] }, [material], []);
      assert.equal(group.operations.length, 0); assert.equal(group.style, null);
    });
    await check("管理权限不冒充主人关系，真实聊天身份可更新关系", () => {
      const bound = { ...ctx, principal: { source: "lifecycle", ...scope, senderId: "owner", role: "owner" } };
      assert.equal(prompts.build(bound, store, scope).context.relationship, "unknown");
      bound.principal.source = "desktop"; assert.equal(prompts.build(bound, store, scope).context.relationship, "unknown");
      bound.principal.source = "channel"; const owner = prompts.build(bound, store, scope); assert.equal(owner.context.relationship, "owner"); assert.match(owner.system, /并行的事项/);
      bound.principal = { source: "lifecycle" }; assert.equal(prompts.build(bound, store, scope).context.relationship, "owner");
      peer.observe({ ...ctx, principal: { source: "channel", ...scope, senderId: "owner", role: "member" } }, store, scope);
      const member = prompts.build(bound, store, scope); assert.equal(member.context.relationship, "member"); assert.doesNotMatch(member.system, /宿主最近一次确认此私聊对话方为主人/);
      const group = prompts.build(bound, store, { ...scope, chatId: "onebot:group:g" }); assert.equal(group.context.chatType, "group"); assert.match(group.system, /不能把 A 的话记到 B 身上/);
    });
    console.log(`Dream policy: ${passed}/${passed} passed; scoped proposal conversion and real plugin state, host API doubles.`);
  } finally { storage.close(); assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith("openbot-dream-policy-")); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
