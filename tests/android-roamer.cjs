"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.join(__dirname, "../plugins/android-roamer");
const source = fs.readFileSync(path.join(root, "index.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
const load = () => { const sandbox = { module: { exports: {} } }; vm.runInNewContext(source, sandbox); return sandbox.module.exports; };
function fixture() {
  let state, fail = false, cached = false, discovery = true;
  const states = new Map();
  const calls = [], shares = [];
  const ctx = { command: { name: "roam" }, message: { id: "message-1", chatId: "private" }, args: "天文", config: { prohibitions: "不看直播" },
    api: {
      getAgentResources: async () => ["android"],
      getState: async (key, scope = "chat") => structuredClone(states.get(`${scope}:${key}`)),
      setState: async (key, value, scope = "chat") => { state = structuredClone(value); states.set(`${scope}:${key}`, state); },
      getAgentTask: async () => ({ status: fail ? "blocked" : "suspended" }),
      runAgent: async request => {
        calls.push(request);
        if (fail) throw new Error("设备操作结果未确认");
        return { resultId: "host-receipt", hasScreenshot: true, observedUrls: ["https://example.com/observed"], cached,
          text: JSON.stringify({ report: "看了一会儿天文视频", discovery: discovery ? { content: "看到了星图", wantScreenshot: true, url: "https://invented.example/" } : null }) };
      },
      proposeShare: async request => { assert.equal(state.status, "completed", "commit completion before delivery"); shares.push(request); return { shared: true }; },
    } };
  return { ctx, calls, shares, state: () => state, fail: v => { fail = v; }, cached: () => { cached = true; }, ordinary: () => { discovery = false; } };
}
(async () => {
  assert.ok(manifest.permissions.includes("resource:android"));
  assert.ok(!manifest.permissions.includes("push"));
  assert.ok(manifest.commands.every(c => c.scope === "private" && c.permission === "owner"));
  assert.equal(manifest.configSchema.properties.autonomyEnabled.default, false);
  assert.equal(manifest.background.export, "poll");
  const legacy = fixture(); delete legacy.ctx.api.getAgentResources;
  assert.match(await load().handle(legacy.ctx), /更新 OpenBot/); assert.equal(legacy.calls.length, 0);
  const unsupported = fixture(); unsupported.ctx.api.getAgentResources = async () => [];
  assert.match(await load().handle(unsupported.ctx), /版本及插件权限/); assert.equal(unsupported.calls.length, 0);
  const first = fixture();
  assert.match(await load().handle(first.ctx), /已向允许/);
  assert.equal(first.calls[0].resource.type, "android"); assert.equal(first.calls[0].resource.mode, "explore");
  assert.equal(first.calls[0].tools, undefined, "host supplies device tools");
  assert.match(first.calls[0].prompt, /不看直播/); assert.match(first.calls[0].prompt, /天文/);
  assert.equal(first.shares[0].resultId, "host-receipt"); assert.equal(first.shares[0].includeScreenshot, true);
  assert.equal(first.shares[0].url, undefined, "invented links are not shared");
  assert.equal(first.shares[0].image, undefined);
  first.ctx.command.name = "roamresume";
  assert.match(await load().handle(first.ctx), /没有需要继续/); assert.equal(first.calls.length, 1);
  const ordinary = fixture(); ordinary.ordinary(); await load().handle(ordinary.ctx); assert.equal(ordinary.shares.length, 0);
  const off = fixture(); off.ctx.config.shareDiscoveries = false; await load().handle(off.ctx);
  assert.equal(off.shares.length, 0); assert.equal(off.calls[0].resource.captureScreenshot, false);
  const cached = fixture(); cached.cached(); await load().handle(cached.ctx); assert.equal(cached.shares.length, 0);
  const interrupted = fixture(); interrupted.fail(true); await load().handle(interrupted.ctx);
  assert.equal(interrupted.state().status, "interrupted"); interrupted.ctx.command.name = "roamstatus";
  assert.match(await load().handle(interrupted.ctx), /结果未确认/);
  interrupted.fail(false); interrupted.ctx.command.name = "roamresume"; await load().handle(interrupted.ctx);
  assert.equal(interrupted.calls[0].taskId, interrupted.calls[1].taskId); assert.equal(interrupted.calls[0].prompt, interrupted.calls[1].prompt);
  const changed = fixture(); changed.fail(true); await load().handle(changed.ctx); changed.ctx.command.name = "roamresume";
  changed.ctx.config.prohibitions = "不看视频"; assert.match(await load().handle(changed.ctx), /设置已改变/); assert.equal(changed.calls.length, 1);
  const unknown = fixture(); unknown.ctx.api.proposeShare = async () => ({ shared: false, reason: "delivery_unknown" });
  assert.match(await load().handle(unknown.ctx), /不会自动重发/); assert.equal(unknown.state().status, "completed");
  const automatic = fixture(); automatic.ctx.config.autonomyEnabled = true; automatic.ordinary();
  const checks = []; let ready = false;
  automatic.ctx.api.considerAutonomy = async request => { checks.push(request); return { ready, opportunityId: "host-opportunity" }; };
  await load().poll(automatic.ctx); assert.equal(automatic.calls.length, 0, "no draw means no model call");
  ready = true; await load().poll(automatic.ctx);
  assert.equal(automatic.calls[0].resource.opportunityId, "host-opportunity"); assert.equal(automatic.calls[0].chatId, undefined);
  await load().poll(automatic.ctx); assert.equal(checks.at(-1).backoff, 2);
  await load().poll(automatic.ctx); assert.equal(checks.at(-1).backoff, 4);
  automatic.ctx.config.autonomyEnabled = false; const count = automatic.calls.length;
  await load().poll(automatic.ctx); assert.equal(automatic.calls.length, count);
  automatic.ctx.command.name = "roamstatus"; assert.ok(await load().handle(automatic.ctx), "owner can inspect the automatic report");
  console.log("android roamer: owner commands, plugin policy, shared Agent/resource/share API, evidence, abstention, resume and no replay passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
