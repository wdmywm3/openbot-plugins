"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const { createUnifiedMemoryRepository } = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs"));
const organizer = require("../plugins/memory/unified-organizer.cjs"), dream = require("../plugins/memory/unified-dream.cjs");
const prompts = require("../plugins/memory/unified-dream-prompts.cjs");
const { open, close } = require("../plugins/memory/storage.cjs"), { get, state, save } = require("../plugins/memory/unified-state.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-memory-organizer-policy-"));
const db = new DatabaseSync(":memory:"), storage = open(root), scopes = new Map();
const originalBuild = prompts.build;
let policy = "first", writeRequests = 0;
prompts.build = (...args) => { const result = originalBuild(...args); return { ...result, system: `${result.system}\n测试保存策略：${policy}` }; };
const repo = createUnifiedMemoryRepository(db, { source: (who, id) => scopes.get(who.chatId)?.messages.find(item => item.id === id) });

function harness(name) {
  const scope = { channelId: "bot", chatId: `onebot:group:${name}` }, messages = [], calls = [];
  const actor = { ...scope, id: "plugin:memory", permissions: ["memory:read", "memory:write", "memory:manage"], canReadChat: id => id === scope.chatId };
  const value = { scope, messages, calls, behavior: null };
  const ctx = { signal: new AbortController().signal, principal: { ...scope, source: "lifecycle" }, api: {
    sources: async input => {
      if (input.action === "read") return { item: messages.find(item => item.id === input.id) };
      const upper = input.upper ?? messages.at(-1)?.seq ?? 0;
      const rows = messages.filter(item => item.seq > input.after && item.seq <= upper);
      return { items: rows.slice(0, input.limit), upper, nextCursor: rows.length > input.limit ? rows[input.limit - 1].seq : null };
    },
    memory: async ({ chatId, ...input }) => { if (input.action === "batch") writeRequests++; return repo.memory(actor, input); },
    memorySpace: async ({ chatId, ...input }) => repo.memorySpace(actor, input),
    runAgent: async request => {
      calls.push(request);
      assert.deepEqual(request.tools, ["plugin__memory__organize"]); assert.equal(request.usageCategory, "memory");
      const batch = JSON.parse(request.continuation.content);
      const commit = result => organizer.tool({ ...ctx, input: { ticket: batch.ticket, operation: "commit", result } }, storage, scope);
      return value.behavior(request, batch, commit);
    },
  } };
  value.add = content => {
    const seq = messages.length + 1;
    messages.push({ id: `${name}-${seq}`, seq, version: `${name}-v${seq}`, createdAt: Date.now(), direction: "in", source: "chat",
      sender: { id: "alice", name: "阿明", isBot: false }, content });
  };
  value.run = () => dream.run(ctx, storage, scope);
  value.batch = () => get(storage, `plus:organizer-batch:${scope.chatId}`);
  value.session = () => get(storage, `plus:organizer-session:${scope.chatId}`);
  value.records = (input = {}) => repo.memory(actor, { action: "search", ...input }).items;
  value.read = id => repo.memory(actor, { action: "read", id, mode: "history" }).item;
  value.ctx = ctx;
  scopes.set(scope.chatId, value); return value;
}
const complete = request => ({ taskId: request.taskId, status: "completed", summary: "done" });
const empty = () => ({ facts: [], topics: [] });

