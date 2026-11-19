"use strict";
const { createHash } = require("node:crypto");
const digest = value => createHash("sha256").update(value).digest("hex");
const sections = { identity: "基础资料", habits: "生活习惯", interests: "兴趣爱好", communication: "交流偏好", boundaries: "交流边界", self_description: "自我描述" };
const bases = new Set(["self_report", "observed_use", "chat_observation", "manual", "reported"]);
const foodFacet = /^(?:饮食习惯|饮食偏好|饮食口味|口味偏好)$/u;
const tidy = s => String(s || "").trim().replace(/[。.]$/u, "");

// Only compare a simple food claim to an explicit clause about the same food.
// In particular, 不吃、喜欢吃、不喜欢吃 have independent meanings.
function foodClaim(value) {
  const match = /^(不喜欢|不爱|讨厌|喜欢|爱|不)?(吃|喝)([\p{L}]{1,18})$/u.exec(tidy(value));
  if (!match) return null;
  const op = match[1] || "";
  return { attitude: ["不喜欢", "不爱", "讨厌"].includes(op) ? "dislike" : ["喜欢", "爱"].includes(op) ? "like" : op === "不" ? "avoid" : "consume",
    verb: match[2], food: match[3] };
}
function facetFor(fact, statement) {
  if (!fact?.facet) return "";
  if (!foodFacet.test(fact.facet)) return fact.facet;
  const claim = foodClaim(fact.value) || foodClaim(statement);
  return claim ? (["avoid", "consume"].includes(claim.attitude) ? "饮食习惯" : "饮食偏好") : fact.facet;
}
function profileInfo(record) {
  if (record?.category !== "profile" || record.subjectRefs?.length !== 1 || typeof record.subjectRefs[0] !== "string") return null;
  const { profile = {}, fact } = record.attributes || {};
  const basis = bases.has(profile.basis) ? profile.basis : fact?.assertion === "self" && record.sources?.length ? "self_report"
    : fact?.assertion === "reported" && record.sources?.length ? "reported" : record.updatedBy?.startsWith("desktop:") ? "manual" : "";
  const namedFacet = typeof profile.facet === "string" ? profile.facet.trim() : "";
  const facet = profile.field === "gender" ? "性别" : profile.field === "impression" ? "聊天印象"
    : namedFacet || (fact?.facet === "preferred_address" ? "常用称呼" : facetFor(fact, record.content)) || sections[profile.section] || "";
  return { facet, basis };
}
function unprefixed(record, originals) {
  let body = record.content.trim();
  const subject = record.subjectRefs[0], { profile = {}, fact } = record.attributes || {};
  if (profile.field === "gender" && typeof profile.value === "string" && profile.value.trim()) return profile.value.trim();
  const names = new Set([subject, `QQ ${subject}`, `群成员 QQ ${subject}`, `群成员 ${subject}`]);
  for (const row of originals) if (String(row?.sender?.id) === subject)
    for (const name of [row.sender.card, row.sender.name, row.sender.nickname]) if (typeof name === "string" && name.trim()) names.add(name.trim());
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (!body.startsWith(name)) continue;
    const rest = body.slice(name.length).trimStart();
    if (profile.basis === "observed_use" && /^(?:聊天时|发言时)常用/u.test(rest)) body = rest.replace(/^(?:聊天时|发言时)/u, "");
    else if (profile.basis === "chat_observation" && rest.startsWith("在聊天中")) body = rest.slice(4);
    else if (profile.basis === "self_report" || fact?.assertion === "self") {
      const speech = /^(?:本人)?(?:自述|自称|表示|说过|说(?=[，,:：\s]))[，,:：\s]*/u.exec(rest);
      if (speech) body = rest.slice(speech[0].length);
      else if (fact && rest.startsWith("说") && tidy(rest.slice(1)) === tidy(fact.value)) body = rest.slice(1);
      else if (fact && tidy(rest) === tidy(fact.value)) body = rest;
      else if (/^(?:平时|通常|只在|从不|到现在|有时|喜欢|不喜欢|不吃|习惯)/u.test(rest)
        && originals.some(s => String(s?.sender?.id) === subject && tidy(s.content) === "我" + tidy(rest))) body = rest;
    }
    break;
  }
  if ((profile.basis === "self_report" || fact?.assertion === "self") && body.startsWith("本人自述")) body = body.slice(4).replace(/^[，,:：\s]+/u, "");
  if (fact?.assertion === "self" && body.startsWith("我") && tidy(body.slice(1)) === tidy(fact.value)) body = body.slice(1);
  return body.trim() || record.content;
}
function normalizeProfile(record, originals = [], { verify = false } = {}) {
  const info = profileInfo(record);
  if (!info || typeof record.content !== "string" || record.nextOffset != null) return record;
  const attrs = record.attributes || {}, fact = attrs.fact;
  if (fact?.contentHash && fact.contentHash !== digest(record.content)) return record;
  let content = unprefixed(record, originals), conditions = record.conditions || [], factConditions = fact?.conditions || [];
  if (verify && info.basis === "self_report" && (foodFacet.test(fact?.facet) || !fact && foodClaim(content))) {
    const claim = foodClaim(fact?.value), bodyClaim = foodClaim(content);
    const cited = new Set((record.sources || []).map(ref => {
      const original = originals.find(row => row.id === ref.id && row.version === ref.version);
      return original?.content || ref.quote;
    }).filter(Boolean));
    const clauses = [...cited].flatMap(quote => quote.split(/[，。！？、,;；!?\s]+/u)).flatMap(raw => {
      const clause = raw.replace(/^(?:我|本人)(?:到现在|至今)?/u, "");
      const parts = /^((?:只在|在|只有)[\p{L}]{1,18}?|这几天|这周|今天|暂时|最近|平时|一般|现在|一直|从来)?((?:不喜欢|不爱|讨厌|喜欢|爱|不)?(?:吃|喝)[\p{L}]{1,18})$/u.exec(clause);
      const parsed = parts && foodClaim(parts[2]);
      return parsed ? [{ ...parsed, scope: parts[1] || "" }] : [];
    });
    const conflicts = proposed => {
      if (!proposed) return false;
      const about = clauses.filter(c => c.food === proposed.food && c.verb === proposed.verb);
      return about.length && !about.some(c => c.attitude === proposed.attitude);
    };
    if (conflicts(claim) || conflicts(bodyClaim) || claim && bodyClaim && claim.food === bodyClaim.food && claim.verb === bodyClaim.verb && claim.attitude !== bodyClaim.attitude) {
      const error = new Error("饮食习惯与口味偏好需要各自的本人原话，请按原意记录"); error.code = "PROFILE_EVIDENCE"; throw error;
    }
    if (bodyClaim) {
      const scopes = [...new Set(clauses.filter(c => c.food === bodyClaim.food && c.verb === bodyClaim.verb && c.attitude === bodyClaim.attitude).map(c => c.scope))];
      if (scopes.length && !scopes.includes("")) {
        if (scopes.length > 1) throw Object.assign(new Error("餐饮原话有不同的适用条件，请在正文中写明"), { code: "PROFILE_EVIDENCE" });
        content = scopes[0] + content;
        if (!conditions.some(value => typeof value === "string" && scopes[0].includes(value))) conditions = [...conditions, scopes[0]];
        factConditions = conditions;
      }
    }
  }
  const facet = fact && facetFor(fact, content);
  const profile = attrs.profile || (info.basis ? { basis: info.basis } : undefined);
  const diet = info.basis === "self_report" && fact?.assertion === "self" && foodFacet.test(fact.facet) && foodClaim(fact.value);
  const kind = diet ? (facet === "饮食习惯" ? "fact" : "preference") : record.kind;
  if (content === record.content && kind === record.kind && (!fact || facet === fact.facet) && profile === attrs.profile) return record;
  return { ...record, content, kind, ...(conditions.length ? { conditions } : {}), attributes: { ...attrs, ...(profile ? { profile } : {}),
    ...(fact ? { fact: { ...fact, facet, conditions: factConditions, contentHash: digest(content) } } : {}) } };
}
function changeTime(changeType, patch, sources, refs = []) {
  if (changeType !== "change" || patch?.validFrom != null) return {};
  const at = sources.filter(s => Number.isSafeInteger(s?.createdAt) && s.createdAt > 0
    && /(?:从现在|从今天|我(?:现在|目前)(?:也|已经|才)?(?:开始|改为|改成|不再|吃|喝)|starting today|as of now)/iu.test(refs.find(r => r.id === s.id && r.version === s.version)?.quote || s.content || "")).map(s => s.createdAt);
  return at.length ? { validFrom: Math.max(...at) } : {};
}
module.exports = { normalizeProfile, profileInfo, facetFor, changeTime };
