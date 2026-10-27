"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { memoryDatabase } = require("./helpers/memory-database.cjs");
const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../plugins/bilibili-explorer/index.js"), "utf8"), sandbox);
(async () => {
  const now = Date.now(), calls = [], state = { seen: [], sharedToday: 0 };
  const ctx = { config: {}, message: { chatId: "a" }, api: {
    getState: async () => null, setState: async () => {},
    getShareTargets: async () => [{ chatId: "a", interests: "天文" }],
    getShareStatus: async () => ({ status: "sent" }),
    runAgent: async input => { calls.push(input); return { text: '{"share":true,"text":"这个实验把两种误差分别演示了。"}' }; },
    submitShare: async request => ({ accepted: true, chatId: request.chatId, submissionId: "receipt" }),
  } };
  const db = memoryDatabase(ctx);
  const put = (key, value) => db({ name: "bilibili-history", scope: "channel", action: "put", collection: "shares", key, expectedRevision: 0, value });
  await put("a:old", { chatId: "a", status: "sent", text: "太旧", at: now - 31 * 86400000 });
  await put("a:good", { chatId: "a", status: "sent", text: "这次把曝光时间放在一起比较了。", at: now - 3000 });
  await put("b:private", { chatId: "b", status: "sent", text: "另一个聊天的私人表达", at: now - 2000 });
  await put("a:unknown", { chatId: "a", status: "unknown", text: "未确认送达", at: now - 1000 });
  await put("a:pending", { chatId: "a", status: "accepted", text: "还在排队", at: now });
  const recent = await sandbox.recentBiliShareText(ctx, state, "a", now);
  assert.deepEqual(Array.from(recent, row => row.text), ["这次把曝光时间放在一起比较了。"]);
  state.seen.push({ id: "pending", chatId: "a", at: now, status: "accepted", submissionId: "receipt" });
  await sandbox.refreshBiliShares(ctx, state);
  const updated = (await db({ name: "bilibili-history", scope: "channel", action: "get", collection: "shares", key: "a:pending" })).record.value;
  assert.equal(updated.status, "sent"); assert.equal(updated.text, "还在排队", "receipt refresh preserves the actual draft text");
  await sandbox.shareBiliDiscovery(ctx, state, { id: "BV1234567890", part: 1, title: "误差演示", reason: "比较两种误差", url: "https://www.bilibili.com/video/BV1234567890" }, now);
  const material = calls[0].externalContent.find(item => item.source === "recent-confirmed-shares").content;
  assert.equal(material.length, 2); assert.ok(material.every(row => !row.text.includes("私人") && !row.text.includes("未确认")));
  assert.ok(!calls[0].prompt.includes("曝光时间"), "previous wording remains external material");
  assert.equal(state.seen.at(-1).text, "这个实验把两种误差分别演示了。");
  const isolated = { api: {} }; memoryDatabase(isolated);
  assert.equal((await sandbox.recentBiliShareText(isolated, { seen: [] }, "a", now)).length, 0, "another instance has no shared wording history");
  const offline = { api: {} };
  assert.equal((await sandbox.recentBiliShareText(offline, { seen: [{ chatId: "a", status: "sent", at: now, text: "旧版状态中的正文" }] }, "a", now)).length, 1);
  console.log("Bili share wording: confirmed receipts, persistent text, chat/instance isolation and bounded external references passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
