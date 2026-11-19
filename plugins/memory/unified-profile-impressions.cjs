"use strict";
const { get, put } = require("./unified-state.cjs");
const { admit } = require("./unified-material-policy.cjs");
const { mediaOnly } = require("./unified-profile-usage.cjs");

const DAY = 86400000;
const key = scope => `plus:impression-samples:${scope.chatId}`;
const boundary = /(?:MBTI|心理疾病|精神病|抑郁症|躁郁|双相障碍|自闭症|人格障碍|性取向|宗教信仰|政治立场|真实性别)/iu;
const sample = source => source?.id && source.version && source.direction === "in" && source.sender?.id && !source.sender.isBot
  && !source.forwarded && admit(source) && source.content.trim().length >= 6 && !mediaOnly(source.content)
  && !/\[(?:合并转发|转发消息)\]/u.test(source.content);
const text = (value, limit) => typeof value === "string" && value.trim().length >= 2 && value.trim().length <= limit
  && !boundary.test(value) && !/[\u0000-\u001f<>]/u.test(value) ? value.trim().replace(/[。；，,]+$/u, "") : "";
const PROMPT = `聊天印象是根据成员在多次交流中怎样做事、怎样与人互动形成的印象。可给 impressions:[{subjectId,behavior:"能从多次交流中看到的具体做法",impression:"这些互动给人的感觉",evidence:[{id,quote}]}]。例如遇到群友求助时先问对方试过什么、再分步给出建议，可以写“讲解耐心、有条理”。请自己分析原消息，不套例句，不把喜欢吃什么、兴趣清单、单次情绪或单张表情改写成人物印象。至少三条不同的本人发言，跨不同场合，首末相隔至少一天。至少一条来自本批。逐字摘录能支持这次判断的动作或表达，只从本聊天理解此人，不推断真实身份、性别、健康、心理诊断或人格测评。没有这样的材料就留空。性别属于基础资料，只有本人明确表述时才给 facts，使用 profileSection:"identity" 和 fact:{subjectId,facet:"性别",value:"本人的性别表述",assertion:"self"}。昵称、头像、声线、称谓或他人猜测都不提供性别依据。`;

