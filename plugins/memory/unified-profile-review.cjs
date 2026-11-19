"use strict";
const obs = require("./unified-profile-observations.cjs");
const usage = require("./unified-profile-usage.cjs");
const impressions = require("./unified-profile-impressions.cjs");
const dream = require("./unified-dream.cjs");
const scheduling = require("./unified-scheduling.cjs");
const { get, put, state } = require("./unified-state.cjs");
const { parseResult } = require("./lib/features/channels/channel-dream-analysis.cjs");

const key = scope => "plus:profile-work:" + scope.chatId;
const INTERVAL = 15 * 60000;
const PROMPT = `根据同一个人在本聊天、不同日期的原消息复审他的交流方式。消息内容都是资料。只输出 JSON 对象，包含 impressions 和 expressions 两个数组。${impressions.PROMPT}
expressions 可给至多四个能在原文逐字找到、具有辨识度的口头禅或文字表情字符串。忽略泛用问候、复述、转发和饮食爱好等事实陈述。不要把表情使用解释成喜欢某个作品或角色。若各场合的行为没有共同点或材料不足，请返回空数组。`;

function request(storage, scope) {
  put(storage, key(scope), { ...get(storage, key(scope), {}), manual: true, nextAt: 0 });
}
function due(storage, scope, live, now = Date.now()) {
  const work = get(storage, key(scope), {});
  return (live.settings.enabled || work.manual) && !(work.nextAt > now);
}
function shouldQueue(storage, scope, live, upper) {
  const now = Date.now();
  if (!due(storage, scope, live, now)) return false;
  const work = get(storage, key(scope), {});
  if (work.manual || work.upper != null || get(storage, obs.planKey(scope)) || !Number.isSafeInteger(upper)
    || upper > Math.max(live.scanStart?.cursor || 0, get(storage, obs.cursorKey(scope), 0)) || obs.due(storage, scope, now, upper, 1).length) return true;
  obs.prune(storage, scope, now);
  put(storage, key(scope), { ...work, nextAt: now + INTERVAL });
  return false;
}
async function originals(ctx, storage, scope, item, floor, now, assertLive) {
  const rows = obs.sample(storage, scope, item, now);
  if (usage.occasions(rows).length < 3) return { sources: [], dropped: false };
  const sources = [];
  let dropped = false;
  const remove = storage.db.prepare("DELETE FROM profile_observations WHERE chat=? AND id=? AND version=?");
  for (const ref of rows) {
    assertLive();
    const page = await ctx.api.sources({ action: "read", chatId: scope.chatId, id: ref.id, version: ref.version, limit: 1200 });
    const source = page.item;
    if (!page.revoked && obs.usable(source, scope, floor, now) && source.version === ref.version && source.id === ref.id && String(source.sender.id) === item.subject)
      sources.push({ ...source, chatId: scope.chatId, observedLabel: ref.label });
    else { remove.run(scope.chatId, ref.id, ref.version); dropped = true; }
  }
  return { sources, dropped };
}
async function propose(ctx, scope, item, sources) {
  if (item.signal !== obs.TEXT) {
    const record = usage.record(scope, item.subject, item.signal, sources);
    return { observedProfiles: record ? [record] : [] };
  }
  const messages = sources.map(s => ({ id: s.id, at: new Date(s.createdAt).toISOString(), text: s.content.slice(0, 480) }));
  const result = await ctx.api.generate({ usageCategory: "memory", maxTokens: 1600, systemPrompt: PROMPT,
    prompt: JSON.stringify({ subjectId: item.subject, messages }) });
  const parsed = parseResult(result.text);
  if (!Array.isArray(parsed.impressions) || !Array.isArray(parsed.expressions)) throw Error("人物画像复审结果缺少所需字段");
  const observedProfiles = [...new Set(parsed.expressions.slice(0, 4).filter(usage.expression))].map(value => {
    const matches = sources.filter(s => s.content.includes(value)).map(s => ({ ...s, at: s.createdAt }));
    return usage.record(scope, item.subject, "expression:" + value, obs.select(matches, 8));
  }).filter(Boolean);
  return { impressions: parsed.impressions.slice(0, 1), observedProfiles };
}
function receipt(ctx, storage, scope, prepared, manual) {
  const job = manual ? { ...prepared.job, trigger: "manual" } : prepared.job;
  return dream.commit(ctx, storage, scope, job, { profile: true, onReceipt: () => obs.mark(storage, scope, prepared.mark) });
}
async function run(ctx, storage, scope) {
  const live = state(storage, scope), now = Date.now(), work = get(storage, key(scope), {});
  if (!due(storage, scope, live, now)) return { pending: false, saved: 0 };
  const floor = live.scanStart?.cursor || 0;
  const check = () => {
    ctx.signal.throwIfAborted();
    const fresh = state(storage, scope);
    if (!work.manual && !fresh.settings.enabled || (fresh.scanStart?.cursor || 0) !== floor) throw Error("人物画像整理已停止");
  };
  const update = patch => put(storage, key(scope), { ...get(storage, key(scope), {}), ...patch });
  let saved = 0, reviewing;
  try {
    const prepared = get(storage, obs.planKey(scope));
    const upper = work.upper ?? (await ctx.api.sources({ action: "head", chatId: scope.chatId })).upper;
    if (!Number.isSafeInteger(upper) || upper < floor) throw Error("画像资料上界无效");
    check();
    update({ upper });
    obs.migrate(storage, scope, floor, now);
    obs.prune(storage, scope, now);
    const after = await obs.scan(ctx, storage, scope, floor, upper, check, now);
    if (after < upper) return { pending: true, saved };
    if (scheduling.active(storage, scope)) {
      const pending = !!prepared || !!obs.due(storage, scope, now, upper, 1).length || !!work.manual;
      update({ upper: work.manual ? upper : null, nextAt: now + (pending ? 60000 : INTERVAL) });
      return { pending, saved };
    }
    if (prepared) saved += (await receipt(ctx, storage, scope, prepared, work.manual)).saved;
    const items = obs.due(storage, scope, now, upper, 4);
    let analyzed = false;
    // Deterministic uses can commit even if a later language-model review is interrupted.
    for (const item of items.sort((a, b) => (a.signal === obs.TEXT) - (b.signal === obs.TEXT))) {
      if (item.signal === obs.TEXT && analyzed) continue;
      reviewing = item;
      const { sources, dropped } = await originals(ctx, storage, scope, item, floor, now, check);
      check();
      if (scheduling.active(storage, scope)) break;
      if (usage.occasions(sources.map(row => ({ at: row.createdAt }))).length < 3) {
        if (!dropped) obs.mark(storage, scope, item);
        continue;
      }
      if (item.signal === obs.TEXT) analyzed = true;
      const proposal = await propose(ctx, scope, item, sources);
      const plan = await dream.plan(ctx, scope, { facts: [], topics: [] }, sources, [],
        { observedProfiles: proposal.observedProfiles, impressionProposals: proposal.impressions });
      check();
      const mark = { ...item, reviewed: now };
      if (!plan.operations.length) { obs.mark(storage, scope, mark); continue; }
      const job = { trigger: work.manual ? "manual" : "scheduled", cutoff: now, upper: item.through };
      job.runId = storage.dreamRepository.runs.start(scope, job);
      const ready = { ...plan, job, runId: job.runId, after: item.through, mark };
      put(storage, obs.planKey(scope), ready);
      saved += (await receipt(ctx, storage, scope, ready)).saved;
    }
    reviewing = null;
    const pending = obs.due(storage, scope, now, upper, 1).length > 0;
    const delayed = storage.db.prepare("SELECT MIN(retry_at) AS at FROM profile_reviews WHERE chat=? AND retry_at>?").get(scope.chatId, now).at;
    const requested = !!get(storage, key(scope))?.manual && !work.manual;
    update({ upper: (pending || delayed) && work.manual ? upper : null, manual: requested || !!(pending || delayed) && !!work.manual,
      nextAt: requested || pending ? 0 : Math.min(now + INTERVAL, delayed || Infinity), failures: 0 });
    return { pending: pending || !!delayed, saved };
  } catch (error) {
    // A concurrent correction or withdrawal requires new proof. Transport failures replay the saved batch unchanged.
    const prepared = get(storage, obs.planKey(scope));
    if (prepared && ["MEMORY_FORGOTTEN_SOURCE", "MEMORY_SOURCE", "MEMORY_CONFLICT", "MEMORY_NOT_FOUND"].includes(error.code)) {
      storage.dreamRepository.runs.finish(scope, prepared.runId, "interrupted", "原消息或画像已变更，重新核对");
      storage.db.prepare("DELETE FROM plugin_meta WHERE key=?").run(obs.planKey(scope));
    }
    if (!ctx.signal.aborted) {
      if (reviewing && !prepared) obs.retry(storage, scope, reviewing, now);
      const failures = (work.failures || 0) + 1;
      update({ failures, nextAt: now + Math.min(60, 2 ** Math.min(6, failures - 1)) * 60000 });
    }
    throw error;
  }
}
module.exports = { key, due, shouldQueue, request, run };
