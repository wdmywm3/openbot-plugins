"use strict";
const { randomUUID } = require("node:crypto");
const { get, put, state, save, hash } = require("./unified-state.cjs");
const materialPolicy = require("./unified-material-policy.cjs");
const VERSION = 2, TOKEN_BUDGET = 12000, MAX_MESSAGES = 400, MAX_SCANNED = 1000;
const TOOL = "plugin__memory__organize";
const activeTools = new Set();
const empty = () => ({ facts: [], topics: [], records: [], updates: [], revisions: [], invalidations: [], style: null });
const batchKey = scope => `plus:organizer-batch:${scope.chatId}`;
const sessionKey = scope => `plus:organizer-session:${scope.chatId}`;
function estimate(text) {
  const wide = (text.match(/[^\x00-\x7f]/g) || []).length;
  return Math.ceil(wide + (text.length - wide) / 3);
}
function project(item) {
  return { id: `s${item.seq}`, at: item.createdAt, sender: String(item.sender?.id || item.senderId || ""),
    role: item.direction === "out" || item.sender?.isBot ? "bot" : "user", text: item.content,
    ...(item.hasMore ? { hasMore: true, nextOffset: (item.offset || 0) + item.content.length } : {}),
    ...(item.attachments?.length ? { attachments: item.attachments.map(({ type, name, index }) => ({ type, name, index })) } : {}) };
}
function instructions(ctx, storage, scope) {
  const built = require("./unified-dream-prompts.cjs").build(ctx, storage, scope);
  return `持续整理当前聊天的事实、偏好、事项和用户画像。每次追加是一批新的聊天资料；此前历史只作上下文，不重做已提交操作。\n${built.system}\n` +
    `本任务使用 ${TOOL} 工具，action=start 时提供稳定 requestKey 和 input。input.ticket 取本次追加资料中的 ticket。\n` +
    `operation=search 按主题和成员查已存记忆；operation=read 按返回 id 读正文与版本；operation=material 按本批 s编号和 offset 补读原消息。不要为无价值闲聊发起检索。修订前逐条读取对应记录；提交时插件还会逐项核对当前聊天已有记录。\n` +
    `用 operation=commit，result 包含 facts/topics/records/updates/revisions/invalidations/style 提交本批提案（无需先输出整段 JSON）。每条facts必须有retention:{basis,reason}，稳定画像还可含profileSection。所有 evidence.id 使用本批 s编号，quote 必须逐字匹配用户原话。修订的 id/revision 必须来自本批 search/read。experience 不写入。没有值得记住的内容也要 commit 空数组以推进进度。\n` +
    `工具返回 running 时按 jobId 查询 status，收到 completed/result 才判断提交成功。只有 commit 回执确认后才调用 task_result，summary 简述本批结果；不要发聊天回复，不调用其他业务工具。读取下一批由插件追加，你只处理当前 ticket。`;
}
function session(ctx, storage, scope) {
  let value = get(storage, sessionKey(scope));
  const prompt = instructions(ctx, storage, scope), fingerprint = hash(prompt);
  if (!value || value.version !== VERSION || value.fingerprint !== fingerprint) value = put(storage, sessionKey(scope), {
    version: VERSION, fingerprint, id: `memory-organizer-${randomUUID()}`, nextSequence: 1, prompt,
  });
  return value;
}
function consumeReceipt(storage, scope, batch) {
  storage.db.exec("SAVEPOINT plus_organizer_completed");
  try {
    save(storage, scope, { error: "", failures: 0, retryAt: 0 });
    storage.db.prepare("DELETE FROM plugin_meta WHERE key=?").run(batchKey(scope));
    storage.db.exec("RELEASE plus_organizer_completed"); return batch.receipt;
  } catch (error) { storage.db.exec("ROLLBACK TO plus_organizer_completed; RELEASE plus_organizer_completed"); throw error; }
}
async function collect(ctx, scope, after, upper) {
  const materials = [], messages = [], people = {};
  let scanned = 0, tokens = 0, cursor = after, bound = upper;
  while (scanned < MAX_SCANNED && messages.length < MAX_MESSAGES) {
    ctx.signal.throwIfAborted();
    const page = await ctx.api.sources({ action: "changes", chatId: scope.chatId, after: cursor,
      ...(bound != null ? { upper: bound } : {}), limit: 100 });
    if (bound == null) bound = page.upper;
    if (!Number.isSafeInteger(bound) || bound < cursor) throw Error("整理资料位置无效");
    if (!page.items.length) { cursor = bound; break; }
    for (const item of page.items) {
      if (!Number.isSafeInteger(item.seq) || item.seq <= cursor || item.seq > bound) throw Error("整理资料顺序无效");
      if (materialPolicy.admit(item)) {
        const entry = project(item), person = entry.sender;
        const name = String(item.sender?.card || item.sender?.name || item.sender?.nickname || person);
        const cost = estimate(JSON.stringify(entry)) + (Object.hasOwn(people, person) ? 0 : estimate(name) + 12);
        if (messages.length && (tokens + cost > TOKEN_BUDGET || messages.length >= MAX_MESSAGES)) {
          return { materials, messages, people, after: cursor, upper: bound, scanned, estimatedTokens: tokens };
        }
        materials.push({ ...item, chatId: scope.chatId, senderId: person }); messages.push(entry);
        people[person] = name; tokens += cost;
      }
      cursor = item.seq; scanned++;
      if (scanned >= MAX_SCANNED) break;
    }
    if (cursor >= bound || page.nextCursor == null) { cursor = bound; break; }
  }
  return { materials, messages, people, after: cursor, upper: bound, scanned, estimatedTokens: tokens };
}
function live(ctx, storage, scope, batch) {
  ctx.signal.throwIfAborted();
  const policy = state(storage, scope);
  if (policy.paused || batch.trigger !== "manual" && !policy.settings.enabled) throw Error("整理已暂停");
  return policy;
}
function normalizeResult(value, batch) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("请提供本批整理结果");
  const map = new Map(batch.materials.map(item => [`s${item.seq}`, item.id]));
  const evidence = refs => Array.isArray(refs) ? refs.map(ref => ({ ...ref, id: map.get(ref?.id) || ref?.id })) : refs;
  const result = { ...empty(), ...value };
  for (const key of ["facts", "topics", "records", "updates", "revisions", "invalidations"]) {
    if (!Array.isArray(result[key]) || result[key].length > 64) throw Error("整理提案格式无效或条目过多");
    result[key] = result[key].map(item => ({ ...item,
      ...(item.evidence ? { evidence: evidence(item.evidence) } : {}),
      ...(item.reviewEvidence ? { reviewEvidence: evidence(item.reviewEvidence) } : {}),
      ...(item.sourceIds ? { sourceIds: item.sourceIds.map(id => map.get(id) || id) } : {}) }));
  }
  if (result.style) result.style = { ...result.style, evidence: evidence(result.style.evidence) };
  return result;
}
async function tool(ctx, storage, scope) {
  const key = `${storage.root}:${scope.chatId}`;
  if (activeTools.has(key)) throw Error("当前整理工具尚未完成，请等待回执后再调用");
  activeTools.add(key);
  try { return await executeTool(ctx, storage, scope); }
  finally { activeTools.delete(key); }
}
async function executeTool(ctx, storage, scope) {
  const input = ctx.input || {}, batch = get(storage, batchKey(scope));
  if (!batch || input.ticket !== batch.ticket) throw Error("这批整理资料已结束或不属于当前聊天");
  live(ctx, storage, scope, batch);
  const persist = () => put(storage, batchKey(scope), batch);
  if (input.operation === "commit") {
    const fingerprint = hash(JSON.stringify(input.result));
    if (batch.commitFingerprint && batch.commitFingerprint !== fingerprint) throw Error("本批已提交不同提案，请先核对回执");
    if (batch.receipt) return batch.receipt;
    const parsed = normalizeResult(input.result, batch);
    const dream = require("./unified-dream.cjs"), policy = live(ctx, storage, scope, batch);
    if (!policy.job || policy.job.runId !== batch.runId) throw Error("整理作业已变化");
    if (!policy.job.prepared) {
      const prepared = await dream.plan(ctx, scope, parsed, batch.materials, batch.existing);
      if (prepared.operations.length > 100) throw Error("本批最多提交 100 项变更，请合并同一事实或事项的提案");
      live(ctx, storage, scope, batch);
      put(storage, `plus:plan:${scope.chatId}`, { ...prepared, runId: batch.runId, after: batch.after });
      batch.commitFingerprint = fingerprint; persist();
      save(storage, scope, { job: { ...policy.job, prepared: true } });
    }
    const result = await dream.commit(ctx, storage, scope, state(storage, scope).job, {
      onReceipt: receipt => { batch.receipt = { ok: true, ...receipt }; persist(); },
    });
    storage.dreamRepository.runs.trace(scope, batch.runId, "dream_output", { text: JSON.stringify({ saved: result.saved, skipped: result.skipped }) });
    return batch.receipt;
  }
  if (batch.receipt) return { committed: true, ...batch.receipt };
  if (input.operation === "material") {
    const source = batch.materials.find(item => `s${item.seq}` === input.id);
    if (!source || !Number.isSafeInteger(input.offset) || input.offset < 0) throw Error("补读编号不属于本批资料");
    const result = await ctx.api.sources({ action: "read", chatId: scope.chatId, id: source.id, version: source.version,
      upper: batch.upper, offset: input.offset, limit: 6000 });
    if (!result.item || !materialPolicy.admit(result.item)) throw Error("原消息已变化或不可读取");
    live(ctx, storage, scope, batch);
    if (batch.materials.length >= MAX_MESSAGES + 24) throw Error("本批补读次数已达上限");
    batch.materials.push({ ...result.item, seq: source.seq, chatId: scope.chatId }); persist();
    return project({ ...result.item, seq: source.seq });
  }
  const remember = items => {
    for (const item of items) {
      const index = batch.existing.findIndex(old => old.id === item.id);
      if (index >= 0) batch.existing[index] = item;
      else if (batch.existing.length < 60) batch.existing.push(item);
      else throw Error("本批已读取的记忆过多，请缩小查找范围");
    }
    live(ctx, storage, scope, batch); persist();
  };
  const ownSpace = ctx.api.memorySpace && ["search", "read"].includes(input.operation)
    ? (await ctx.api.memorySpace({ action: "list", chatId: scope.chatId })).spaces?.find(item => item.kind === "chat" && item.ownerId === scope.chatId) : null;
  if (input.operation === "search") {
    if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 1000) throw Error("请提供具体查询内容");
    const result = ctx.api.memorySpace && !ownSpace ? { items: [] }
      : await ctx.api.memory({ action: "search", chatId: scope.chatId, ...(ownSpace ? { spaceId: ownSpace.id } : {}), query: input.query, limit: 15 });
    batch.searched = true; remember(result.items || []);
    return { items: (result.items || []).map(({ id, revision, kind, subtype, preview, subjectRefs, progress }) => ({ id, revision, kind, subtype, preview, subjectRefs, progress })) };
  }
  if (input.operation === "read") {
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error("记忆读取位置无效");
    const known = batch.existing.find(item => item.id === input.id);
    const item = (await ctx.api.memory({ action: "read", chatId: scope.chatId, id: input.id, offset, limit: 6000,
      ...(offset && known ? { revision: known.revision } : {}) })).item;
    if (!item) throw Error("记忆已不可读取");
    if (ctx.api.memorySpace && item.spaceId !== ownSpace?.id) throw Error("这条记忆不属于当前聊天，请在当前聊天中查找对应记录");
    remember([item]); return { item };
  }
  throw Error("未知整理操作");
}
async function runBatch(ctx, storage, scope, trigger) {
  const dream = require("./unified-dream.cjs");
  let policy = state(storage, scope), batch = get(storage, batchKey(scope));
  if (policy.paused) throw Error("整理已暂停");
  if (policy.job?.prepared && !batch) return dream.commit(ctx, storage, scope, policy.job);
  if (!batch || batch.after <= policy.cursor && !batch.receipt && policy.job?.runId !== batch.runId) {
    const collected = await collect(ctx, scope, policy.cursor || 0, policy.job?.upper);
    if (collected.after === (policy.cursor || 0)) {
      save(storage, scope, { job: null, lastRun: Date.now(), nextRun: require("./lib/features/channels/channel-dream-analysis.cjs").nextRun(policy.settings, Date.now()) });
      return { completed: true, pending: false, saved: 0, idle: true };
    }
    const job = policy.job || { runId: randomUUID(), trigger, cutoff: Date.now(), upper: collected.upper };
    job.runId = storage.dreamRepository.runs.start(scope, job); save(storage, scope, { job });
    const conversation = session(ctx, storage, scope);
    batch = { ...collected, ticket: randomUUID(), runId: job.runId, trigger: job.trigger,
      sessionId: conversation.id, sequence: conversation.nextSequence, existing: [], searched: false };
    const context = require("./unified-dream-prompts.cjs").build(ctx, storage, scope).context;
    batch.input = JSON.stringify({ ticket: batch.ticket, people: batch.people, messages: batch.messages, context });
    put(storage, batchKey(scope), batch);
    storage.dreamRepository.runs.trace(scope, job.runId, "dream_input", { text: batch.input });
  }
  live(ctx, storage, scope, batch);
  if (!batch.materials.length) {
    batch.receipt = await tool({ ...ctx, input: { ticket: batch.ticket, operation: "commit", result: empty() } }, storage, scope);
  } else {
    let conversation = session(ctx, storage, scope);
    if (batch.sessionId !== conversation.id) {
      // Prompt updates replace the model conversation, while retaining the
      // source ticket and any already committed receipt from the old session.
      if (batch.receipt) {
        return consumeReceipt(storage, scope, batch);
      }
      batch.sessionId = conversation.id; batch.sequence = conversation.nextSequence;
      put(storage, batchKey(scope), batch);
    }
    const invoke = () => ctx.api.runAgent({ chatId: scope.chatId, taskId: conversation.id, prompt: conversation.prompt,
      tools: [TOOL], usageCategory: "memory", timeoutMs: 600000,
      continuation: { sequence: batch.sequence, content: batch.input } });
    let result;
    try { result = await invoke(); }
    catch (error) {
      if (error.code !== "AGENT_TASK_CHANGED") throw error;
      // A changed role/model/tool grant requires a fresh host-authorized task.
      // Keep the batch and its write receipt so no old operation is duplicated.
      live(ctx, storage, scope, batch);
      storage.db.prepare("DELETE FROM plugin_meta WHERE key=?").run(sessionKey(scope));
      conversation = session(ctx, storage, scope); batch.sequence = 1; batch.sessionId = conversation.id;
      put(storage, batchKey(scope), batch); result = await invoke();
    }
    batch = get(storage, batchKey(scope));
    if (!batch?.receipt) {
      if (batch && ["completed", "blocked", "failed"].includes(result.status)) {
        // The host has closed this model turn. Retrying its sequence would only
        // replay that terminal result. Keep the same batch/ticket and append a
        // new turn, without advancing any source progress or write receipt.
        storage.db.exec("SAVEPOINT plus_organizer_retry");
        try {
          batch.sequence++;
          put(storage, batchKey(scope), batch);
          put(storage, sessionKey(scope), { ...conversation, nextSequence: batch.sequence });
          storage.db.exec("RELEASE plus_organizer_retry");
        } catch (error) { storage.db.exec("ROLLBACK TO plus_organizer_retry; RELEASE plus_organizer_retry"); throw error; }
      }
      throw Error(`本批未收到记忆提交回执：${result.summary || result.status || "任务已结束"}`);
    }
    put(storage, sessionKey(scope), { ...conversation, nextSequence: batch.sequence + 1 });
  }
  return consumeReceipt(storage, scope, batch);
}
async function run(ctx, storage, scope, trigger = "manual") {
  const dream = require("./unified-dream.cjs"), key = `${storage.root}:${scope.chatId}`;
  if (dream.running.has(key)) throw Error("当前聊天正在整理");
  const task = (async () => {
    let result, saved = 0, skipped = 0;
    for (let index = 0; index < 4; index++) {
      ctx.signal.throwIfAborted();
      result = await runBatch(ctx, storage, scope, trigger); saved += result.saved || 0; skipped += result.skipped || 0;
      if (!result.pending || state(storage, scope).paused) break;
    }
    return { ...result, saved, skipped };
  })();
  dream.running.set(key, task);
  try { return await task; }
  catch (error) {
    const policy = state(storage, scope);
    if (ctx.signal.aborted || policy.paused) {
      save(storage, scope, { error: "", failures: 0, retryAt: 0 });
      if (policy.job?.runId) storage.dreamRepository.runs.finish(scope, policy.job.runId, "paused", "整理已停止，已保留进度");
      throw error;
    }
    const failures = (policy.failures || 0) + 1;
    save(storage, scope, { error: String(error.message || error), failures, retryAt: Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(failures, 6)) });
    if (policy.job?.runId) storage.dreamRepository.runs.finish(scope, policy.job.runId, "failed", String(error.message || error));
    throw error;
  } finally { dream.running.delete(key); }
}
module.exports = { run, tool, collect, project, normalizeResult, TOKEN_BUDGET, MAX_MESSAGES };
