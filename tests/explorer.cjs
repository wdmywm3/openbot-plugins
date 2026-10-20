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
      runAgent: async request => { calls.push(request); return { toolCalls: 2, observedUrls: ["https://www.bilibili.com/video/BV1234567890"], text: JSON.stringify({
        candidate: { url: "https://www.bilibili.com/video/BV1234567890", title: "天文入门", reason: "根据简介推荐", score: 90 },
        nextQuery: "星空", 
      }) }; },
      push: async (chat, blocks) => {
        assert.equal(state.seen.at(-1).status, "pending", "claim must precede delivery");
        pushes.push({ chat, blocks }); return { id: "sent" };
      },
    },
  };
  return { ctx, calls, pushes, state: () => state };
}
(async () => {
  const empty = fixture({ targetChat: "" }); await load().poll(empty.ctx); assert.equal(empty.calls.length, 0);
  const first = fixture(); await load().poll(first.ctx);
  assert.equal(first.pushes.length, 1);
  assert.equal(first.pushes[0].blocks[0].target, "100001");
  assert.equal(first.state().seen[0].status, "sent");
  assert.equal(first.calls[0].maxToolCalls, 8);
  await load().poll(first.ctx); assert.equal(first.calls.length, 1, "restart retains deadline");
  now += 61 * 60000;
  await load().poll(first.ctx); assert.equal(first.pushes.length, 1, "duplicate video suppressed");
  const secondInstance = fixture(); await load().poll(secondInstance.ctx);
  assert.equal(secondInstance.pushes.length, 1, "instance states do not share history");
  const failure = fixture();
  failure.ctx.api.push = async () => { throw new Error("connection lost"); };
  await load().poll(failure.ctx);
  assert.equal(failure.state().seen[0].status, "unknown");
  failure.ctx.api.push = async () => { assert.fail("must not replay uncertain delivery"); };
  now += 61 * 60000; await load().poll(failure.ctx);
  const networkFailure = fixture(); networkFailure.ctx.api.push = async () => ({ networkStatus: "error" });
  await load().poll(networkFailure.ctx); assert.equal(networkFailure.state().seen[0].status, "unknown");
  const disabled = fixture(); disabled.ctx.api.push = async () => ({ skipped: true });
  await load().poll(disabled.ctx); assert.equal(disabled.state().sharedToday, 0);
  const noEvidence = fixture(); noEvidence.ctx.api.runAgent = async () => ({ toolCalls: 0, text: "{}" });
  await load().poll(noEvidence.ctx); assert.equal(noEvidence.pushes.length, 0);
  const invented = fixture(), original = invented.ctx.api.runAgent;
  invented.ctx.api.runAgent = async request => ({ ...await original(request), observedUrls: [] });
  await load().poll(invented.ctx); assert.equal(invented.pushes.length, 0, "invented links are not shared");
  const capped = fixture({ dailyShareLimit: 0 }); await load().handle(capped.ctx); assert.equal(capped.calls.length, 0);
  const quiet = fixture({ quietStartHour: 0, quietEndHour: 23 }); await load().poll(quiet.ctx); assert.equal(quiet.calls.length, 0);
  first.ctx.command.name = "explorelike"; first.ctx.args = "宇宙";
  await load().handle(first.ctx); assert.equal(first.state().feedback.at(-1).text, "宇宙");
  first.ctx.command.name = "explore"; first.ctx.message.chatId = "onebot:group:other";
  assert.match(await load().handle(first.ctx), /推荐会话/);
  console.log("explorer: configuration, budget, delivery, mention, deduplication, restart, uncertain outcome, quota, quiet hours, feedback and isolation passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
