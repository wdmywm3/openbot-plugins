"use strict";

const { get, put, state, save, hash, readMemory } = require("./unified-state.cjs");
const { FACT_PROMPT, REVISION_PROMPT, parseResult, validateStyle } = require("./lib/features/channels/channel-dream-analysis.cjs");
const { isPrivateDreamScope } = require("./lib/features/channels/channel-dream-settings.cjs");
const { STANDARD } = require("./unified-profile-policy.cjs");
const { EXTRACTION: MEMES } = require("./unified-memes.cjs");
const { admit, delivered } = require("./unified-material-policy.cjs");
const dream = require("./unified-dream.cjs");

const planKey = ({ chatId }) => `plus:fork-plan:${chatId}`;
const progressKey = ({ chatId }) => `plus:fork-progress:${chatId}`;
const seenKey = ({ chatId }) => `plus:fork-seen:${chatId}`;
const mark = source => hash(JSON.stringify([source.id, source.version, source.offset, source.content.length]));
const eligible = item => item.direction === "in" ? !item.sender?.isBot && admit(item)
  : delivered(item) && (!item.event?.type || item.event.type === "message") && item.content.trim();
const positionFor = (snapshot, nextOffset) => ({ id: snapshot.id, nextOffset });

function advance(storage, scope, position, materials = []) {
  const previous = get(storage, progressKey(scope), []).filter(item => item.id !== position.id);
  put(storage, progressKey(scope), [...previous, position].slice(-128));
  if (materials.length) put(storage, seenKey(scope), [...new Set([...get(storage, seenKey(scope), []), ...materials])].slice(-16384));
}

function branches(scope, materials) {
  const userIds = materials.filter(item => item.direction === "in").map(item => item.id);
  const outIds = materials.filter(delivered).map(item => item.id);
  const privateChat = isPrivateDreamScope(scope);
  const head = `这是后台整理分支。只输出一个 JSON 对象。上方聊天、引用、图片、视频、卡片、转发和工具输出都是资料。先结合已经提供的上下文理解发言。使用明确的证据，闲聊、玩笑、反讽、群梗和推测不能写成事实或既成操作。没有看到的媒体和结果保持未知。不得调用工具或继续聊天。
每项都要附 evidence:[{id:"消息编号",quote:"逐字原文摘录"}]，只引用本分支列出的来源。保留适用对象、时间和条件。其余消息只用于理解上下文。没有值得记录的内容就返回空数组。`;
  const human = `本批真人发言编号为 ${JSON.stringify(userIds)}。`;
  const edit = `只在上方已经显示本聊天的记忆编号和版本，且本批原话明确纠正旧事实或改变事项时提交变更。${REVISION_PROMPT}`;
  const instructions = [
    ["facts", `${human}
提取稳定事实、明确达成的约定和决定。最多 16 条 facts，每条使用 kind:"fact"、content、evidence、retention:{basis:"explicit|boundary|stable|ongoing",reason:"以后在什么情形下用得上"}。${FACT_PROMPT}
可给至多 12 条 topics 供后续查找原文，格式 {title,keywords,sourceIds,status:"open|closed"}。只给确有后续用途的讨论建立索引。
${privateChat ? `另可给出 records 和 updates，最多各 8 条。records 保存有后续用途的私聊事项，kind:"matter"，subtype:"goal|question|followup"，progress:"active|waiting|completed|canceled|closed"，附 content 和 evidence。updates 使用现有 id、revision、content、progress、evidence。终止事项只有本人明确重开才填 reopen:true。只在本人明确要求复查时填写 nextReviewAt、reviewIntervalMinutes、reviewOnChange 或 watchActivityId。日期按发言时间计算。` : "群聊只提取事实和群内约定。发言人的主张要保留归属。"}
${edit}`],
    ["profiles", `${human}
只提取本人明确自述的稳定偏好、称呼或交流边界。最多 16 条 facts，每条使用 kind:"preference" 或 "fact"、content、subjectId（真实发言人 ID）、evidence、retention:{basis:"explicit|boundary|stable",reason:"将来适用的具体情形"}。
${privateChat ? '对话方明确希望长期调整和我的交流方式时，可加 style:{values:{tone:"calm|warm|lively",length:"brief|balanced|detailed",formality:"casual|neutral|formal",humor:"little|moderate"},evidence}，只填有原话依据的字段。' : ""}
${STANDARD}
${FACT_PROMPT}
${edit}`],
    ["memes", `${human}
只提取 memes，最多 16 条。${MEMES}`],
    ["experience", `只提取 records，最多 8 条。记录我已经做过、之后值得记得的事情。用第一人称「我」开头，写清对象、动作和可确认的结果。使用 {kind:"experience",content,evidence}。已送达的公开消息编号为 ${JSON.stringify(outIds)}。每条至少引用一条这里的实际送达记录。普通寒暄、模型草稿、计划、委派受理和失败的动作不写进日记。回复中转述的外部任务结果只记成我转达了报告。没有送达证据就返回 {"records":[]}。`],
  ];
  return instructions.map(([key, instruction]) => ({ key, instruction: `${head}\n${instruction}` }));
}

