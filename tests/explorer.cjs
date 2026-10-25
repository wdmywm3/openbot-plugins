"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const code = fs.readFileSync(path.join(__dirname, "../plugins/bilibili-explorer/index.js"), "utf8");
let now = new Date(2026, 9, 20, 12).getTime();
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
function load() { const sandbox = { module: { exports: {} }, Date: Clock }; vm.runInNewContext(code, sandbox); return sandbox.module.exports; }
function fixture(extra = {}) {
  let state;
  const calls = [], pushes = [];
  const ctx = {
    message: { chatId: "onebot:group:123456" }, command: { name: "explore" },
    config: { targetChat: "onebot:group:123456", interests: "天文", mentionUserId: "100001", quietStartHour: 0, quietEndHour: 0, ...extra },
    api: {
      getState: async () => structuredClone(state),
      setState: async (key, value) => { state = structuredClone(value); },
      runAgent: async request => { calls.push(request); if (request.taskId.startsWith("bili-share-")) return { text: JSON.stringify({ share: true, text: "这段关于观测误差的解释值得看看" }) }; return { toolCalls: 2, observedUrls: ["https://www.bilibili.com/video/BV1234567890"], text: JSON.stringify({
        candidate: { url: "https://www.bilibili.com/video/BV1234567890", title: "天文入门", reason: "根据简介推荐", score: 90 },
        nextQuery: "星空", 
      }) }; },
      getShareTargets: async () => [{ chatId: "onebot:group:123456", interests: "天文" }],
      submitShare: async request => {
        assert.equal(state.seen.at(-1).status, "pending", "claim must precede delivery");
        pushes.push(request); return { accepted: true, chatId: request.chatId, submissionId: "receipt" };
      },
    },
  };
  return { ctx, calls, pushes, state: () => state };
}
(async () => {
  const empty = fixture(); empty.ctx.message.chatId = ""; empty.ctx.api.getShareTargets = async () => [];
  await load().poll(empty.ctx); assert.equal(empty.calls.length, 1, "browsing proceeds without a share target");
  assert.equal(empty.calls[0].chatId, undefined, "background activity has an independent context");
  assert.equal(empty.state().nextQuery, "星空"); assert.equal(empty.pushes.length, 0);
  const first = fixture(); await load().poll(first.ctx);
  assert.equal(first.pushes.length, 1);
  assert.equal(first.pushes[0].chatId, "onebot:group:123456");
  assert.equal(first.pushes[0].url, "https://www.bilibili.com/video/BV1234567890");
  assert.match(first.pushes[0].reminder, /notes\/BV1234567890-p1.md/);
  assert.equal(first.state().seen[0].status, "accepted");
  assert.equal(first.calls[1].context.recentMessages, 12);
  assert.equal(first.calls[0].maxToolCalls, undefined, "host controls rounds without a plugin tool quota");
  await load().poll(first.ctx); assert.equal(first.calls.length, 2, "restart retains deadline");
  now += 61 * 60000;
  await load().poll(first.ctx); assert.equal(first.pushes.length, 1, "duplicate video suppressed");
  const secondInstance = fixture(); await load().poll(secondInstance.ctx);
  assert.equal(secondInstance.pushes.length, 1, "instance states do not share history");
  const failure = fixture();
  failure.ctx.api.submitShare = async () => { throw new Error("connection lost"); };
  await load().poll(failure.ctx);
  assert.equal(failure.state().seen[0].status, "unknown");
  failure.ctx.api.submitShare = async () => { assert.fail("must not replay uncertain delivery"); };
  now += 61 * 60000; await load().poll(failure.ctx);
  const networkFailure = fixture(); networkFailure.ctx.api.submitShare = async () => ({ accepted: false });
  await load().poll(networkFailure.ctx); assert.equal(networkFailure.state().seen[0].status, "unknown");
  const disabled = fixture(); disabled.ctx.api.submitShare = async () => ({ skipped: true });
  await load().poll(disabled.ctx); assert.equal(disabled.state().sharedToday, 0);
  const noEvidence = fixture(); noEvidence.ctx.api.runAgent = async () => ({ toolCalls: 0, text: "{}" });
  await load().poll(noEvidence.ctx); assert.equal(noEvidence.pushes.length, 0);
  const invented = fixture(), original = invented.ctx.api.runAgent;
  invented.ctx.api.runAgent = async request => ({ ...await original(request), observedUrls: [] });
  await load().poll(invented.ctx); assert.equal(invented.pushes.length, 0, "invented links are not shared");
  const preamble = fixture(), generate = preamble.ctx.api.runAgent;
  preamble.ctx.api.runAgent = async request => {
    const result = await generate(request); return { ...result, text: `先查找候选。\n\`\`\`json\n${result.text}\n\`\`\`` };
  };
  await load().poll(preamble.ctx); assert.equal(preamble.pushes.length, 1, "tool-round preambles do not break final JSON");
  const capped = fixture({ dailyShareLimit: 0 }); await load().handle(capped.ctx); assert.equal(capped.calls.length, 1); assert.equal(capped.pushes.length, 0);
  const quiet = fixture({ quietStartHour: 0, quietEndHour: 23 }); await load().poll(quiet.ctx); assert.equal(quiet.calls.length, 1); assert.equal(quiet.pushes.length, 0);
  first.ctx.command.name = "explorelike"; first.ctx.args = "宇宙";
  await load().handle(first.ctx); assert.equal(first.state().feedback.at(-1).text, "宇宙");
  first.ctx.command.name = "explore"; first.ctx.message.chatId = "onebot:group:other";
  assert.doesNotMatch(await load().handle(first.ctx), /请在配置的推荐会话/);
  const decline = fixture(), base = decline.ctx.api.runAgent;
  decline.ctx.api.runAgent = request => request.taskId.startsWith("bili-share-") ? { text: '{"share":false}' } : base(request);
  await load().poll(decline.ctx); assert.equal(decline.pushes.length, 0, "the plugin may decline before submitting anything");
  const routed = fixture({ targetChat: "" }); routed.ctx.message.chatId = "";
  routed.ctx.api.getShareTargets = async () => [{ chatId: "first", interests: "种花" }, { chatId: "second", interests: "天文" }];
  await load().poll(routed.ctx); assert.equal(routed.pushes[0].chatId, "second"); assert.equal(routed.state().seen[0].chatId, "second");
  assert.match(routed.pushes[0].reminder, /shared\/files\/notes\//);
  const capabilities = await load().context({ api: { database: () => assert.fail("static memory hook must not read recent notes") } });
  assert.match(capabilities.content, /目录/); assert.match(capabilities.content, /public:true/);
  const malformed = fixture(), model = malformed.ctx.api.runAgent; let invalid = true;
  malformed.ctx.api.runAgent = request => invalid ? { toolCalls: 1, text: "bad output" } : model(request);
  await load().poll(malformed.ctx); assert.equal(malformed.state().agentTaskId, "", "completed malformed output must not lock the task cache");
  invalid = false; now += 61 * 60000; await load().poll(malformed.ctx); assert.equal(malformed.pushes.length, 1);
  console.log("explorer: configuration, budget, share proposals, deduplication, restart, uncertain outcome, quota, quiet hours, feedback and isolation passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
