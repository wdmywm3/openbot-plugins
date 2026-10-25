"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const code = fs.readFileSync(path.join(__dirname, "../plugins/bilibili-explorer/index.js"), "utf8");
const load = () => { const sandbox = { module: { exports: {} } }; vm.runInNewContext(code, sandbox); return sandbox.module.exports; };
function fixture() {
  const state = new Map(), writes = [], agents = [], pushes = [], reads = [];
  const folders = [{ id: 10, title: "待整理" }, { id: 20, title: "天文" }];
  let tags = [{ tag_name: "天文" }, { tag_name: "宇宙" }];
  const memberships = new Map([["10", new Set(["100"])], ["20", new Set()]]);
  let wrongAccount = false, failWrite = false;
  const ctx = { config: { mainUid: "1", browseUid: "2", scanFolders: ["10"],
    folderRules: [{ folderId: "20", description: "天文" }], commentMode: "draft", dailyCommentLimit: 1 },
    message: { chatId: "onebot:private:99" }, command: {}, args: "",
    api: {
      getSecret: async key => key === "bilibiliMainCookie" ? "user=1; bili_jct=secret-one" : "user=2; bili_jct=secret-two",
      getState: async key => structuredClone(state.get(key)),
      setState: async (key, value) => { state.set(key, structuredClone(value)); },
      updateState: async (key, reducer) => { const value = reducer(structuredClone(state.get(key))); state.set(key, structuredClone(value)); return structuredClone(value); },
      sleep: async () => {},
      push: async (chatId, blocks) => { pushes.push({ chatId, blocks }); return { id: "sent" }; },
      runAgent: async request => {
        agents.push(request);
        assert.ok(!/secret-one|secret-two|bili_jct/.test(JSON.stringify(request)));
        return { text: request.taskId.includes("draft-") ? "这个天文主题挺有意思。" : JSON.stringify({ assignments: [{ aid: "100", target: "20", confidence: .95, reason: "天文视频" }] }) };
      },
      fetchJson: async (url, options) => {
        reads.push(url);
        const parsed = new URL(url), q = parsed.searchParams, p = parsed.pathname;
        const uid = options.headers.cookie.includes("user=1") ? "1" : "2";
        if (p.endsWith("/nav")) return { code: 0, data: { isLogin: true, mid: wrongAccount ? "999" : uid } };
        if (p.endsWith("/list-all")) return { code: 0, data: { list: folders } };
        if (p.endsWith("/archive/tags")) {
          assert.equal(q.get("bvid"), "BV1234567890");
          return { code: 0, data: tags };
        }
        if (p.endsWith("/resource/list")) return { code: 0, data: { has_more: false, medias: [...memberships.get(q.get("media_id"))].map(id => ({
          id, bvid: "BV1234567890", type: 2, title: "天文入门", intro: "宇宙", upper: { name: "科普" },
        })) } };
        if (p.endsWith("/resource/deal")) {
          assert.equal(uid, "1", "favorites use main account only");
          writes.push(url);
          if (failWrite) throw new Error("network disconnected");
          const body = new URLSearchParams(options.body);
          if (body.has("add_media_ids")) memberships.get(body.get("add_media_ids")).add(body.get("rid"));
          if (body.has("del_media_ids")) {
            assert.ok(memberships.get("20").has(body.get("rid")), "copy must be confirmed before removal");
            memberships.get(body.get("del_media_ids")).delete(body.get("rid"));
          }
          return { code: 0, data: {} };
        }
        if (p.endsWith("/view")) return { code: 0, data: { aid: 100, title: "天文" } };
        if (p.endsWith("/reply/add")) { assert.equal(uid, "2"); writes.push(url); return { code: 0, data: { rpid: "123" } }; }
        throw new Error(`unexpected request ${url}`);
      },
    } };
  const invoke = async (name, args = "") => { ctx.command.name = name; ctx.args = args; return load().handle(ctx); };
  return { ctx, invoke, state, memberships, writes, agents, pushes, reads, folders, tags: value => { tags = value; }, wrong: value => { wrongAccount = value; }, fail: value => { failWrite = value; } };
}
module.exports = { fixture };
if (require.main === module) (async () => {
  const ruleSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugins/bilibili-explorer/plugin.json"), "utf8")).extensions["com.openbot"].configSchema.properties.folderRules;
  assert.equal(ruleSchema.items.type, "object");
  assert.deepEqual(ruleSchema.items.required, ["folderId", "description"]);
  assert.equal(ruleSchema.items.properties.folderId.type, "string");
  for (const rules of ["oops", ["20"], [{ folderId: "20", description: " " }], [{ folderId: "0", description: "天文" }],
    [{ folderId: 9007199254740992, description: "天文" }], [{ folderId: "20", description: "天文" }, { folderId: "20", description: "宇宙" }]]) {
    const invalid = fixture(); invalid.ctx.config.folderRules = rules;
    await invalid.invoke("biliscan");
    assert.match(await invalid.invoke("biliplan"), /规则/); assert.equal(invalid.agents.length, 0); assert.equal(invalid.writes.length, 0);
  }
  const browser = fixture();
  browser.ctx.config.accountMode = "browser";
  const browserCalls = [];
  browser.ctx.api.getSecret = async () => { throw new Error("browser mode must not read cookie secrets"); };
  browser.ctx.api.browserRequest = async request => {
    browserCalls.push(request);
    assert.equal(request.profile, "main");
    assert.equal(request.identity.cookie, "DedeUserID");
    assert.equal(request.identity.value, "1");
    assert.equal(request.cookie, undefined);
    if (request.url.includes("/nav")) return { code: 0, data: { isLogin: true, mid: 1 } };
    if (request.url.includes("/list-all")) return { code: 0, data: { list: [{ id: 10, title: "同名" }, { id: 20, title: "同名" }] } };
    throw new Error("unexpected browser request");
  };
  assert.match(await browser.invoke("bilifolders"), /同名/);
  assert.equal(browserCalls.length, 2);
  browser.ctx.api.browserRequest = async () => ({ code: 0, data: { isLogin: true, mid: 999 } });
  assert.match(await browser.invoke("bilifolders"), /UID/);
  const f = fixture();
  f.wrong(true); assert.match(await f.invoke("biliscan"), /UID/); assert.equal(f.state.size, 0);
  f.wrong(false); assert.match(await f.invoke("biliscan"), /扫描完成/);
  assert.match(await f.invoke("biliplan"), /方案已生成/);
  assert.match(JSON.stringify(f.agents[0].externalContent), /"tags":\["天文","宇宙"\]/);
  assert.match(JSON.stringify(f.agents[0].externalContent), /"folders":.*"title":"待整理".*"title":"天文"/);
  assert.match(JSON.stringify(f.agents[0].externalContent), /"title":"天文入门","intro":"宇宙"/);
  assert.doesNotMatch(f.agents[0].prompt, /天文入门/, "video metadata cannot become task instructions");
  assert.match(await f.invoke("bilipreview"), /天文入门/);
  f.ctx.config.organizeMode = "move";
  assert.match(await f.invoke("biliapply"), /1\/1/);
  assert.ok(f.memberships.get("20").has("100")); assert.ok(!f.memberships.get("10").has("100"));
  const count = f.writes.length; await f.invoke("biliapply"); assert.equal(f.writes.length, count);
  const draft = await f.invoke("bilidraft", "BV1234567890 写一句评论"), id = /\/bilipost (draft-[A-Za-z0-9-]+)/.exec(draft)[1];
  await f.invoke("bilipost", id); const sent = f.writes.length;
  assert.match(await f.invoke("bilipost", id), /已发送/); assert.equal(f.writes.length, sent);
  f.ctx.message.chatId = "onebot:group:99"; assert.match(await f.invoke("biliscan"), /主人私聊/);

  const g = fixture(); await g.invoke("biliscan"); await g.invoke("biliplan");
  g.fail(true); assert.match(await g.invoke("biliapply"), /disconnected/);
  g.fail(false); assert.match(await g.invoke("biliapply"), /结果不明/); assert.equal(g.writes.length, 1);
  g.memberships.get("20").add("100"); assert.match(await g.invoke("biliapply"), /1\/1/); assert.equal(g.writes.length, 1);
  const h = fixture(); h.ctx.config.commentMode = "off";
  assert.match(await h.invoke("bilidraft", "BV1234567890 hi"), /开启/); assert.equal(h.agents.length, 0);
  const automatic = fixture();
  automatic.ctx.config.autoOrganize = true; automatic.ctx.config.organizeChat = "onebot:private:99";
  for (let round = 0; round < 5; round++) await load().poll(automatic.ctx);
  assert.equal(automatic.writes.length, 1, "automatic scan/plan/apply runs once then waits for its schedule");
  assert.equal(automatic.pushes.length, 1);
  assert.equal(automatic.pushes[0].chatId, "onebot:private:99");
  assert.ok(automatic.memberships.get("10").has("100"), "default copy preserves the original collection");
  const interrupted = fixture(); await interrupted.invoke("biliscan");
  const persist = interrupted.ctx.api.setState;
  let failCache = true;
  interrupted.ctx.api.setState = async (key, value) => {
    await persist(key, value);
    if (failCache && key.endsWith("video:BV1234567890") && value.classification) { failCache = false; throw new Error("crash after cache write"); }
  };
  assert.match(await interrupted.invoke("biliplan"), /crash/);
  assert.match(await interrupted.invoke("biliplan"), /方案已生成/);
  assert.equal(interrupted.agents.length, 1, "a resumed page reuses the saved batch result without calling the model");
  const classifiedCalls = interrupted.agents.length;
  await interrupted.invoke("biliscan", "new"); await interrupted.invoke("biliplan");
  assert.equal(interrupted.agents.length, classifiedCalls, "unchanged videos reuse the classification across scans");
  assert.equal(interrupted.reads.filter(url => url.includes("/archive/tags")).length, 1, "tag cache avoids requests across restarts and scans");

  const inferred = fixture(); inferred.ctx.config.folderRules = [];
  await inferred.invoke("biliscan"); assert.match(await inferred.invoke("biliplan"), /方案已生成/);
  assert.match(JSON.stringify(inferred.agents[0].externalContent), /"targets":\["10","20"\]/);
  assert.match(await inferred.invoke("bilipreview"), /待整理 → 天文/);
  inferred.folders[1].title = "游戏";
  assert.match(await inferred.invoke("biliapply"), /收藏夹或分类规则已变化/);
  assert.equal(inferred.writes.length, 0);
  await inferred.invoke("biliscan", "new"); await inferred.invoke("biliplan");
  assert.equal(inferred.agents.length, 2, "folder rename invalidates prior classification");

  const refreshed = fixture(); await refreshed.invoke("biliscan"); await refreshed.invoke("biliplan");
  refreshed.tags([{ tag_name: "游戏" }]);
  refreshed.state.get("bili:1:video-tags:BV1234567890").fetchedAt = 0;
  await refreshed.invoke("biliscan", "new"); await refreshed.invoke("biliplan");
  assert.equal(refreshed.agents.length, 2, "changed tags invalidate classification");
  assert.match(JSON.stringify(refreshed.agents[1].externalContent), /"tags":\["游戏"\]/);

  const uncertain = fixture();
  uncertain.ctx.api.runAgent = async () => ({ text: JSON.stringify({ assignments: [{ aid: "100", target: "", confidence: .3, reason: "标题与标签冲突" }] }) });
  await uncertain.invoke("biliscan"); assert.match(await uncertain.invoke("biliplan"), /1 项待确认/);
  assert.match(await uncertain.invoke("bilipreview"), /待确认：标题与标签冲突/);
  await uncertain.invoke("biliapply"); assert.equal(uncertain.writes.length, 0);

  const missing = fixture(); missing.tags({ unexpected: true });
  await missing.invoke("biliscan"); assert.match(await missing.invoke("biliplan"), /标签返回格式无效/);
  assert.equal(missing.agents.length, 0, "missing tag evidence must not be silently classified as an empty list");
  missing.tags([]); assert.match(await missing.invoke("biliplan"), /方案已生成/);
  assert.match(JSON.stringify(missing.agents[0].externalContent), /"tags":\[\]/);

  for (const assignments of [[], [{ aid: "100", target: "999", confidence: .99 }]]) {
    const invalid = fixture();
    invalid.ctx.api.runAgent = async () => ({ text: JSON.stringify({ assignments }) });
    await invalid.invoke("biliscan"); assert.match(await invalid.invoke("biliplan"), /分类结果/);
    assert.equal(invalid.writes.length, 0);
  }
  console.log("Bilibili butler: account identity, scan/plan/apply, private scope, copy-before-remove, unknown outcomes, drafts and duplicate prevention passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