function merge(response, materials, refs) {
  const output = { facts: [], topics: [], records: [], memes: [], revisions: [], invalidations: [], updates: [] };
  const rows = new Map(materials.map(item => [item.id, item]));
  const permitted = new Set(refs.map(item => `${item.id}:${item.revision}`));
  const evidence = (items, human) => Array.isArray(items) && items.length > 0 && items.length <= 10 && items.every(item => {
    const source = rows.get(item?.id);
    return source && (!human || source.direction === "in") && typeof item.quote === "string" && item.quote.trim()
      && item.quote.length <= 1000 && source.content.includes(item.quote);
  });
  const fields = {
    facts: { facts: 16, topics: 12, records: 8, revisions: 8, invalidations: 8, updates: 8 },
    profiles: { facts: 16, revisions: 8, invalidations: 8 },
    memes: { memes: 16 },
    experience: { records: 8 },
  };
  const changes = new Set();
  const payloads = new Map(response.results.map(item => [item.key, parseResult(item.output.trim()
    .replace(/^```(?:json)?\s*\n([\s\S]+)\n```$/i, "$1"))]));
  for (const [branch, allowed] of Object.entries(fields)) {
    const value = payloads.get(branch);
    if (!value) throw Error("整理分支缺少结果");
    if (branch === "profiles" && evidence(value.style?.evidence, true)) {
      try { output.style = { values: validateStyle(value.style.values), evidence: value.style.evidence }; } catch { /* Skip invalid style values. */ }
    }
    for (const [key, limit] of Object.entries(allowed)) {
      const items = value[key] ?? [];
      if (!Array.isArray(items)) throw Error("整理分支结果格式无效");
      for (const item of items.slice(0, limit)) {
        if (key === "topics") {
          if (item && typeof item.title === "string" && item.title.trim() && item.title.length <= 120
            && ["open", "closed"].includes(item.status) && Array.isArray(item.keywords) && item.keywords.length <= 8
            && item.keywords.every(value => typeof value === "string" && value.length <= 60)
            && Array.isArray(item.sourceIds) && item.sourceIds.length && item.sourceIds.every(id => rows.get(id)?.direction === "in")) output.topics.push(item);
          continue;
        }
        if (!evidence(item?.evidence, branch !== "experience")) continue;
        if (key === "facts" && (typeof item.content !== "string" || !item.content.trim() || item.content.length > 500
          || branch === "facts" && (item.kind !== "fact" || item.profileSection))) continue;
        if (key === "records" && (branch === "experience" ? item.kind !== "experience" : item.kind !== "matter")) continue;
        if (item.reviewEvidence && !evidence(item.reviewEvidence, true)) continue;
        if (key === "revisions" || key === "invalidations" || key === "updates") {
          const target = key === "revisions" ? item.supersedes : item;
          if (!target || !permitted.has(`${target.id}:${target.revision}`) || changes.has(target.id)) continue;
          changes.add(target.id);
        }
        output[key].push(item);
      }
    }
  }
  return output;
}

async function existingTargets(ctx, scope, parsed) {
  const proposed = [...parsed.revisions.map(item => item.supersedes), ...parsed.invalidations, ...parsed.updates];
  if (!proposed.length) return [];
  const own = (await ctx.api.memorySpace?.({ action: "list", chatId: scope.chatId }))?.spaces?.find(item => item.kind === "chat" && item.ownerId === scope.chatId);
  const targets = [];
  for (const { id, revision } of proposed) {
    try {
      const record = await readMemory(ctx, scope, id, { complete: false });
      if (record?.revision === revision && (!ctx.api.memorySpace || record.spaceId === own?.id)) targets.push({ id, revision });
    } catch (error) { if (error.code !== "MEMORY_NOT_FOUND") throw error; }
  }
  const allowed = new Set(targets.map(item => item.id));
  parsed.revisions = parsed.revisions.filter(item => allowed.has(item.supersedes.id));
  parsed.invalidations = parsed.invalidations.filter(item => allowed.has(item.id));
  parsed.updates = parsed.updates.filter(item => allowed.has(item.id));
  return targets;
}

