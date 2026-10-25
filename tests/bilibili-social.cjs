"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const code = fs.readFileSync(path.join(__dirname, "../plugins/bilibili-explorer/index.js"), "utf8");
const BV = "BV1234567890";
function fixture() {
  let now = 1800000000000, failSend = false, failModel = false, discovery = false, visual = false;
  const states = new Map(), records = new Map(), files = new Map(), requests = [], posts = [], agents = [], media = [], peers = new Map();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const sandbox = { module: { exports: {} }, Date: Clock }; vm.runInNewContext(code, sandbox); const plugin = sandbox.module.exports;
  const ctx = { config: { browseUid: "2", mainUid: "1", commentMode: "auto", autoComment: true, autoReply: false,
    commentChat: "onebot:private:99", dailyCommentLimit: 10, commentIntervalMinutes: 1, likeEnabled: true, dailyLikeLimit: 20,
    messageMode: "auto", messageAllowedUids: [], dailyMessageLimit: 20, socialIntervalSeconds: 1 }, message: { chatId: "" },
    principal: { role: "owner", messageType: "private" }, api: {
      getSecret: async () => `user=${ctx.config.browseUid}; bili_jct=PRIVATE-COOKIE`,
      getState: async key => structuredClone(states.get(key)),
      setState: async (key, value) => { states.set(key, structuredClone(value)); },
      updateState: async (key, reducer) => { const value = reducer(structuredClone(states.get(key))); states.set(key, structuredClone(value)); return structuredClone(value); },
      database: async input => {
        const key = `${input.scope}:${input.collection}:${input.key}`, row = records.get(key);
        if (input.action === "get") return { record: structuredClone(row) || null };
        if (input.action === "put") {
          assert.equal(input.expectedRevision, row?.revision || 0);
          assert.ok(Buffer.byteLength(JSON.stringify(input.value)) <= 128 * 1024);
          const saved = { key: input.key, value: structuredClone(input.value), revision: (row?.revision || 0) + 1 };
          records.set(key, saved); return { record: saved };
        }
        return { records: [...records.entries()].filter(([key]) => key.startsWith(`${input.scope}:${input.collection}:`)).map(([,row]) => structuredClone(row)), nextCursor: null };
      },
      dataFiles: async input => { const key = `${input.scope}:${input.path}`; if (input.action === "write") { files.set(key, input.text); return { ok: true }; } return { text: files.get(key) || "" }; },
      getShareTargets: async () => [],
      runAgent: async input => {
        agents.push(structuredClone(input)); assert.ok(!JSON.stringify(input).includes("PRIVATE-COOKIE"));
        if (failModel && input.taskId.startsWith("bili-dm-")) throw Error("model interrupted");
        if (input.taskId.startsWith("explore-")) return { toolCalls: 1, observedUrls: [`https://www.bilibili.com/video/${BV}`], text: JSON.stringify({ candidate: discovery ? { url: `https://www.bilibili.com/video/${BV}`, title: "原理", reason: "检查原理", score: 90 } : null,
          inspect: discovery ? { bvid: BV, part: 1, question: "演示是否支持原理？" } : null }) };
        if (input.taskId.startsWith("video-")) return { text: JSON.stringify({ summary: "[0秒] 内容证据：样本条件影响演示。", needAudio: false, needVisual: visual && !input.taskId.endsWith("visual"), reason: "核对演示", evidence: [] }) };
        if (input.taskId.startsWith("discovery-read-")) return { text: '{"keep":true,"reason":"字幕与画面中的样本条件相符"}' };
        if (input.taskId.startsWith("bili-draft-")) return { text: "样本条件限制了结论范围。" };
        if (input.taskId.startsWith("bili-dm-")) return { text: '{"respond":true,"text":"收到，这个问题我再具体看看。"}' };
        return { text: '{"respond":true,"text":"样本条件影响了演示结果。"}' };
      },
      media: async input => { media.push(input); return { status: "completed", frames: [{ timestamp: input.start, mimeType: "image/png", data: "aGVsbG8=" }] }; },
      fetchJson: async (url, options = {}) => {
        const u = new URL(url), p = u.pathname, query = u.searchParams; requests.push({ url, options });
        if (p.endsWith("/nav")) return { code: 0, data: { isLogin: true, mid: ctx.config.browseUid } };
        if (p.endsWith("/view")) return { code: 0, data: { aid: "100", bvid: BV, title: "原理", desc: "公开简介", pages: [{ cid: 1, duration: 40 }] } };
        if (p.endsWith("/rcmd")) return { code: 0, data: { item: [{ bvid: BV, title: "原理" }] } };
        if (p.endsWith("/player/v2")) return { code: 0, data: { subtitle: { subtitles: [{ lan: "zh", subtitle_url: "https://subtitle.hdslb.com/test" }] } } };
        if (u.host === "subtitle.hdslb.com") return { body: [{ from: 0, to: 40, content: "样本条件影响了结果。" }] };
        if (p.endsWith("/panel/web")) return { code: 0, data: { packages: [
          { text: "免费", flags: { unlocked: true }, emote: [{ id: 1, text: "[微笑]", url: "http://i0.hdslb.com/a.png" }] },
          { text: "锁定", flags: { unlocked: false }, emote: [{ id: 2, text: "[付费]" }] },
        ] } };
        if (p.endsWith("/reply/reply")) return { code: 0, data: { root: { rpid: "500", content: { message: "原理讨论" } },
          replies: [{ rpid: "501", root: "500", content: { message: "样本条件如何？" } }], page: { count: 1 } } };
        if (p.endsWith("/fetch_session_msgs")) {
          const after = BigInt(query.get("begin_seqno") || 0), before = query.has("end_seqno") ? BigInt(query.get("end_seqno")) : 10n ** 30n;
          // The platform returns newest first within the exclusive lower/upper bounds.
          const all = (peers.get(query.get("talker_id")) || []).filter(m => BigInt(m.msg_seqno) > after && BigInt(m.msg_seqno) < before)
            .sort((a,b) => Number(BigInt(b.msg_seqno) - BigInt(a.msg_seqno)));
          return { code: 0, data: { messages: all.slice(0, 20), has_more: all.length > 20 ? 1 : 0 } };
        }
        if (p.endsWith("/get_sessions")) return { code: 0, data: { session_list: [...peers.keys()].map(uid => ({ talker_id: uid, session_type: 1, max_seqno: 1, session_ts: 10, unread_count: 1 })) } };
        if (options.method === "POST") {
          const form = Object.fromEntries(new URLSearchParams(options.body)); posts.push({ path: p, form, host: u.host });
          if (failSend) throw Error("network lost after remote acceptance");
          return { code: 0, data: { rpid_str: "90071992547409931", msg_key: 90071992547409932, msg_key_str: "90071992547409932" } };
        }
        throw Error(`Unexpected ${url}`);
      },
    } };
  const tool = (tool, input = {}, overrides = {}) => plugin.agentTool({ ...ctx, message: { chatId: "onebot:private:99" }, tool, input, ...overrides });
  const tick = (seconds = 61) => { now += seconds * 1000; };
  const incoming = (uid, seq, text = `message-${seq}`, extra = {}) => {
    const list = peers.get(uid) || []; list.push({ msg_key_str: String(seq), msg_seqno: seq, sender_uid: uid, receiver_id: ctx.config.browseUid,
      msg_type: 1, content: JSON.stringify({ content: text }), timestamp: now / 1000, ...extra }); peers.set(uid,list);
  };
  return { ctx, tool, poll: () => plugin.poll(ctx), tick, incoming, states, records, files, requests, posts, agents, media,
    discover: value => { discovery = value; }, visual: value => { visual = value; }, failSend: value => { failSend = value; }, failModel: value => { failModel = value; } };
}
module.exports = { fixture };
if (require.main === module) (async () => {
  const permissions = fixture();
  await assert.rejects(permissions.tool("like_video", { operationId: "a", bvid: BV, liked: true }, { principal: { role: "member", messageType: "private" } }), /主人/);
  await assert.rejects(permissions.tool("send_message", { operationId: "a", uid: "3", text: "x" }, { principal: { role: "owner", messageType: "group" } }), /主人/);
  permissions.ctx.config.likeEnabled = false; await assert.rejects(permissions.tool("like_video", { operationId: "a", bvid: BV, liked: true }), /开启/); assert.equal(permissions.posts.length, 0);
  const social = fixture();
  const liked = await social.tool("like_video", { operationId: "like-1", bvid: BV, liked: true }); assert.equal(liked.status, "accepted");
  await social.tool("like_video", { operationId: "like-1", bvid: BV, liked: true }); assert.equal(social.posts.length, 1);
  await assert.rejects(social.tool("like_video", { operationId: "like-1", bvid: BV, liked: false }), /不同/);
  social.tick(); await social.tool("like_comment", { operationId: "reply-like", bvid: BV, rpid: "501", liked: false });
  assert.equal(social.posts[1].form.rpid, "501"); assert.equal(social.posts[1].form.action, "0");
  const panel = await social.tool("emotes"); assert.deepEqual(Array.from(panel.items, item => item.token), ["[微笑]"]);
  assert.equal((await social.tool("emotes", { scene: "message" })).supported, false);
  social.records.set(`channel:notes:${BV}:p:1`, { revision: 1, key: `${BV}:p:1`, value: { summary: "PUBLIC_VIDEO_NOTE" } });
  social.records.set(`chat:notes:${BV}:p:1`, { revision: 1, key: `${BV}:p:1`, value: { summary: "PRIVATE_QQ_NOTE" } });
  const draft = await social.tool("draft_comment", { operationId: "draft-one", bvid: BV, intent: "指出样本条件", root: "500", parent: "501", emotes: ["[微笑]"] });
  assert.match(draft.text, /\[微笑\]/); assert.equal(social.posts.length, 2);
  const prompt = social.agents.find(r => r.taskId.startsWith("bili-draft-"));
  assert.equal(prompt.taskId, "bili-draft-2-draft-one");
  assert.match(JSON.stringify(prompt.externalContent), /PUBLIC_VIDEO_NOTE/); assert.doesNotMatch(JSON.stringify(prompt), /PRIVATE_QQ_NOTE/);
  await social.tool("post_comment", { draftId: draft.draftId }); await social.tool("post_comment", { draftId: draft.draftId });
  assert.equal(social.posts.length, 3); assert.equal(social.posts[2].form.root, "500"); assert.equal(social.posts[2].form.parent, "501");
  assert.equal((await social.tool("post_comment", { draftId: draft.draftId })).rpid, "90071992547409931");
  const unknown = fixture(); unknown.failSend(true);
  await assert.rejects(unknown.tool("send_message", { operationId: "dm-unknown", uid: "3", text: "你好" }), /network/);
  unknown.failSend(false); unknown.tick(601);
  assert.equal((await unknown.tool("send_message", { operationId: "dm-unknown", uid: "3", text: "你好" })).status, "unknown"); assert.equal(unknown.posts.length, 1);
  const dm = fixture(); await dm.tool("send_message", { operationId: "dm-ok", uid: "3", text: "你好" });
  assert.equal((await dm.tool("interaction_status", { operationId: "dm-ok" })).result.msgKey, "90071992547409932");
  const sent = dm.posts[0]; assert.equal(sent.host, "api.vc.bilibili.com"); assert.equal(sent.form["msg[receiver_id]"], "3"); assert.deepEqual(JSON.parse(sent.form["msg[content]"]), { content: "你好" });
  assert.equal(dm.states.get("bili:2:dm:3").history[0].text, "你好"); assert.equal(dm.states.has("bili:2:dm:4"), false);
  const switched = fixture();
  await switched.tool("draft_comment", { operationId: "same", bvid: BV, intent: "检查条件" });
  switched.ctx.config.browseUid = "5";
  await switched.tool("draft_comment", { operationId: "same", bvid: BV, intent: "检查条件" });
  assert.deepEqual(switched.agents.filter(r => r.taskId.startsWith("bili-draft-")).map(r => r.taskId), ["bili-draft-2-same", "bili-draft-5-same"]);
  for (const same of [false, true]) {
    const concurrent = fixture(); concurrent.ctx.config.dailyMessageLimit = 1;
    const results = await Promise.allSettled([concurrent.tool("send_message", { operationId: "a", uid: "3", text: "one" }), concurrent.tool("send_message", { operationId: same ? "a" : "b", uid: "3", text: same ? "one" : "two" })]);
    assert.equal(concurrent.posts.length, 1); assert.ok(results.some(r => r.status === "rejected"));
    concurrent.tick(601); if (same) assert.equal((await concurrent.tool("send_message", { operationId: "a", uid: "3", text: "one" })).status, "accepted");
    else await assert.rejects(concurrent.tool("send_message", { operationId: "b", uid: "3", text: "two" }), /额度/);
    assert.equal(concurrent.posts.length, 1);
  }
  const inbox = fixture(); inbox.ctx.config.messageAllowedUids = ["3", "4"];
  inbox.incoming("3", 1, "old-three"); inbox.incoming("4", 1, "old-four");
  await inbox.poll(); inbox.tick(); await inbox.poll(); assert.equal(inbox.posts.length, 0, "initial contact baseline never replies to old messages");
  inbox.tick(); for (let seq = 2; seq <= 46; seq++) inbox.incoming("3", seq, `new-${seq}`);
  inbox.incoming("3", 47, "withdrawn", { msg_status: 1 });
  await inbox.poll();
  assert.equal(inbox.posts.length, 1); assert.equal(inbox.states.get("bili:2:dm:3").queue.length, 37, "eight contiguous messages are handled together; remaining messages survive pagination");
  assert.equal(inbox.states.get("bili:2:dm:3").lastSeq, "47");
  assert.ok(inbox.requests.some(r => new URL(r.url).searchParams.has("end_seqno")));
  const task = inbox.agents.find(r => r.taskId.startsWith("bili-dm-")); assert.match(task.taskId, /^bili-dm-2-3-/);
  assert.equal(task.externalContent[0].content.current.length, 8);
  assert.deepEqual(Array.from(task.externalContent[0].content.current, item => item.text), Array.from({length:8}, (_,i)=>`new-${i+2}`));
  assert.doesNotMatch(JSON.stringify(task), /old-four|withdrawn/);
  inbox.tick(); inbox.incoming("4", 2, "only-four"); await inbox.poll();
  const peer4 = inbox.agents.find(r => r.taskId.startsWith("bili-dm-2-4-")); assert.match(JSON.stringify(peer4), /only-four/); assert.doesNotMatch(JSON.stringify(peer4), /new-46/);
  const resume = fixture(); resume.ctx.config.messageAllowedUids = ["3"]; await resume.poll(); resume.tick(); resume.incoming("3", 1, "recover"); resume.failModel(true); await resume.poll();
  resume.failModel(false); resume.tick(301); await resume.poll(); assert.equal(resume.posts.length, 1);
  const attempts = resume.agents.filter(r => r.taskId.startsWith("bili-dm-")); assert.equal(attempts[0].taskId, attempts[1].taskId); assert.deepEqual(attempts[0].externalContent, attempts[1].externalContent);
  const discovery = fixture(); discovery.discover(true); discovery.visual(true);
  await discovery.poll(); assert.equal(discovery.media.length, 1); assert.equal(discovery.media[0].kind, "frames");
  assert.ok(discovery.files.has(`channel:notes/${BV}-p1.md`)); assert.equal(discovery.posts.length, 0);
  discovery.tick(); await discovery.poll(); assert.equal(discovery.posts.length, 1, "automatic comment runs after real discovery and reading");
  const comment = discovery.agents.find(r => r.taskId.startsWith("bili-comment-"));
  assert.match(JSON.stringify(comment.externalContent), /内容证据/); assert.doesNotMatch(comment.prompt, /内容证据/);
  const originalCalls = discovery.agents.filter(r => r.taskId.startsWith("video-")).length;
  discovery.tick(3601); await discovery.poll(); assert.equal(discovery.agents.filter(r => r.taskId.startsWith("video-")).length, originalCalls, "completed video reading is reused");
  console.log("Bilibili social: structured drafts, public-note grounding, native emoji, likes, uncertain writes without resubmission, atomic account concurrency, account switch, multi-contact private inbox, reverse pagination, first-enable baseline, Agent resume and autonomous discovery/media/comment passed (no real network or sends)");
})().catch(error => { console.error(error); process.exitCode = 1; });
