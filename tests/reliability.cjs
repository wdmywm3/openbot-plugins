"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const load = id => { const module = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../plugins", id, "index.js"), "utf8"), { module }); return module.exports; };
const clone = value => value === undefined ? value : structuredClone(value);
function stateApi(initial = {}) {
  const state = new Map(Object.entries(initial)), reads = [], writes = [];
  return { state, reads, writes, api: {
    getState: async key => { reads.push(key); return clone(state.get(key)); },
    setState: async (key, value) => { writes.push(key); state.set(key, clone(value)); return value; },
    updateState: async (key, update) => { const value = update(clone(state.get(key))); writes.push(key); state.set(key, clone(value)); return clone(value); },
  } };
}
(async () => {
  const checkin = load("daily-checkin"), sign = stateApi();
  const ctx = id => ({ command: { name: "checkin" }, message: { sender: { id, name: id } }, principal: { senderId: id }, config: { minPoints: 10, maxPoints: 10 }, api: sign.api });
  const same = await Promise.all(Array.from({ length: 20 }, () => checkin.handle(ctx("same"))));
  assert.equal(sign.state.get("checkin:user:same").points, 10); assert.equal(same.filter(value => value.text.includes("签到成功")).length, 1);
  await Promise.all(Array.from({ length: 40 }, (_, n) => checkin.handle(ctx(`u${n}`))));
  assert.equal([...sign.state.keys()].filter(key => key.startsWith("checkin:user:")).length, 41);
  const before = sign.reads.filter(key => key === "checkins").length; await checkin.handle(ctx("same"));
  assert.equal(sign.reads.filter(key => key === "checkins").length, before, "migrated users no longer load the old full-chat map");
  assert.equal(sign.writes.includes("checkins"), false); assert.equal(sign.state.get("checkin:ranking").length, 20);
  const legacy = stateApi({ checkins: { old: { userId: "old", name: "Old", day: 0, points: 100, streak: 2 } } });
  await checkin.handle({ ...ctx("old"), api: legacy.api }); assert.equal(legacy.state.get("checkin:user:old").points, 110);
  assert.equal(legacy.state.get("checkins").old.points, 100, "legacy data is preserved");

  const dice = load("dice-maiden"), rolls = stateApi();
  await Promise.all(Array.from({ length: 40 }, () => dice.handle({ command: { name: "roll" }, args: "1d6", config: {}, api: rolls.api })));
  assert.equal(rolls.state.get("stats").commands, 40); assert.equal(rolls.state.get("stats").dice, 40);
  let external = 0;
  const official = { ...rolls.api, getCapabilities: async () => ({ platform: "qqbot", groupMemberPrivateMessage: false, groupMemberList: false }), callNapCat: async () => { external++; } };
  assert.match(JSON.stringify(await dice.handle({ command: { name: "rh" }, args: "1d6", message: { chatId: "onebot:group:OPEN_ID-a_b" }, config: {}, api: official })), /私聊中/);
  const random = load("random-toolbox");
  assert.match((await random.handle({ command: { name: "pickmember" }, principal: { groupId: "OPEN_ID" }, api: official })).text, /不支持/);
  assert.ok((await random.handle({ command: { name: "coin" }, api: official })).text); assert.equal(external, 0);

  const monitor = load("content-monitor");
  function monitoring(result) {
    const f = stateApi({ cursors: { s: { initializedAt: 1, seenIds: ["old"], pendingDeliveries: {}, lastError: "old outage" } } });
    let calls = 0, current = result;
    const ctx = { config: { requestIntervalMs: 0, subscriptions: [{ id: "s", provider: "rss", source: "https://fixture.invalid/feed", targetChatIds: ["onebot:group:OPEN_ID-a_b"] }] },
      api: { ...f.api, fetchText: async () => '<rss><item><guid>new</guid><title>Fresh</title><link>https://fixture.invalid/new</link></item></rss>',
        push: async () => { calls++; if (current instanceof Error) throw current; return current; } } };
    return { ...f, ctx, calls: () => calls, result: value => { current = value; }, cursor: () => f.state.get("cursors").s };
  }
  for (const result of [{ skipped: true, reason: "disabled_for_chat" }, { networkStatus: "canceled" }]) {
    const f = monitoring(result); assert.equal((await monitor.poll(f.ctx)).pushed, 0);
    assert.equal(f.cursor().seenIds.includes("new"), false); assert.equal(Object.keys(f.cursor().pendingDeliveries).length, 1);
    f.result({ networkStatus: "sent" }); await monitor.handle({ ...f.ctx, command: { name: "monitorcheck" } });
    assert.equal(f.calls(), 2); assert.equal(f.cursor().seenIds.includes("new"), true); assert.equal(f.cursor().lastError, "");
  }
  for (const result of [{ networkStatus: "pending" }, { networkStatus: "failed" }, new Error("connection lost after send")]) {
    const f = monitoring(result); assert.equal((await monitor.poll(f.ctx)).pushed, 0);
    await monitor.handle({ ...f.ctx, command: { name: "monitorcheck" } }); assert.equal(f.calls(), 1, "unknown delivery never automatically repeats");
    assert.match((await monitor.handle(f.ctx)).text, /monitorresolve/);
    const event = Object.keys(f.cursor().pendingDeliveries)[0];
    await monitor.handle({ ...f.ctx, command: { name: "monitorresolve" }, args: `s ${encodeURIComponent(event)} onebot:group:OPEN_ID-a_b delivered` });
    await monitor.handle({ ...f.ctx, command: { name: "monitorcheck" } }); assert.equal(f.calls(), 1); assert.equal(f.cursor().seenIds.includes("new"), true);
  }
  const retry = monitoring({ networkStatus: "pending" }); await monitor.poll(retry.ctx);
  const retryKey = Object.keys(retry.cursor().pendingDeliveries)[0];
  await monitor.handle({ ...retry.ctx, command: { name: "monitorresolve" }, args: `s ${encodeURIComponent(retryKey)} onebot:group:OPEN_ID-a_b retry` });
  retry.result({ networkStatus: "sent" }); await monitor.handle({ ...retry.ctx, command: { name: "monitorcheck" } }); assert.equal(retry.calls(), 2);
  const partial = monitoring({ networkStatus: "sent" }), recipients = []; let refuseSecond = true;
  partial.ctx.config.subscriptions[0].targetChatIds.push("onebot:group:123");
  partial.ctx.api.push = async chat => { recipients.push(chat); return refuseSecond && chat.endsWith(":123") ? { skipped: true } : { networkStatus: "sent" }; };
  await monitor.poll(partial.ctx); refuseSecond = false;
  await monitor.handle({ ...partial.ctx, command: { name: "monitorcheck" } });
  assert.deepEqual(recipients, ["onebot:group:OPEN_ID-a_b", "onebot:group:123", "onebot:group:123"], "retry only the destination that was not sent");
  console.log("Plugin reliability: concurrent check-ins/stats, bounded state, legacy migration, QQ capability gates, official targets, delivery recovery and uncertain-send fences passed (memory mocks)");
})().catch(error => { console.error(error); process.exitCode = 1; });