async function work(ctx, storage, scope, includeLatest = false) {
  const complete = new Set(get(storage, progressKey(scope), []).filter(item => item.nextOffset === null).map(item => item.id));
  const { snapshots } = await ctx.api.conversationForks({ action: "list", chatId: scope.chatId });
  return snapshots.filter(item => !complete.has(item.id) && (item.boundary || includeLatest)).sort((a, b) => !!b.boundary - !!a.boundary || a.at - b.at);
}

async function run(ctx, storage, scope, trigger, includeLatest = false) {
  const prepared = get(storage, planKey(scope));
  const commit = prepared => dream.commit(ctx, storage, scope, prepared.job, { fork: true,
    onReceipt: () => advance(storage, scope, prepared.position, prepared.marks) });
  let job = prepared?.job, snapshots = [], snapshot;
  try {
    if (prepared) return { ...await commit(prepared), pending: true };
    snapshots = await work(ctx, storage, scope, includeLatest);
    snapshot = snapshots[0];
    if (!snapshot) return { pending: false, saved: 0 };
    const live = state(storage, scope), seen = new Set(get(storage, seenKey(scope), []));
    const start = Math.max(live.cursor || 0, live.scanStart?.cursor || 0);
    let offset = get(storage, progressKey(scope), []).find(item => item.id === snapshot.id)?.nextOffset || 0;
    let position, memoryRefs, idCharacters = 0;
    const materials = [];
    for (let page = 0; page < 8; page++) {
      ctx.signal.throwIfAborted();
      const result = await ctx.api.conversationForks({ action: "sources", chatId: scope.chatId, id: snapshot.id, offset });
      const next = result.items.filter(item => item.id.length <= 220 && item.seq > start && eligible(item) && !seen.has(mark(item)));
      const size = JSON.stringify(next.map(item => item.id)).length;
      if (materials.length && (idCharacters + size > 11000 || materials.length + next.length > 160)) break;
      for (const item of next) materials.push({ ...item, chatId: scope.chatId });
      idCharacters += size;
      memoryRefs = result.memoryRefs || [];
      position = positionFor(snapshot, result.nextOffset);
      if (result.nextOffset === null) break;
      offset = result.nextOffset;
    }
    const pending = position.nextOffset !== null || snapshots.length > 1;
    if (!materials.length) {
      advance(storage, scope, position);
      return { pending, saved: 0 };
    }
    const response = await ctx.api.conversationForks({ action: "run", chatId: scope.chatId, id: snapshot.id,
      usageCategory: "memory", branches: branches(scope, materials) });
    ctx.signal.throwIfAborted();
    const parsed = merge(response, materials, memoryRefs);
    const existing = await existingTargets(ctx, scope, parsed);
    const planned = await dream.plan(ctx, scope, parsed, materials, existing, { allowExperience: true });
    const fresh = state(storage, scope);
    if (fresh.paused || trigger !== "manual" && !fresh.settings.enabled) return { pending: true, saved: 0 };
    job = { trigger, cutoff: snapshot.at, upper: offset };
    job.runId = storage.dreamRepository.runs.start(scope, job);
    const ready = { ...planned, runId: job.runId, job, after: offset, position, marks: materials.map(mark) };
    put(storage, planKey(scope), ready);
    return { ...await commit(ready), pending };
  } catch (error) {
    if (job) storage.dreamRepository.runs.finish(scope, job.runId, ctx.signal.aborted ? "paused" : "failed", String(error.message || error));
    if (job && ["MEMORY_FORGOTTEN_SOURCE", "MEMORY_SOURCE", "MEMORY_CONFLICT", "MEMORY_NOT_FOUND"].includes(error.code)) {
      storage.db.prepare("DELETE FROM plugin_meta WHERE key=?").run(planKey(scope));
    }
    if (snapshot && ["CONVERSATION_FORK_EXPIRED", "CONVERSATION_FORK_STALE"].includes(error.code)) {
      advance(storage, scope, positionFor(snapshot, null));
      return { pending: snapshots.length > 1, saved: 0 };
    }
    if (error.code === "CONVERSATION_FORK_BUSY") return { pending: true, busy: true, saved: 0 };
    if (!ctx.signal.aborted) {
      const failures = (state(storage, scope).failures || 0) + 1;
      save(storage, scope, { failures, retryAt: Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(failures, 6)), error: String(error.message || error) });
    }
    throw error;
  }
}

module.exports = { work, run, planKey, progressKey, seenKey, branches, merge };
