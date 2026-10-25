"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./butler.cjs");
const bv = "BV1234567890", rowKey = `bili:1:video:${bv}`;
const plan = async f => {
  assert.match(await f.invoke("biliscan", "new"), /扫描完成/);
  assert.match(await f.invoke("biliplan"), /方案已生成/);
};
const current = f => f.state.get(`bili:1:plan:${f.state.get("bili:1:currentPlan").id}`);

(async () => {
  const logged = fixture(), events = [];
  logged.ctx.api.log = async entry => events.push(structuredClone(entry));
  await plan(logged);
  assert.ok(!events.some(e => e.operation === "scan"), "no duplicate batch log alongside video records");
  assert.ok(events.some(e => e.reference === bv && e.status === "completed"));
  assert.ok(!events.some(e => e.operation === "apply"), "classification logs must not claim favorites were modified");
  await plan(logged);
  assert.ok(events.some(e => e.reference === bv && e.status === "reused"));
  const moved = fixture(); await plan(moved);
  current(moved).previewOnly = true;
  assert.match(await moved.invoke("biliapply"), /只分类测试方案/);
  assert.equal(moved.writes.length, 0, "preview-only plans never modify favorites");
  const original = structuredClone(moved.state.get(rowKey));
  assert.equal(original.bvid, bv); assert.equal(original.aid, "100");
  assert.equal(original.classification.status, "classified");
  assert.ok(original.classification.analyzedAt > 0);
  // Simulate a restart using a JSON roundtrip into a fresh runtime and storage.
  const restarted = fixture();
  for (const [key, value] of JSON.parse(JSON.stringify([...moved.state]))) restarted.state.set(key, value);
  restarted.memberships.get("10").delete("100"); restarted.memberships.get("20").add("100");
  restarted.ctx.config.scanFolders = ["20"];
  await plan(restarted);
  assert.equal(restarted.agents.length, 0, "moving a classified video and restarting must reuse it");
  assert.equal(current(restarted).operations.length, 0, "already in its target folder");
  assert.equal(restarted.state.get(rowKey).classification.analyzedAt, original.classification.analyzedAt);
  assert.equal([...restarted.state.keys()].filter(k => k.includes(":video:")).length, 1);

  const copied = fixture(); copied.memberships.get("20").add("100"); copied.ctx.config.scanFolders = ["10", "20"];
  await plan(copied); assert.equal(copied.agents.length, 1, "two folders, one analysis");
  assert.equal(current(copied).operations.length, 1);
  await plan(copied); assert.equal(copied.agents.length, 1, "rescanning does not reanalyze");
  copied.folders[1].media_count = 999;
  await plan(copied); assert.equal(copied.agents.length, 1, "folder counts are not classification inputs");

  const duplicate = fixture(), fetchDuplicate = duplicate.ctx.api.fetchJson;
  duplicate.ctx.api.fetchJson = async (...args) => {
    const response = await fetchDuplicate(...args);
    if (args[0].includes("/resource/list")) response.data.medias.push(...response.data.medias);
    return response;
  };
  await plan(duplicate); assert.equal(duplicate.agents.length, 1); assert.equal(current(duplicate).operations.length, 1);

  const legacy = fixture();
  legacy.state.set("bili:1:classification:100", { signature: original.classification.signature, assignment: original.classification.assignment });
  await plan(legacy); assert.equal(legacy.agents.length, 0, "migrate prior AID results without new model calls");
  assert.equal(legacy.state.get(rowKey).classification.migrated, true);

  const bad = fixture(); bad.ctx.api.runAgent = async () => ({ text: '{"assignments":[{"aid":"100","target":"20","confidence":2,"reason":"bad"}]}' });
  await bad.invoke("biliscan"); assert.match(await bad.invoke("biliplan"), /分类结果无效/);
  assert.equal(bad.state.get(rowKey).classification, undefined, "failed analysis must not be marked successful");
  const uncertain = fixture(); uncertain.ctx.api.runAgent = async () => ({ text: '{"assignments":[{"aid":"100","target":"","confidence":0.3,"reason":"需要正文"}]}' });
  await plan(uncertain); assert.equal(uncertain.state.get(rowKey).classification.status, "needs_review");
  assert.equal(current(uncertain).operations.length, 0);

  // Changing public evidence or rules reclassifies; ordinary folder movement does not.
  const changed = fixture(); await plan(changed);
  const fetchChanged = changed.ctx.api.fetchJson;
  changed.ctx.api.fetchJson = async (...args) => {
    const response = await fetchChanged(...args);
    if (args[0].includes("/resource/list")) response.data.medias[0].intro = "更新后的简介";
    return response;
  };
  await plan(changed); assert.equal(changed.agents.length, 2);
  changed.ctx.config.folderRules[0].description = "新的分类规则";
  await plan(changed); assert.equal(changed.agents.length, 3);
  // Another account must not inherit the first account's destination folder decision.
  changed.ctx.config.mainUid = "2"; changed.ctx.api.getSecret = async () => "user=2; bili_jct=two";
  await plan(changed); assert.equal(changed.agents.length, 4);
  assert.ok(changed.state.get(`bili:2:video:${bv}`));

  // Fail a later batch, then resume: the successful first batch stays reusable.
  const batches = fixture(), fetchBatch = batches.ctx.api.fetchJson;
  batches.ctx.api.fetchJson = async (...args) => {
    const response = await fetchBatch(...args);
    if (args[0].includes("/resource/list")) response.data.medias = Array.from({ length: 20 }, (_, i) => ({
      id: String(100 + i), bvid: `BV${String(i).padStart(10, "0")}`, type: 2, title: "标题".repeat(100), intro: "简介".repeat(250), upper: { name: "科普" },
    }));
    return response;
  };
  // Tags are local here so this tests batching independently of network caching.
  for (let i = 0; i < 20; i++) batches.state.set(`bili:1:video-tags:BV${String(i).padStart(10, "0")}`, { fetchedAt: Date.now(), tags: ["科普"] });
  let failSecond = true;
  batches.ctx.api.runAgent = async request => {
    batches.agents.push(request);
    if (request.taskId.endsWith("batch-1") && failSecond) { failSecond = false; throw new Error("provider offline"); }
    const group = request.externalContent.find(item => item.source === 'classification-input').content.videos;
    assert.ok(JSON.stringify(group).length <= 11000, "split large inputs without overriding model parameters");
    return { text: JSON.stringify({ assignments: group.map(v => ({ aid: v.aid, target: "20", confidence: .95, reason: "科普" })) }) };
  };
  await batches.invoke("biliscan"); assert.match(await batches.invoke("biliplan"), /provider offline/);
  assert.match(await batches.invoke("biliplan"), /方案已生成/);
  assert.equal(batches.agents.filter(r => r.taskId.endsWith("batch-0")).length, 1);
  assert.equal(current(batches).operations.length, 20);

  const multiple = fixture();
  multiple.folders.push({ id: 30, title: "AI" }); multiple.memberships.set("30", new Set());
  multiple.ctx.config.folderRules = []; multiple.ctx.config.organizeMode = "move";
  multiple.ctx.api.runAgent = async () => ({ text: JSON.stringify({ assignments: [{ aid: "100", targets: ["20", "30"], confidence: .95, reason: "两个独立用途" }] }) });
  await plan(multiple); assert.equal(current(multiple).operations.length, 2);
  const fetchMultiple = multiple.ctx.api.fetchJson;
  let failed = false;
  multiple.ctx.api.fetchJson = async (url, options) => {
    const form = new URLSearchParams(options.body);
    if (form.get("add_media_ids") === "30" && !failed) { failed = true; throw new Error("second target disconnected"); }
    if (form.has("del_media_ids")) assert.ok(multiple.memberships.get("30").has("100"), "all targets must be present before deleting source");
    return fetchMultiple(url, options);
  };
  assert.match(await multiple.invoke("biliapply"), /second target disconnected/);
  assert.ok(multiple.memberships.get("10").has("100"), "failed secondary target keeps source");
  assert.ok(multiple.memberships.get("20").has("100"));
  multiple.memberships.get("30").add("100"); // remote confirmation after unknown write
  assert.match(await multiple.invoke("biliapply"), /2\/2/);
  assert.ok(!multiple.memberships.get("10").has("100"));
  const keep = fixture(); keep.ctx.config.organizeMode = "move"; keep.ctx.config.folderRules = [];
  keep.ctx.api.runAgent = async () => ({ text: JSON.stringify({ assignments: [{ aid: "100", targets: ["10", "20"], confidence: .95, reason: "源夹也是目标" }] }) });
  await plan(keep); assert.match(await keep.invoke("biliapply"), /1\/1/);
  assert.ok(keep.memberships.get("10").has("100")); assert.ok(keep.memberships.get("20").has("100"));
  for (const targets of [["20", "20"], ["20", "999"]]) {
    const invalid = fixture(); invalid.ctx.api.runAgent = async () => ({ text: JSON.stringify({ assignments: [{ aid: "100", targets, confidence: .95, reason: "bad" }] }) });
    await invalid.invoke("biliscan"); assert.match(await invalid.invoke("biliplan"), /分类结果无效/);
    assert.equal(invalid.writes.length, 0);
  }

  // Browser-authenticated writes obtain CSRF in the host, never in the plugin.
  const browser = fixture(), fetchBrowser = browser.ctx.api.fetchJson;
  browser.ctx.config.accountMode = "browser"; browser.ctx.config.organizeMode = "move";
  browser.ctx.api.getSecret = async () => { throw new Error("unexpected secret access"); };
  browser.ctx.api.browserRequest = async request => {
    const uid = request.profile === "main" ? "1" : "2";
    assert.equal(request.identity.value, uid);
    if (request.method === "POST") {
      assert.equal(request.csrf.cookie, "bili_jct"); assert.equal(request.csrf.field, "csrf");
      assert.equal(request.form.csrf, undefined);
    }
    return fetchBrowser(request.url, { headers: { cookie: `user=${uid}` }, body: new URLSearchParams(request.form).toString() });
  };
  await plan(browser); assert.match(await browser.invoke("biliapply"), /1\/1/);
  assert.equal(browser.writes.length, 2); assert.ok(browser.memberships.get("20").has("100"));
  assert.ok(!browser.memberships.get("10").has("100"));
  const draft = await browser.invoke("bilidraft", `${bv} 写一句评论`);
  const id = /\/bilipost (draft-[A-Za-z0-9-]+)/.exec(draft)[1];
  await browser.invoke("bilipost", id); assert.equal(browser.writes.length, 3, "mock only: browser comment bridge");
  console.log("Video ledger: move/copy/restart reuse, legacy migration, duplicate IDs, invalid results, evidence/rule changes, account isolation, batch recovery and browser writes passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