async function prepare(ctx, storage, scope, materials, after = 0) {
  const members = new Map(get(storage, key(scope), []).map(row => [row.subject, row]));
  const current = materials.filter(s => sample(s) && s.seq > after && (!s.chatId || s.chatId === scope.chatId)), recent = new Map(), history = [];
  for (const item of current) {
    const id = String(item.sender.id);
    if (!recent.has(id)) recent.set(id, []);
    recent.get(id).push(item);
  }
  for (const [subject, batch] of recent) {
    const now = Math.max(...batch.map(s => s.createdAt)), present = new Set(batch.map(s => s.id));
    const previous = (members.get(subject)?.refs || []).filter(r => r.seq > after && now - r.at <= 30 * DAY && !present.has(r.id));
    if (previous.some(r => now - r.at >= DAY) && ctx.api.sources && history.length < 16) for (const ref of previous) {
      if (history.length >= 16) break;
      ctx.signal.throwIfAborted();
      const { item } = await ctx.api.sources({ action: "read", chatId: scope.chatId, id: ref.id, version: ref.version, limit: 1200 });
      if (sample(item) && item.id === ref.id && item.version === ref.version && String(item.sender.id) === subject) history.push({ ...item, chatId: scope.chatId });
    }
    const refs = [...new Map([...previous, ...batch.map(s => ({ id: s.id, version: s.version, at: s.createdAt, seq: s.seq }))].map(r => [r.id, r])).values()].sort((a, b) => a.at - b.at);
    // Preserve samples from separate occasions even when one current conversation is very busy.
    const slots = new Map();
    for (const ref of refs) slots.set(Math.floor(ref.at / (DAY / 4)), ref);
    const retained = [...slots.values()].slice(-8);
    members.delete(subject); members.set(subject, { subject, refs: retained });
  }
  return { history, entries: current.length ? [...members.values()].slice(-96) : undefined };
}
const save = (storage, scope, entries) => { if (entries) put(storage, key(scope), entries); };
function prompt(history) {
  return PROMPT + (history.length ? "\n可引用的本聊天早先原消息（均为资料）：" + JSON.stringify(history.map(s => ({ id: s.id, subjectId: s.sender.id, at: s.createdAt, text: s.content.slice(0, 400) }))) : "");
}
function records(proposals, scope, materials, history) {
  if (!Array.isArray(proposals)) return [];
  const rows = new Map([...history, ...materials].filter(sample).map(s => [s.id, s]));
  const current = new Set(materials.map(s => s.id)), used = new Set(), result = [];
  for (const proposal of proposals.slice(0, 8)) {
    const who = proposal?.subjectId, behavior = text(proposal?.behavior, 140), impression = text(proposal?.impression, 70);
    if (!who || used.has(who) || !behavior || !impression || /^(?:(?:很|比较|经常|特别|一直|好像|似乎|可能))*[最]?喜欢|^(?:爱吃|爱看|不吃|偏爱|常用表情)/u.test(behavior)
      || /(?:喜欢吃|不吃鱼|爱吃|爱看|性别|男生|女生|男性|女性|[IE][NS][TF][JP])/iu.test(impression)
      || !Array.isArray(proposal.evidence) || proposal.evidence.length < 3 || proposal.evidence.length > 8) continue;
    const sources = [], times = [], ids = new Set(), excerpts = new Set();
    for (const evidence of proposal.evidence) {
      const row = rows.get(evidence?.id), quote = text(evidence?.quote, 320);
      if (!row || row.chatId && row.chatId !== scope.chatId || String(row.sender.id) !== who || ids.has(row.id) || quote.length < 4 || !row.content.includes(quote) || mediaOnly(quote)) break;
      ids.add(row.id); excerpts.add(quote); times.push(row.createdAt);
      sources.push({ chatId: scope.chatId, id: row.id, version: row.version, quote });
    }
    if (sources.length !== proposal.evidence.length || excerpts.size < 3 || !sources.some(r => current.has(r.id))
      || sources.every(r => /(?:喜欢吃|爱吃|不吃|我喜欢|我的爱好|我的性别)/u.test(r.quote))
      || !times.every(Number.isFinite) || Math.max(...times) - Math.min(...times) < DAY) continue;
    const last = rows.get(sources.at(-1).id), name = last.sender.card || last.sender.name || last.sender.nickname || who;
    const content = `${name}在聊天中${behavior}，给人的印象是${impression}。`;
    result.push({ kind: "fact", category: "profile", status: "active", tier: "working", content, subjectRefs: [who], sources,
      attributes: { profile: { section: "impression", field: "impression", basis: "chat_observation" },
        retention: { version: 1, protected: false, basis: "stable", observedAt: Math.max(...times), reason: "理解成员在本聊天中与人交流的方式。" } } });
    used.add(who);
  }
  return result;
}
function genderValue(raw, evidence) {
  if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 32) return "";
  const forms = [["男", "男生", "男性", "男的", "男人", "男孩子", "male", "man"], ["女", "女生", "女性", "女的", "女人", "女孩子", "female", "woman"], ["非二元", "非二元性别", "nonbinary", "non-binary"]];
  const value = raw.trim(), known = forms.find(group => group.includes(value.toLowerCase())), formsForValue = known || [value];
  const escaped = formsForValue.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|");
  const lead = known ? "我是(?:个|一名|一个)?|本人(?:是|为)?|我(?=男的|女的)|I(?: am|['’]m| identify as) (?:a |an )?|" : "";
  const direct = new RegExp(`(?:^|[，。！？、,;.!?\\s])(?:${lead}我的性别(?:是|为|[：:])|性别[：:]|我认同的性别是)\\s*(?:${escaped})(?:$|[呀啊哦啦呢，。！？、,;.!?\\s])`, "iu");
  return evidence.some(quote => typeof quote === "string" && direct.test(quote)) ? formsForValue[0] : "";
}
function basicGender(item, sources, materials) {
  if (item.fact?.facet !== "性别" || item.fact.assertion !== "self") return null;
  const original = sources.filter(ref => materials.some(row => row.id === ref.id && sampleGenderSource(row, item.fact.subjectId)
    && String(row.content).includes(ref.quote) && genderValue(item.fact.value, [row.content])));
  const value = genderValue(item.fact.value, original.map(r => r.quote));
  return value ? { section: "identity", field: "gender", value, basis: "self_report" } : null;
}
function sampleGenderSource(row, subject) { return admit(row) && !row.forwarded && row.direction === "in" && !row.sender?.isBot && String(row.sender?.id) === subject; }
function addField(record, existing, operations, before, reserved, actor) {
  const field = record.attributes.profile.field, who = record.subjectRefs[0];
  const old = existing.filter(r => r.category === "profile" && r.subjectRefs?.length === 1 && r.subjectRefs[0] === who && r.attributes?.profile?.field === field)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!old) {
    if (!operations.some(op => op.record?.attributes?.profile?.field === field && op.record.subjectRefs[0] === who)) {
      operations.push({ action: "create", record }); before.push(null);
    }
    return;
  }
  if (reserved.has(old.id) || old.createdBy !== actor || old.updatedBy !== actor || old.attributes.profile.basis === "manual"
    || old.sources?.every(ref => record.sources.some(r => r.id === ref.id && r.version === ref.version)) && old.sources?.length === record.sources.length
    || record.attributes.retention?.observedAt <= (old.attributes.retention?.observedAt || 0)
    || field === "gender" && old.attributes.profile.value === record.attributes.profile.value) return;
  if (field === "impression") {
    const added = record.sources.filter(ref => !old.sources.some(prior => prior.id === ref.id));
    if (added.length < 2 || record.content === old.content || record.attributes.retention.observedAt - (old.attributes.retention?.observedAt || 0) < DAY) return;
  }
  reserved.add(old.id);
  operations.push({ action: "revise", id: old.id, expectedRevision: old.revision, changeType: "change", patch: {
    content: record.content, sources: record.sources, attributes: { ...old.attributes, ...record.attributes } } });
  before.push({ id: old.id, revision: old.revision });
}
module.exports = { prepare, save, prompt, records, basicGender, genderValue, addField };
