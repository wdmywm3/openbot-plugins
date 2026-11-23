"use strict";
const { human, delivered } = require("./unified-material-policy.cjs");
const { admission, usefulReason, VERSION } = require("./unified-retention.cjs");

const BASIS = "observed";
const MAX_RECORDS = 8;
const MAX_PART_CHARACTERS = 220;
const PARTS = ["heard", "did", "learned"];
const PROMPT = `从当前 Bot 自己的视角整理亲历，只保留以后交流或做事时确有具体用途的片段。把同一件事写进一条经历。可记录我从谁那里得知什么、我实际做了什么、经纠正或得到结果后我学到了什么。保留具体情境、人物和经验的适用条件。没有值得再次用到的内容就不写，普通寒暄、例行问答、能力介绍、纯发送状态留在原记录里。
最多 ${MAX_RECORDS} 条。每条 records 使用 {kind:"experience",parts:[{kind:"heard|did|learned",text:"我……",evidence:[{id,quote}]}],retention:{basis:"${BASIS}",reason:"这段经历将帮助我在什么具体场景做什么"}}。每种片段至多一段，只填有依据的片段。每段以「我」开头，最多 ${MAX_PART_CHARACTERS} 字，附 1 至 3 条逐字摘录，只用本批编号。
若真人明说记住某次已送达的结果，basis 使用 explicit；若真人说明具体未完事项需要用到这次已送达的结果，可用 ongoing。两者都要在 retention.sourceId 填说明用途的真人消息编号，并把该原话和实际送达的回复列入各段依据。其他有具体用途的亲历使用 ${BASIS}，无需等真人提出保存要求。
heard 引用真人实际说过的内容，写清是听谁说的；转述、计划和猜测保留其原有语气。did 至少引用一条 Bot 实际送达的回复，写清这次互动中的动作。回复里的完成自述只能证明我曾这样报告；要记外部结果，还须引用能证实结果的原话。learned 至少引用一条真人的纠正、反馈或结果，写清以后怎么做以及适用条件。把学到的做法写成经验，不捏造情绪或隐含承诺，不改写用户偏好和权限。`;

function requestedPolicy(item, materials, scope) {
  const purpose = item.retention;
  if (!/^我/u.test(item.content || "") || !["explicit", "ongoing"].includes(purpose?.basis)
    || !purpose.sourceId || !Array.isArray(item.evidence)) return null;
  const supported = admission({ ...item, evidence: item.evidence.filter(ref => ref?.id === purpose.sourceId) }, materials, scope);
  if (!supported || !item.evidence.some(ref => materials.some(source => source.id === ref?.id && delivered(source)))) return null;
  supported.attributes.retention.sourceId = purpose.sourceId;
  return supported;
}

function record(item, materials, scope, containsSecret) {
  const reason = usefulReason(item.retention?.reason);
  if (!reason || containsSecret(reason) || !Array.isArray(item.parts)
    || !item.parts.length || item.parts.length > PARTS.length) return null;
  const parts = new Map(), refs = new Map();
  let observedAt = 0;
  for (const part of item.parts) {
    const text = typeof part?.text === "string" ? part.text.trim() : "";
    if (!PARTS.includes(part?.kind) || parts.has(part.kind) || !/^我/u.test(text) || text.length > MAX_PART_CHARACTERS
      || containsSecret(text) || text.includes("\0") || !Array.isArray(part.evidence) || !part.evidence.length || part.evidence.length > 3) return null;
    const evidence = [];
    for (const ref of part.evidence) {
      const quote = ref?.quote;
      if (typeof quote !== "string" || !quote.trim() || quote.length > 1000 || quote.includes("\0") || containsSecret(quote)) return null;
      const source = materials.find(source => source.id === ref.id && source.chatId === scope.chatId && source.version
        && (human(source) || delivered(source)) && source.content.includes(quote));
      if (!source) return null;
      evidence.push(source);
      const stored = { chatId: source.chatId, id: source.id, version: source.version, quote };
      refs.set(JSON.stringify(stored), stored);
      observedAt = Math.max(observedAt, Number(source.createdAt) || 0);
    }
    if (part.kind === "heard" && !evidence.every(human) || part.kind === "did" && !evidence.some(delivered)
      || part.kind === "learned" && !evidence.some(human)) return null;
    parts.set(part.kind, text);
  }
  const content = PARTS.map(kind => parts.get(kind)).filter(Boolean).join("\n"), sources = [...refs.values()];
  const policy = item.retention.basis === BASIS ? { status: "active", tier: "working",
    attributes: { retention: { version: VERSION, basis: BASIS, reason, protected: false, observedAt } } }
    : requestedPolicy({ content, retention: item.retention, evidence: sources }, materials, scope);
  return policy && { kind: "experience", content, sources, ...policy };
}

module.exports = { BASIS, MAX_RECORDS, PROMPT, record, requestedPolicy };
