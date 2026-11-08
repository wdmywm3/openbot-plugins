"use strict";

const CATEGORY = "meme";
const FIELDS = new Set(["term", "meaning", "usage", "evidence"]);
const normalize = text => text.normalize("NFKC").trim().replace(/\s+/gu, " ");
const key = text => normalize(text).toLowerCase();
const mention = /@\S|<at\b|\[CQ:at[,\]]/iu;

const EXTRACTION = `提取可在不同聊天中使用的公开网络梗、谐音和流行说法。只提取本批真人原话已明确解释的通用用法。跳过只在本群成立的故事、给群友起的绰号和针对某个人的调侃。词条只保留词、含义和适用语境。原文摘录应包含词和解释，并避开成员称呼和无关群聊内容。
用 memes 提交，例如 {"term":"有猫饼","meaning":"是「有毛病」的谐音，用于玩笑式吐槽。","evidence":[{"id":"s1","quote":"有猫饼就是有毛病的谐音，逗人用的"}]}。usage 可补一条通用语境或变体用法。`;
const PROMPT = `${EXTRACTION}每条按梗词查旧记忆。同词同义沿用已保存的梗词、释义和语境补证据，不同用法分开。通用释义被明确纠正时，用 invalidations 停用旧词义，正确释义仍由 memes 提交。事实和梗词合计最多 64 条。`;

function facts(items, materials, containsSecret) {
  if (!Array.isArray(items) || items.length > 64) throw Error("梗词提案格式无效或条目过多");
  if (!items.length) return [];
  const memberNames = new Set(materials.flatMap(item => [item.sender?.id, item.senderId, item.sender?.name, item.sender?.card, item.sender?.nickname])
    .filter(value => typeof value === "string" && value.trim()).map(key));
  const memberLabels = [...memberNames].filter(label => label.length >= 2);
  return items.flatMap(item => {
    if (!item || typeof item !== "object" || Object.keys(item).some(field => !FIELDS.has(field))
      || typeof item.term !== "string" || typeof item.meaning !== "string"
      || item.usage !== undefined && typeof item.usage !== "string") return [];
    const term = normalize(item.term), meaning = item.meaning.trim(), usage = item.usage?.trim();
    const termKey = term.toLowerCase();
    if (!termKey || term.length > 64 || memberNames.has(termKey) || !meaning || meaning.length > 240
      || key(meaning) === termKey || (usage?.length || 0) > 160) return [];
    if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 10
      || item.evidence.some(ref => typeof ref?.quote !== "string" || ref.quote.length > 1000)) return [];
    const quotes = item.evidence.map(ref => key(ref.quote));
    if (!quotes.some(quote => quote.includes(termKey) && /[\p{L}\p{N}]/u.test(quote.replaceAll(termKey, "")))) return [];
    const content = `「${term}」${meaning}${usage ? `\n${usage}` : ""}`;
    if ([key(content), ...quotes].some(text => mention.test(text) || containsSecret(text)
      || memberLabels.some(label => text.includes(label)))) return [];
    return [{
      kind: "fact", content, evidence: item.evidence,
      retention: { basis: "stable", reason: "以后遇到这个网络梗时，可依据其通用含义和用法接话" },
      fact: { subjectId: termKey, facet: "meme_meaning", value: meaning, conditions: usage ? [usage] : [] },
    }];
  });
}

module.exports = { CATEGORY, PROMPT, EXTRACTION, facts };