(async () => {
  try {
    const cached = harness("cached-prefix");
    cached.behavior = async (request, _batch, commit) => { await commit(empty()); return complete(request); };
    cached.add("今天随便聊聊，没有需要保存的新内容。"); await cached.run();
    cached.add("继续随便聊聊，同样不需要增加记忆。"); await cached.run();
    assert.equal(cached.calls.length, 2);
    assert.equal(cached.calls[0].taskId, cached.calls[1].taskId, "unchanged instructions reuse the authorized persistent conversation");
    assert.equal(cached.calls[0].prompt, cached.calls[1].prompt, "the complete system prefix stays identical for provider cache reuse");
    assert.deepEqual(cached.calls.map(item => item.continuation.sequence), [1, 2]);
    const count = cached.calls.length; await cached.run(); assert.equal(cached.calls.length, count, "an unchanged source cursor needs no model turn");

    const pending = harness("pending-ticket"); pending.add("暂时没有值得长期保存的内容。");
    pending.behavior = async request => complete(request);
    await assert.rejects(pending.run(), /未收到记忆提交回执/);
    const prior = pending.batch(), priorSession = pending.session();
    assert.equal(prior.sequence, 2); assert.equal(priorSession.nextSequence, 2);
    assert.equal(state(storage, pending.scope).cursor, 0, "a terminal model answer without commit never consumes source progress");
    policy = "second";
    pending.behavior = async (request, batch, commit) => {
      assert.notEqual(request.taskId, priorSession.id);
      assert.equal(request.continuation.sequence, 1, "a changed prompt starts the replacement conversation at sequence one");
      assert.equal(batch.ticket, prior.ticket);
      assert.equal(request.continuation.content, prior.input, "the uncommitted source batch, context and ticket survive a prompt change intact");
      await commit(empty()); return complete(request);
    };
    await pending.run();
    assert.equal(pending.batch(), null); assert.equal(state(storage, pending.scope).cursor, 1);
    assert.equal(pending.session().nextSequence, 2);

    const committed = harness("committed-receipt");
    committed.add("请记住，我的 NAS 备份目录是 /srv/backup，后续备份讨论使用这个目录。");
    committed.behavior = async (_request, batch, commit) => {
      const source = batch.messages[0];
      await commit({ facts: [{ kind: "fact", subjectId: "alice", content: "阿明的 NAS 备份目录为 /srv/backup。",
        retention: { basis: "explicit", reason: "本人要求后续备份讨论持续使用这一目录。" }, evidence: [{ id: source.id, quote: source.text }] }], topics: [] });
      throw Error("provider response lost after commit");
    };
    await assert.rejects(committed.run(), /provider response lost/);
    const receipt = committed.batch().receipt, oldSession = committed.session(), writes = writeRequests;
    assert(receipt.ok); assert.equal(committed.records().length, 1);
    assert.equal(state(storage, committed.scope).cursor, 1);
    policy = "third";
    committed.behavior = async () => { throw Error("a committed ticket must not be sent to another model conversation"); };
    const replayed = await committed.run();
    assert.equal(replayed.runId, receipt.runId); assert.equal(replayed.saved, receipt.saved);
    assert.notEqual(committed.session().id, oldSession.id);
    assert.equal(committed.session().nextSequence, 1);
    assert.equal(committed.calls.length, 1, "a prompt change reuses an existing receipt without invoking the model again");
    assert.equal(writeRequests, writes, "reconciling a committed receipt does not repeat its memory transaction");
    assert.equal(committed.records().length, 1); assert.equal(committed.batch(), null);
    assert.equal(state(storage, committed.scope).error, "", "a recovered receipt clears the transient provider failure shown to the user");
    assert.equal(state(storage, committed.scope).failures, 0); assert.equal(state(storage, committed.scope).retryAt, 0);
    committed.add("今天不用再补充记忆。");
    committed.behavior = async (request, _batch, commit) => { await commit(empty()); return complete(request); };
    await committed.run();
    const next = committed.calls.at(-1);
    assert.equal(next.taskId, committed.session().id); assert.equal(next.continuation.sequence, 1);
    assert.notEqual(next.prompt, committed.calls[0].prompt, "only a new source ticket enters the updated policy session");
    assert.equal(committed.records().length, 1);

    const slang = harness("public-memes"), triggers = [];
    const runtime = require("../plugins/memory/unified-runtime.cjs");
    const meme = (source, term, meaning, extra = {}) => ({
      term, meaning, evidence: [{ id: source.id, quote: source.text ?? source.content }], ...extra,
    });
    const meaning = "是「有毛病」的谐音，用于玩笑式吐槽。";
    let reviews = 0;
    const slangContext = { ...slang.ctx, dataRoot: root, plugin: { id: "memory", namespace: "bot" }, config: {},
      input: { chatId: slang.scope.chatId, mode: "auto" },
      api: { ...slang.ctx.api, sources: input => input.action === "head"
        ? { upper: slang.messages.at(-1).seq, observedAt: Date.now() - 6 * 60000 } : slang.ctx.api.sources(input),
      generate: async input => {
        reviews++;
        assert.match(input.systemPrompt, /原话明确支持通用含义/);
        const { records } = JSON.parse(input.prompt);
        assert(records.every(item => item.category === "meme"));
        return { text: JSON.stringify({ decisions: records.map(({ id, revision }) => ({
          id, revision, action: "promote", basis: "stable", tier: "long_term", reason: "原话明确解释了常见的网络用法",
        })) }) };
      } } };
    slang.add("有猫饼就是有毛病的谐音，逗人用的");
    slang.add("有猫饼！");
    slang.add("群里把阿明叫作硬盘侠");
    slang.add("@群友 在这群里叫你八爪鱼");
    slang.add("小电视是指猫应激的叫声");
    slang.messages.at(-1).sender.isBot = true;
    slang.behavior = async (request, batch, commit) => {
      triggers.push(state(storage, slang.scope).job.trigger);
      assert.match(request.prompt, /公开网络梗/);
      const [explanation, standalone, personal, mention, bot] = batch.messages;
      await commit({ ...empty(), memes: [
        meme(explanation, "有猫饼", meaning),
        meme(standalone, "有猫饼", meaning),
        meme(personal, "硬盘侠", "是阿明的专属称呼。"),
        meme(mention, "八爪鱼", "是这一群的专属称呼。"),
        meme(personal, "硬盘侠", "是群友的绰号。", { subjectId: "alice" }),
        meme(bot, "小电视", "是猫应激叫声的拟声。"),
      ] });
      return complete(request);
    };
    save(storage, slang.scope, { settingsOverride: { enabled: true, idleMinutes: 5 }, maintenanceNextRun: Date.now() + 60000 });
    assert.equal((await runtime.process(slangContext)).saved, 1);
    assert.equal(reviews, 0, "idle extracts candidates without scheduling a review model");
    const [candidate] = slang.records({ mode: "history", category: "meme" });
    assert.equal(candidate.status, "pending");
    assert.equal(slang.records({ category: "meme" }).length, 0, "unreviewed meme meanings are ineligible for recall");
    const detail = slang.read(candidate.id);
    assert.deepEqual(detail.subjectRefs, [], "a public meme is not assigned to the member who explained it");
    assert.deepEqual(detail.sources.map(source => source.id), [slang.messages[0].id]);

    slang.add("网上说的有猫饼，是把有毛病换成近音开玩笑");
    slang.add("老吴原本是模仿猫应激的叫声，网上也用来称呼猫");
    slang.behavior = async (request, batch, commit) => {
      triggers.push(state(storage, slang.scope).job.trigger);
      const [repeated, newTerm] = batch.messages;
      await commit({ ...empty(), memes: [
        meme(repeated, " 有猫饼 ", meaning),
        meme(newTerm, "老吴", "在猫梗里用来称呼猫，来自猫应激时的叫声。"),
      ] });
      return complete(request);
    };
    save(storage, slang.scope, { maintenanceNextRun: Date.now() - 1 });
    await runtime.process(slangContext);
    assert.deepEqual(triggers, ["idle", "scheduled"]);
    assert.equal(reviews, 1);
    assert.equal(slang.records({ category: "meme" }).length, 2, "scheduled extraction adds a new word and reviews the idle candidate");
    const reviewed = slang.read(candidate.id);
    assert.equal(reviewed.status, "active");
    assert.equal(reviewed.tier, "long_term");
    assert.deepEqual(reviewed.sources.map(source => source.id), [slang.messages[0].id, slang.messages[5].id]);
    assert.equal(harness("other-group").records({ category: "meme" }).length, 0, "a universal definition still follows memory sharing permissions");

    const message = { id: "recall", content: "我的朋友说有猫饼，我想知道怎么接这个梗", sender: { id: "alice", name: "阿明" } };
    const recall = await require("../plugins/memory/utterance-recall.cjs").recall({
      ...slangContext, message, hook: { requestId: "recall-request", messages: [], inputMessages: [message] },
    }, storage, slang.scope, []);
    assert(recall.memories.some(item => item.id === reviewed.id), "a reviewed meme can be recalled even with a participant constraint");
    const nickname = slang.messages[2];
    const revision = await dream.plan(slang.ctx, slang.scope, { ...empty(), revisions: [{
      supersedes: { id: reviewed.id, revision: reviewed.revision }, changeType: "correction",
      content: "有猫饼是本群给阿明起的外号。", evidence: [{ id: nickname.id, quote: nickname.content }],
    }] }, [{ ...nickname, chatId: slang.scope.chatId }], [reviewed]);
    assert.equal(revision.operations.length, 0, "ordinary fact revisions cannot replace a public definition with a nickname");

    const forked = harness("forked");
    forked.add("请记住，接龙截止在每周日晚上。");
    forked.add("有猫饼是有毛病的谐音，常用作玩笑式吐槽。");
    forked.add("整理结果已经发给大家了。");
    forked.add("模型从来没有看到这句话。");
    const [fact, publicMeme, outbound, unseen] = forked.messages;
    Object.assign(outbound, { direction: "out", source: "agent", networkStatus: "sent", sender: { id: "bot", isBot: true } });
    const visible = [fact, publicMeme, outbound], captured = [], snapshots = [{ id: "segment", boundary: "segment", at: Date.now() }];
    const branches = new Map([
      ["facts", { facts: [{ kind: "fact", subjectId: "alice", content: fact.content, evidence: [{ id: fact.id, quote: fact.content }],
        retention: { basis: "explicit", reason: "后续有人问何时结束接龙时使用这个约定。" } },
      { kind: "fact", content: unseen.content, evidence: [{ id: unseen.id, quote: unseen.content }] }] }],
      ["profiles", { facts: [] }],
      ["memes", { memes: [meme(publicMeme, "有猫饼", meaning)] }],
      ["experience", { records: [{ kind: "experience", content: "我把整理结果发给了群里。", evidence: [{ id: outbound.id, quote: outbound.content }] }] }],
    ]);
    forked.ctx.api.sources = async () => assert.fail("fork extraction must not sweep the raw source feed");
    forked.ctx.api.conversationForks = async request => {
      if (request.action === "list") return { snapshots };
      if (request.action === "sources") return { items: visible, nextOffset: null };
      captured.push(request);
      return { results: request.branches.map(branch => ({ key: branch.key, output: JSON.stringify(branches.get(branch.key)) })) };
    };
    const nativeMemory = forked.ctx.api.memory, requestKeys = [];
    forked.ctx.api.memory = async input => {
      const result = await nativeMemory(input);
      if (input.action === "batch") {
        requestKeys.push(input.requestKey);
        if (requestKeys.length === 1) throw Error("write acknowledgement lost");
      }
      return result;
    };
    save(storage, forked.scope, { settingsOverride: { enabled: true, idleMinutes: 5 }, maintenanceNextRun: Date.now() + 60000 });
    const forkCtx = { ...forked.ctx, dataRoot: root, message: { chatId: forked.scope.chatId }, input: { mode: "dream" } };
    const queued = [];
    forked.ctx.api.jobs = async request => queued.push(request);
    const boundaryCtx = { ...forkCtx, hook: { snapshot: snapshots[0] } };
    await runtime.conversationBoundary(boundaryCtx);
    assert.deepEqual(queued.map(item => [item.actionId, item.chatId, item.input.mode]), [["process", forked.scope.chatId, "dream"]]);
    await assert.rejects(runtime.process(forkCtx), /acknowledgement lost/);
    await runtime.process(forkCtx);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].branches.map(branch => branch.key), [...branches.keys()]);
    assert.equal(requestKeys[0], requestKeys[1], "a lost receipt retries the same write without calling the model again");
    assert.equal(forked.records({ mode: "history" }).length, 3, "valid fact, meme and delivered diary item share one write");
    assert(!forked.records({ mode: "history" }).some(item => item.content === unseen.content));
    assert.equal(state(storage, forked.scope).cursor, 0, "the raw source cursor does not track model visibility");

    forked.add("老吴是在模仿猫应激时发出的叫声，网上也用来指猫。");
    const newer = forked.messages.at(-1);
    visible.push(newer);
    snapshots.push({ id: "current", boundary: null, at: Date.now() });
    branches.set("memes", { memes: [meme(newer, "老吴", "模仿猫应激的叫声，也用来称呼猫。")] });
    assert.equal((await runtime.process(forkCtx)).reason, "not_due", "idle settings no longer extract on a fork-capable host");
    save(storage, forked.scope, { nextRun: Date.now() - 1, maintenanceRetryAt: Date.now() + 60000 });
    await runtime.process(forkCtx);
    assert.equal(captured.length, 2);
    assert.equal(captured[1].id, "current");
    assert(state(storage, forked.scope).nextRun > Date.now(), "extraction advances the daily schedule even during maintenance backoff");
    assert(!JSON.stringify(captured[1].branches).includes(publicMeme.id), "daily Dream only processes remaining visible sources");
    assert.equal(forked.records({ mode: "history", category: "meme" }).length, 2);
    console.log("Memory organizer policy: fork boundaries and daily Dream, visible evidence, diary, public memes, deduplication, receipts and recall passed.");
  } finally {
    prompts.build = originalBuild; close(); db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith("openbot-memory-organizer-policy-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
