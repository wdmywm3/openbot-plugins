"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const host = process.env.OPENBOT_HOST_ROOT || path.resolve(__dirname, "../../openbot");
const { createUnifiedMemoryRepository } = require(path.join(host, "electron/lib/context/unified-memory-repository.cjs"));
const organizer = require("../plugins/memory/unified-organizer.cjs"), dream = require("../plugins/memory/unified-dream.cjs");
const prompts = require("../plugins/memory/unified-dream-prompts.cjs");
const { open, close } = require("../plugins/memory/storage.cjs"), { get, state } = require("../plugins/memory/unified-state.cjs");
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
  value.records = () => repo.memory(actor, { action: "search" }).items;
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
    console.log("Memory organizer policy: stable cached prefix, policy fingerprint rotation, retained pending ticket, sequence reset and committed receipt reconciliation passed.");
  } finally {
    prompts.build = originalBuild; close(); db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith("openbot-memory-organizer-policy-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
