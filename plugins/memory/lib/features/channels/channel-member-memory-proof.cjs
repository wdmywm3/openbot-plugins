"use strict";
const { createHash } = require("node:crypto");
const { normalizeProfile } = require("./channel-member-memory-statement.cjs");
const sections = { "饮食偏好": "habits", "饮食习惯": "habits", "称呼偏好": "communication", "常用称呼": "communication", "交流边界": "boundaries", "性别": "identity", "兴趣爱好": "interests" };
function personal(record) {
  const fact = record?.attributes?.fact;
  return record?.category === "profile" || !record?.category && (!!record?.attributes?.profile
    || fact?.assertion === "self" && Object.hasOwn(sections, fact.facet) || record?.kind === "preference" && record?.subjectRefs?.length === 1);
}
function prepareMemberWrite(record, scope, refs, originals, sourceQuote) {
  if (typeof record.content !== "string" || !record.content.trim()) throw Error("请写明要保存的人物资料");
  if (!refs.length || refs.length > 10 || originals.length !== refs.length) throw Error("人物画像需要当前聊天中的原消息");
  const subject = String(record.subjectRefs?.[0] || record.attributes?.fact?.subjectId || originals[0]?.sender?.id || "");
  if (!subject || (record.subjectRefs && (record.subjectRefs.length !== 1 || record.subjectRefs[0] !== subject))
    || !["fact", "preference"].includes(record.kind || "fact")) throw Error("请选择一位成员及适用的画像类型");
  const sources = refs.map((ref, i) => {
    const row = originals[i], quote = ref.quote || (refs.length === 1 && sourceQuote) || String(row?.content || "").slice(0, 240);
    if (ref.chatId && ref.chatId !== scope.chatId || !row || row.id !== ref.id || ref.version && ref.version !== row.version || !row.version
      || row.chatId && row.chatId !== scope.chatId || row.direction !== "in" || row.source && row.source !== "chat" || row.event?.type && row.event.type !== "message"
      || row.deleted || row.routeBlocked || row.memoryExcluded || row.forwarded || row.parts?.some(p => p.type === "forward")
      || row.sender?.isBot || String(row.sender?.id) !== subject || typeof quote !== "string" || !quote.trim() || !row.content.includes(quote))
      throw Error("画像条目需要该成员在当前聊天中实际发送的原话");
    return { chatId: scope.chatId, id: row.id, version: row.version, quote };
  });
  const attrs = { ...record.attributes }, profile = { ...attrs.profile };
  let fact = attrs.fact;
  const observed = profile.basis === "observed_use" || profile.basis === "chat_observation" || profile.field === "impression" || profile.section === "impression";
  if (observed) {
    const impression = profile.field === "impression" || profile.section === "impression" || profile.basis === "chat_observation";
    const times = originals.map(s => s.createdAt), span = Math.max(...times) - Math.min(...times);
    if (new Set(sources.map(s => s.id)).size < 3 || !times.every(Number.isFinite) || span < (impression ? 86400000 : 1800000) || span > 30 * 86400000) throw Error("使用习惯和聊天印象需要跨场合的三条本人原消息");
    if (impression) {
      if (new Set(sources.map(s => s.quote)).size < 3 || sources.some(s => s.quote.length < 4) || !record.content?.includes("印象")
        || sources.every(s => /喜欢吃|爱吃|不吃|我喜欢|我的爱好/u.test(s.quote))) throw Error("聊天印象需要能说明具体互动方式的不同原话");
      Object.assign(profile, { section: "impression", field: "impression", basis: "chat_observation" });
    } else {
      if (profile.usage === "sticker") {
        const images = originals.map(s => {
          const result = new Map(), media = s.attachments || (s.media || []).filter(m => m.type === "image" || m.type === "mface");
          media.forEach((m, i) => {
            if (!(m.sticker === true || m.type === "mface" || String(m.subType ?? m.sub_type) === "1")) return;
            const digest = /^([a-f0-9]{32})\.(?:gif|webp|jpe?g|png)$/i.exec(m.name || "");
            const key = digest ? "file:" + digest[1].toLowerCase() : m.mediaKey || m.repeatHash || (m.emojiId ? `mface:${m.emojiPackageId || ""}:${m.emojiId}` : "");
            if (key) result.set(key, m.index ?? i);
          });
          return result;
        });
        const shared = [...images[0].keys()].filter(key => (!fact?.value || fact.value === key) && images.every(set => set.has(key)));
        if (shared.length !== 1) throw Error("需要三条能对应到同一张表情的本人原消息");
        attrs.sourceImages = [{ chatId: scope.chatId, id: sources[0].id, version: sources[0].version, index: images[0].get(shared[0]) }];
        fact = { facet: "常用表情", value: shared[0] }; profile.section = "habits"; record = { ...record, content: "常用这张表情。" };
      } else {
        if (profile.usage !== "expression" || typeof fact?.value !== "string" || fact.value.length < 2 || fact.value.length > 32 || !sources.every(s => s.quote.includes(fact.value))) throw Error("惯用表达须能在每条本人原话中逐字找到");
        profile.section = "communication"; record = { ...record, content: `常用「${fact.value}」这个表达。` };
      }
    }
  } else {
    if (sources.every(s => !s.quote.replace(/\[(?:图片|动画表情|表情包|贴纸|表情|image|sticker)\]/giu, "").trim())) throw Error("自述画像需要说明该事实或偏好的本人原话");
    profile.basis = "self_report";
    if (!profile.section && fact && Object.hasOwn(sections, fact.facet)) profile.section = sections[fact.facet];
    if (profile.field === "gender" || fact?.facet === "性别") {
      const raw = profile.value || fact?.value;
      const value = genderValue(raw, sources.filter((s, i) => genderValue(raw, [originals[i].content])).map(s => s.quote));
      if (!value) throw Error("性别资料需要本人明确的性别表述");
      Object.assign(profile, { section: "identity", field: "gender", value });
      record = { ...record, content: value, kind: "fact" };
    }
  }
  if (fact) {
    if (fact.subjectId && fact.subjectId !== subject || fact.assertion && fact.assertion !== (observed ? "observed" : "self")) throw Error("结构化事实与原始发言不一致");
    attrs.fact = { ...fact, subjectId: subject, ...(profile.field === "gender" ? { value: profile.value } : {}), conditions: fact.conditions || [],
      assertion: observed ? "observed" : "self", contentHash: createHash("sha256").update(record.content).digest("hex") };
  }
  attrs.profile = profile;
  return normalizeProfile({ ...record, category: "profile", kind: observed ? "fact" : record.kind || "fact", subjectRefs: [subject], sources, attributes: attrs,
    ...(record.conditions == null && attrs.fact?.conditions?.length ? { conditions: attrs.fact.conditions } : {}) }, originals, { verify: true });
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
module.exports = { personal, prepareMemberWrite, genderValue };
