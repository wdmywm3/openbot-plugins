"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const code = fs.readFileSync(path.join(__dirname, "../plugins/bilibili-explorer/index.js"), "utf8");
const load = () => { const sandbox = { module: { exports: {} } }; vm.runInNewContext(code, sandbox); return sandbox.module.exports; };
function fixture() {
  const state = new Map(), writes = [], agents = [], pushes = [];
  const memberships = new Map([["10", new Set(["100"])], ["20", new Set()]]);
  let wrongAccount = false, failWrite = false;
  const ctx = { config: { mainUid: "1", browseUid: "2", scanFolders: ["10"],
    folderRules: [{ folderId: "20", description: "天文" }], commentMode: "draft", dailyCommentLimit: 1 },
    message: { chatId: "onebot:private:99" }, command: {}, args: "",
    api: {
      getSecret: async key => key === "bilibiliMainCookie" ? "user=1; bili_jct=secret-one" : "user=2; bili_jct=secret-two",
      getState: async key => structuredClone(state.get(key)),
      setState: async (key, value) => { state.set(key, structuredClone(value)); },
      sleep: async () => {},
      push: async (chatId, blocks) => { pushes.push({ chatId, blocks }); return { id: "sent" }; },
      runAgent: async request => {
        agents.push(request);
        assert.ok(!/secret-one|secret-two|bili_jct/.test(request.prompt));
        return { text: request.taskId.startsWith("draft-") ? "这个天文主题挺有意思。" : JSON.stringify({ assignments: [{ aid: "100", target: "20", confidence: .95, reason: "天文视频" }] }) };
      },
      fetchJson: async (url, options) => {
        const parsed = new URL(url), q = parsed.searchParams, p = parsed.pathname;
        const uid = options.headers.cookie.includes("user=1") ? "1" : "2";
        if (p.endsWith("/nav")) return { code: 0, data: { isLogin: true, mid: wrongAccount ? "999" : uid } };
        if (p.endsWith("/list-all")) return { code: 0, data: { list: [{ id: 10, title: "待整理" }, { id: 20, title: "天文" }] } };
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
  return { ctx, invoke, state, memberships, writes, agents, pushes, wrong: value => { wrongAccount = value; }, fail: value => { failWrite = value; } };
}
(async () => {
  const f = fixture();
  f.wrong(true); assert.match(await f.invoke("biliscan"), /UID/); assert.equal(f.state.size, 0);
  f.wrong(false); assert.match(await f.invoke("biliscan"), /扫描完成/);
  assert.match(await f.invoke("biliplan"), /方案已生成/);
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
    if (failCache && key.endsWith("classification:100")) { failCache = false; throw new Error("crash after cache write"); }
  };
  assert.match(await interrupted.invoke("biliplan"), /crash/);
  assert.match(await interrupted.invoke("biliplan"), /方案已生成/);
  assert.equal(interrupted.agents[0].taskId, interrupted.agents[1].taskId);
  assert.equal(interrupted.agents[0].prompt, interrupted.agents[1].prompt, "a resumed page uses its frozen input");
  const classifiedCalls = interrupted.agents.length;
  await interrupted.invoke("biliscan", "new"); await interrupted.invoke("biliplan");
  assert.equal(interrupted.agents.length, classifiedCalls, "unchanged videos reuse the classification across scans");
  console.log("Bilibili butler: account identity, scan/plan/apply, private scope, copy-before-remove, unknown outcomes, drafts and duplicate prevention passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
