"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./bilibili-social.cjs");
const BV = "BV1234567890", IMG = "https://gchat.qpic.cn/gchatpic_new/test/0";
function setup() {
  const f = fixture(), fetch = f.ctx.api.fetchJson, database = f.ctx.api.database;
  Object.assign(f.ctx.config, { coinEnabled: true, dailyCoinLimit: 5, tripleEnabled: true, browseFavoriteFolders: ["20"], dailyFavoriteLimit: 5 });
  f.logs = new Map(); f.uploads = []; f.coinCount = 0;
  f.ctx.api.log = async row => f.logs.set(row.id, structuredClone(row));
  f.ctx.api.database = async input => {
    const result = await database(input);
    if (input.action === "query" && input.where) result.records = result.records.filter(row => Object.entries(input.where).every(([key,value]) => row.value[key] === value));
    return result;
  };
  f.ctx.api.fetchJson = async (url, options = {}) => {
    if (url.includes("/archive/coins")) return { code: 0, data: { multiply: f.coinCount } };
    if (url.includes("/created/list-all")) return { code: 0, data: { list: [{ id: 20, title: "知识", media_count: 0 }] } };
    if (url.includes("/upload_bfs")) {
      f.uploads.push(structuredClone(options));
      if (f.uploadFailure) throw Error("upload interrupted");
      return { code: 0, data: { image_url: "http://i0.hdslb.com/bfs/new_dyn/image.png", image_width: 80, image_height: 40, img_size: 2 } };
    }
    const result = await fetch(url, options);
    if (url.includes("/coin/add")) f.coinCount += Number(new URLSearchParams(options.body).get("multiply"));
    if (url.includes("/like/triple")) result.data = f.tripleResult || { like: true, coin: true, fav: true, multiply: 2 };
    return result;
  };
  return f;
}
(async () => {
  const f = setup();
  const coin = { operationId: "coins-1", bvid: BV, coins: 2 };
  assert.equal((await f.tool("coin_video", coin)).result.coins, 2);
  assert.equal(f.posts[0].form.multiply, "2"); assert.equal(f.posts[0].form.select_like, "0");
  await f.tool("coin_video", coin); assert.equal(f.posts.length, 1, "replay does not spend again, even after coin state changed");
  await assert.rejects(f.tool("coin_video", { ...coin, coins: 1 }), /不同/);
  f.tick(); await assert.rejects(f.tool("coin_video", { ...coin, operationId: "extra", coins: 1 }), /已投2枚/);
  for (const coins of [0, 3, 1.5, "1"]) await assert.rejects(f.tool("coin_video", { ...coin, coins }), /1或2/);
  assert.equal((await f.tool("activity", { bvid: BV, kind: "coin" })).records.length, 1);
  assert.equal([...f.logs.values()][0].status, "completed");

  const disabled = setup(); disabled.ctx.config.coinEnabled = false;
  await assert.rejects(disabled.tool("coin_video", coin), /开启投币/); assert.equal(disabled.posts.length, 0);
  await assert.rejects(disabled.tool("triple_video", { operationId: "triple", bvid: BV }), /开启投币/);
  const quota = setup(); quota.ctx.config.dailyCoinLimit = 1;
  await assert.rejects(quota.tool("coin_video", coin), /额度/);
  await assert.rejects(quota.tool("triple_video", { operationId: "triple", bvid: BV }), /额度/); assert.equal(quota.posts.length, 0);
  const race = setup(); race.ctx.config.dailyCoinLimit = 2;
  const concurrent = await Promise.allSettled([race.tool("coin_video", coin), race.tool("coin_video", { ...coin, operationId: "concurrent" })]);
  assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1); assert.equal(race.posts.length, 1);

  const uncertain = setup(); uncertain.failSend(true);
  await assert.rejects(uncertain.tool("coin_video", coin), /network lost/);
  uncertain.failSend(false);
  assert.equal((await uncertain.tool("coin_video", coin)).status, "unknown"); assert.equal(uncertain.posts.length, 1);
  assert.equal((await uncertain.tool("activity", { kind: "coin" })).records[0].value.status, "unknown");

  const triple = setup(); triple.tripleResult = { like: true, coin: false, fav: true, multiply: 0 };
  const t = { operationId: "triple-1", bvid: BV };
  const partial = await triple.tool("triple_video", t);
  assert.equal(partial.status, "partial"); assert.equal(partial.result.coin, false); assert.equal(partial.result.favorite, true);
  await triple.tool("triple_video", t); assert.equal(triple.posts.length, 1);
  for (const kind of ["coin", "like", "favorite"]) {
    const key = [...triple.states.keys()].find(k => k.includes(`social-quota:${kind}:`));
    assert.equal(triple.states.get(key).amounts[t.operationId], kind === "coin" ? 2 : 1);
  }
  assert.equal([...triple.logs.values()][0].status, "review");
  const complete = setup(); assert.equal((await complete.tool("triple_video", t)).status, "accepted");
  assert.equal((await complete.tool("interaction_status", { operationId: t.operationId })).result.coins, 2);
  const fav = setup(); assert.equal((await fav.tool("favorite_video", { operationId: "fav-1", bvid: BV, folderId: "20" })).status, "accepted");
  assert.equal((await fav.tool("activity", { kind: "favorite" })).records.length, 1);

  const picture = setup();
  const d = await picture.tool("draft_comment", { operationId: "image-draft", bvid: BV, intent: "结合这张图留言", images: [IMG], emotes: ["[微笑]"] });
  assert.equal(picture.uploads.length, 0, "drafting never uploads or publishes");
  const sent = await picture.tool("post_comment", { draftId: d.draftId });
  assert.equal(sent.status, "accepted"); assert.equal(picture.uploads.length, 1);
  assert.equal(picture.uploads[0].multipart.files[0].url, IMG);
  assert.equal(picture.uploads[0].form.csrf, "PRIVATE-COOKIE");
  const payload = JSON.parse(picture.posts[0].form.pictures);
  assert.equal(payload[0].img_width, 80); assert.equal(payload[0].img_src, "https://i0.hdslb.com/bfs/new_dyn/image.png");
  assert.match(picture.posts[0].form.message, /\[微笑\]/);
  await picture.tool("post_comment", { draftId: d.draftId }); assert.equal(picture.posts.length, 1); assert.equal(picture.uploads.length, 1);
  const journal = (await picture.tool("activity", { kind: "comment" })).records[0].value;
  assert.equal(journal.text, sent.text); assert.equal(journal.pictures[0].img_src, payload[0].img_src); assert.equal(journal.rpid, sent.rpid);
  assert.equal(picture.logs.size, 1, "pending and accepted update the same operation record");
  assert.doesNotMatch(JSON.stringify([...picture.logs]), /PRIVATE-COOKIE/);

  for (const images of [["file:///secret.png"], ["https://gchat.qpic.cn.evil.test/a.png"], Array(10).fill(IMG)]) {
    await assert.rejects(picture.tool("draft_comment", { operationId: "bad-images", bvid: BV, intent: "测试", images }));
  }
  const broken = setup(); broken.uploadFailure = true;
  const bd = await broken.tool("draft_comment", { operationId: "broken-image", bvid: BV, intent: "图文", images: [IMG] });
  await assert.rejects(broken.tool("post_comment", { draftId: bd.draftId }), /upload interrupted/);
  assert.equal(broken.posts.length, 0, "upload failure cannot silently send text only");
  broken.uploadFailure = false; await broken.tool("post_comment", { draftId: bd.draftId }); assert.equal(broken.posts.length, 1);
  const partialUpload = setup(), uploadFetch = partialUpload.ctx.api.fetchJson;
  let failSecond = true;
  partialUpload.ctx.api.fetchJson = async (url, options) => {
    if (url.includes("upload_bfs") && partialUpload.uploads.length === 1 && failSecond) { failSecond = false; throw Error("second image interrupted"); }
    return uploadFetch(url, options);
  };
  const pd = await partialUpload.tool("draft_comment", { operationId: "two-images", bvid: BV, intent: "两张配图", images: [IMG, IMG + "?second"] });
  await assert.rejects(partialUpload.tool("post_comment", { draftId: pd.draftId }), /second image/);
  assert.equal(partialUpload.posts.length, 0);
  await partialUpload.tool("post_comment", { draftId: pd.draftId });
  assert.equal(partialUpload.uploads.length, 2, "completed upload is reused when continuing the draft");
  assert.equal(JSON.parse(partialUpload.posts[0].form.pictures).length, 2);

  const browser = setup(), cookieFetch = browser.ctx.api.fetchJson;
  browser.ctx.config.accountMode = "browser";
  browser.ctx.api.getSecret = () => { throw Error("browser mode cannot read cookies"); };
  browser.ctx.api.browserRequest = async input => {
    assert.equal(input.identity.value, "2");
    if (input.multipart) { assert.equal(input.csrf.field, "csrf"); assert.equal(input.form.csrf, undefined); }
    return cookieFetch(input.url, { method: input.method, multipart: input.multipart, form: input.form, body: new URLSearchParams(input.form).toString() });
  };
  const browserDraft = await browser.tool("draft_comment", { operationId: "browser-image", bvid: BV, intent: "图文", images: [IMG], root: "500", parent: "501" });
  await browser.tool("post_comment", { draftId: browserDraft.draftId });
  assert.equal(browser.posts[0].form.root, "500"); assert.equal(browser.posts[0].form.parent, "501");
  assert.equal((await browser.tool("activity", { kind: "reply" })).records.length, 1);

  const reading = setup(); reading.discover(true); reading.visual(true); await reading.poll(); reading.tick(); await reading.poll();
  assert.equal((await reading.tool("activity", { kind: "reading" })).records.length, 1);
  assert.equal((await reading.tool("activity", { kind: "comment" })).records.length, 1);
  const old = (await reading.tool("activity", { kind: "reading" })).records[0].value;
  assert.match(old.text, /内容证据/); assert.ok(old.sources.length);
  reading.ctx.config.browseUid = "3"; assert.equal((await reading.tool("activity")).records.length, 0, "account histories remain separated");
  await assert.rejects(reading.tool("activity", {}, { principal: { role: "member", messageType: "private" } }), /主人/);
  const browsing = setup(), runAgent = browsing.ctx.api.runAgent;
  browsing.ctx.api.runAgent = input => input.taskId.startsWith("explore-") ? Promise.resolve({ toolCalls: 1,
    observedUrls: [`https://www.bilibili.com/video/${BV}`], text: JSON.stringify({ candidate: null, inspected: [{ bvid: BV, part: 1, title: "原理", summary: "", reason: "只读简介，暂不继续" }] }) }) : runAgent(input);
  await browsing.poll();
  const browsed = (await browsing.tool("activity", { kind: "browse" })).records;
  assert.equal(browsed.length, 1); assert.equal(browsed[0].value.summary, "");
  assert.equal((await browsing.tool("activity", { kind: "reading" })).records.length, 0, "browsing metadata is not recorded as reading content");
  assert.equal(browsing.posts.length, 0, "recording does not require public interaction");
  const privateRead = setup(); privateRead.ctx.config.mainUid = "2"; await privateRead.tool("analyze", { bvid: BV });
  assert.equal((await privateRead.tool("activity", { kind: "reading" })).records.length, 0);
  assert.equal((await privateRead.tool("activity", { kind: "reading", public: false })).records.length, 1);
  const auto = setup(); auto.ctx.config.autoCoin = true; auto.ctx.config.autoComment = false;
  await auto.ctx.api.database({ action: "put", scope: "channel", collection: "contents", key: `${BV}:p:1`, expectedRevision: 0,
    value: { bvid: BV, part: 1, coverage: [{ kind: "captions", start: 0, end: 40 }] } });
  const autoAgent = auto.ctx.api.runAgent;
  auto.ctx.api.runAgent = input => input.taskId.startsWith("explore-") ? Promise.resolve({ toolCalls: 1,
    observedUrls: [`https://www.bilibili.com/video/${BV}`], text: JSON.stringify({ candidate: { url: `https://www.bilibili.com/video/${BV}`, title: "原理", reason: "有用的演示", score: 90 },
      inspected: [{ bvid: BV, part: 1, title: "原理", summary: "演示列明了样本条件", reason: "记录依据" }], actions: { coin: 1, share: false, comment: false } }) }) : autoAgent(input);
  await auto.poll(); assert.equal(auto.posts.length, 1); assert.equal(auto.posts[0].form.multiply, "1");
  auto.tick(3601); await auto.poll(); assert.equal(auto.posts.length, 1, "repeated browsing cannot repeat the same automatic coin action");
  console.log("Bilibili actions: coin quotas/replay, triple partial results, favorites, picture uploads in both login modes, retained text/images and isolated activity history passed (mock network only)");
})().catch(error => { console.error(error); process.exitCode = 1; });
