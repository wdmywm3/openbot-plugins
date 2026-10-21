"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const code = fs.readFileSync(path.join(__dirname, "../plugins/bilibili-explorer/index.js"), "utf8");
function fixture() {
  let now = 1800000000000, failSend = false, noReply = false, failModel = false, hideTarget = false;
  const states = new Map(), posts = [], agents = [], reads = [], notifications = [], replies = new Map();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const load = () => { const sandbox = { module: { exports: {} }, Date: Clock }; vm.runInNewContext(code, sandbox); return sandbox.module.exports; };
  const ctx = { config: { browseUid: "2", commentMode: "auto", autoComment: true, autoReply: true,
    commentChat: "onebot:private:99", dailyCommentLimit: 10, threadReplyLimit: 3, commentIntervalMinutes: 1 },
    message: { chatId: "onebot:private:99" }, api: {
      getSecret: async () => "user=2; bili_jct=PRIVATE-COOKIE",
      getState: async key => structuredClone(states.get(key)),
      setState: async (key, value) => states.set(key, structuredClone(value)),
      sleep: async () => {}, push: async () => ({ id: "sent" }),
      runAgent: async args => {
        agents.push(args); assert.ok(!args.prompt.includes("PRIVATE-COOKIE"));
        assert.equal(args.chatId, "onebot:private:99"); assert.equal(args.tools.length, 0);
        if (args.taskId.startsWith("explore-")) return { toolCalls: 0, text: JSON.stringify({ candidate: {
          url: "https://www.bilibili.com/video/BV1234567890", title: "天文入门", reason: "根据标题推荐", score: 90,
        } }) };
        if (failModel) throw Error("interrupted model");
        return { text: JSON.stringify({ respond: !noReply, text: "这个问题值得继续了解。" }) };
      },
      fetchJson: async (url, options) => {
        const u = new URL(url); reads.push(u);
        assert.equal(options.headers.cookie, "user=2; bili_jct=PRIVATE-COOKIE");
        if (u.pathname.endsWith("/nav")) return { code: 0, data: { isLogin: true, mid: 2 } };
        if (u.pathname.endsWith("/view")) return { code: 0, data: { aid: 100, title: "天文入门", desc: "星空" } };
        if (u.pathname.endsWith("/rcmd")) return { code: 0, data: { item: [{ bvid: "BV1234567890", title: "天文入门" }] } };
        if (u.pathname.endsWith("/msgfeed/reply")) {
          const start = Number(u.searchParams.get("id") || 0), items = [...notifications].reverse().slice(start, start + 2);
          return { code: 0, data: { items, cursor: { id: start + items.length, time: items.at(-1)?.reply_time || 1,
            is_end: start + items.length >= notifications.length } } };
        }
        if (u.pathname.endsWith("/reply/reply")) {
          const root = u.searchParams.get("root"), list = [...replies.values()].filter(r => String(r.root) === root && !(hideTarget && r.mid === "2"));
          return { code: 0, data: { root: replies.get(root), replies: list, page: { count: list.length } } };
        }
        if (u.pathname.endsWith("/reply/add")) {
          const body = Object.fromEntries(new URLSearchParams(options.body)); posts.push(body);
          const rpid = String(1000 + posts.length);
          replies.set(rpid, { rpid, mid: "2", member: { mid: "2" }, root: body.root || 0, parent: body.parent || 0, content: { message: body.message } });
          if (failSend) throw Error("network lost after send");
          return { code: 0, data: { rpid } };
        }
        throw Error(`Unexpected ${url}`);
      },
    } };
  function incoming(id, { root = "500", target = "501", mid = "3", time = Math.floor(now / 1000), type = 1 } = {}) {
    replies.set(root, { rpid: root, mid: "4", root: 0, content: { message: "公开根评论" } });
    replies.set(target, { rpid: target, mid: "2", root, parent: root, content: { message: "我的回复" } });
    replies.set(id, { rpid: id, mid, root, parent: target, content: { message: "具体是什么意思？" } });
    notifications.push({ id, user: { mid }, reply_time: time, item: { type: "reply", business_id: type, source_id: id, target_id: target, root_id: root, subject_id: 100 } });
  }
  const state = () => states.get("bili:2:interactions");
  const poll = () => load().poll(ctx);
  const tick = (seconds = 61) => { now += seconds * 1000; };
  const comment = id => { const job = { id: `auto-comment-${id}`, kind: "comment", bvid: id, createdAt: now };
    const s = state() || { queue: [], recent: [], verify: [], nextAt: 0 }; s.queue.push(job); s.recent.push(job.id); states.set("bili:2:interactions", s);
  };
  return { ctx, states, state, posts, agents, reads, incoming, poll, tick, comment,
    failSend: value => { failSend = value; }, noReply: value => { noReply = value; }, failModel: value => { failModel = value; }, hideTarget: value => { hideTarget = value; } };
}
(async () => {
  const f = fixture(); f.incoming("600", { time: 1799999900 }); await f.poll(); assert.equal(f.posts.length, 0);
  f.tick(); f.incoming("601"); await f.poll();
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].root, "500"); assert.equal(f.posts[0].parent, "601", "nested reply targets the source, not the root");
  f.tick(); await f.poll(); assert.equal(f.posts.length, 1, "restarting the worker never duplicates a reply");
  assert.equal(f.states.get("bili:2:auto-reply-601").status, "visible");
  assert.ok(f.agents[0].prompt.includes("我的回复"));
  f.incoming("602", { mid: "2" }); f.incoming("603", { type: 17 }); f.tick(); await f.poll(); assert.equal(f.posts.length, 1);

  const unknown = fixture(); await unknown.poll(); unknown.tick(); unknown.incoming("601"); unknown.failSend(true); await unknown.poll();
  assert.equal(unknown.posts.length, 1); assert.equal(unknown.states.get("bili:2:auto-reply-601").status, "pending");
  unknown.failSend(false); unknown.tick(301); await unknown.poll(); unknown.tick(); await unknown.poll(); assert.equal(unknown.posts.length, 1);

  const limited = fixture(); limited.ctx.config.dailyCommentLimit = 1; await limited.poll(); limited.tick(); limited.incoming("601"); await limited.poll();
  limited.incoming("602"); limited.tick(); await limited.poll(); assert.equal(limited.posts.length, 1); assert.equal(limited.state().queue.length, 1);
  limited.tick(86401); await limited.poll(); assert.equal(limited.posts.length, 1, "stale replies expire instead of spamming next day");

  const thread = fixture(); thread.ctx.config.threadReplyLimit = 1; await thread.poll(); thread.tick(); thread.incoming("601"); await thread.poll();
  thread.incoming("602"); thread.tick(); await thread.poll(); assert.equal(thread.posts.length, 1); assert.equal(thread.states.get("bili:2:auto-reply-602").status, "skipped");

  const deleted = fixture(); await deleted.poll(); deleted.tick(); deleted.incoming("601"); deleted.hideTarget(true); await deleted.poll(); assert.equal(deleted.posts.length, 0);
  const abstain = fixture(); abstain.noReply(true); abstain.comment("BV1234567890"); await abstain.poll(); assert.equal(abstain.posts.length, 0);
  assert.equal(abstain.states.get("bili:2:auto-comment-BV1234567890").status, "skipped");

  const restart = fixture(); restart.comment("BV1234567890"); restart.failModel(true); await restart.poll();
  restart.failModel(false); restart.tick(301); await restart.poll();
  assert.equal(restart.posts.length, 1); assert.equal(restart.agents[0].prompt, restart.agents[1].prompt, "resumed Agent sees its frozen input");
  assert.equal(restart.agents[0].taskId, restart.agents[1].taskId);
  const policy = fixture(); policy.comment("BV1234567890"); policy.failModel(true); await policy.poll();
  policy.ctx.config.commentRules = "暂停这个话题的发言"; policy.failModel(false); policy.tick(301); await policy.poll();
  assert.equal(policy.posts.length, 0, "changed prohibitions invalidate unfinished automatic drafts");

  const pages = fixture(); pages.ctx.config.dailyCommentLimit = 0; await pages.poll(); pages.tick();
  for (let i = 0; i < 9; i++) pages.incoming(String(601 + i));
  await pages.poll(); assert.equal(pages.state().queue.length, 6); assert.ok(pages.state().scan.cursor);
  pages.tick(); await pages.poll(); assert.equal(pages.state().queue.length, 9); assert.equal(pages.state().scan, null);
  assert.equal(new Set(pages.state().queue.map(j => j.id)).size, 9);

  const quotaCrash = fixture(); quotaCrash.comment("BV1234567890"); const save = quotaCrash.ctx.api.setState; let once = true;
  quotaCrash.ctx.api.setState = async (key, value) => { await save(key, value); if (once && key.includes(":comments:")) { once = false; throw Error("crash after quota reservation"); } };
  await quotaCrash.poll(); quotaCrash.tick(301); await quotaCrash.poll();
  assert.equal(quotaCrash.posts.length, 1); assert.equal([...quotaCrash.states.entries()].find(([key]) => key.includes(":comments:"))[1].count, 1);

  const disabled = fixture(); disabled.ctx.config.commentMode = "draft"; disabled.comment("BV1234567890"); await disabled.poll(); assert.equal(disabled.posts.length, 0);
  disabled.ctx.config.commentMode = "auto"; disabled.ctx.config.commentChat = "onebot:group:99"; await disabled.poll(); assert.equal(disabled.agents.length, 0);
  const discovery = fixture(); Object.assign(discovery.ctx.config, { targetChat: "onebot:private:99", interests: "天文", tools: [], quietStartHour: 0, quietEndHour: 0 });
  await discovery.poll(); assert.equal(discovery.state().queue[0].id, "auto-comment-BV1234567890", "a real exploration candidate creates the public-comment job");
  discovery.tick(); await discovery.poll(); assert.equal(discovery.posts.length, 1); assert.equal(discovery.posts[0].root, undefined);
  discovery.tick(3601); await discovery.poll(); assert.equal(discovery.posts.length, 1, "the same recommended video is not commented twice");
  console.log("Bilibili interactions: first-start boundary, pagination, nested replies, dedupe, unknown sends, quotas, thread limits, expiry, evidence and Agent resume passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
