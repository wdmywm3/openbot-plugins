"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { defaults, mockDatabase } = require("./image-studio-test-helpers.cjs");
let now = new Date(2026, 10, 7, 10, 5).getTime();
class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const sandbox = vm.createContext({ module: { exports: {} }, Date: FakeDate });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../plugins/image-studio/index.js"), "utf8") + "\nmodule.exports.testQuota = consumeQuota;", sandbox);
const { testQuota, readiness } = sandbox.module.exports;
const config = { ...defaults, provider: "openai-images", globalHourly: 100, globalDaily: 100, instanceHourlyDefault: 100, instanceDailyDefault: 100 };
function context(channelId, database, overrides = {}) {
  return { principal: { source: "channel", channelId }, config: { ...config, ...overrides },
    signal: new AbortController().signal, deadlineAt: now + 60000, api: { database } };
}

(async () => {
  const api = { listModels: async () => [], getSecret: async () => "" };
  const desktop = { principal: { source: "desktop", role: "owner" }, config, api };
  assert.equal((await readiness(desktop)).ready, false);
  api.getSecret = async () => "configured-key";
  assert.match((await readiness(desktop)).message, /选择画图模型/);
  desktop.config = { ...config, openaiImageModel: "gpt-image-2.6-sunburst" };
  assert.equal((await readiness(desktop)).ready, true);
  desktop.config = { ...config, provider: "codex" };
  assert.equal((await readiness(desktop)).ready, false);
  api.listModels = async () => [{ id: "login", provider: "codex", loginConfigured: true }];
  assert.equal((await readiness(desktop)).ready, true);

  let database = mockDatabase();
  let a = context("a", database, { instanceHourly: 1, globalHourly: 2 }), b = context("b", database, { globalHourly: 2 });
  await testQuota(a, a.config);
  await assert.rejects(testQuota(a, a.config), /实例.*每小时/);
  await testQuota(b, b.config);
  await assert.rejects(testQuota(b, b.config), /总每小时/);
  now += 3600000;
  a.deadlineAt = b.deadlineAt = now + 60000;
  await testQuota(a, a.config);

  database = mockDatabase();
  a = context("a", database, { instanceDaily: 1, globalDaily: 2 }); b = context("b", database, { globalDaily: 2 });
  await testQuota(a, a.config); await assert.rejects(testQuota(a, a.config), /实例.*每日/);
  await testQuota(b, b.config); await assert.rejects(testQuota(b, b.config), /总每日/);
  now += 24 * 3600000; a.deadlineAt = b.deadlineAt = now + 60000;
  await testQuota(a, a.config);

  database = mockDatabase();
  const requests = Array.from({ length: 25 }, (_, index) => {
    const ctx = context(`instance-${index}`, database, { globalHourly: 5 });
    return testQuota(ctx, ctx.config);
  });
  const results = await Promise.allSettled(requests);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 5, "concurrent instances share an atomic global counter");
  assert(results.filter(result => result.status === "rejected").every(result => /总每小时/.test(result.reason.message)));
  console.log("Image studio limits: required provider, per-instance and global hour/day quotas, reset and concurrent atomic admission passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
