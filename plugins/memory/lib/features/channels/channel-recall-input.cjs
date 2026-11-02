"use strict";
const { messagesAfterLastCompactBoundary } = require("../../llm/compact-boundary.cjs");
const { parseSystemReminders } = require("../../llm/system-reminder.cjs");
const { searchTokens } = require("./channel-memory-policy.cjs");

const plain = value => String(value || "").normalize("NFKC").trim();
const compact = value => plain(value).toLowerCase().replace(/[\s\p{P}]/gu, "");
const lowInformation = value => !/[\p{L}\p{N}]/u.test(plain(value))
  || /^(?:嗯+|哦+|噢+|啊+|好(?:的|吧|嘞)?|行|收到|知道了|明白了|谢谢(?:你)?|哈哈+|嘿嘿+|ok|okay|thanks|thankyou)$/iu.test(compact(value));
const topicChanged = value => /(?:换(?:一?个)?话题|不说这个|不聊这个|说点别的|另一个问题|另外问|顺便问|new topic|unrelated|change (?:the )?topic)/iu.test(value);
const shortFollowup = value => [...plain(value)].length <= 40
  && /^(?:那|这(?:个|件事)|它|他|她|后来|然后|之后|接着|还有呢|进展|怎么样了|还记得|继续|what about|and then|what happened|how about)/iu.test(plain(value));
const conditionKey = value => compact(value).replace(/(?:的时候|情况下|的话|期间|时)$/u, "");

function explicitRecallConstraints(query, identity = {}, now = Date.now()) {
  const subjectIds = [];
  if (/(?:^|[\s，。？！,?!])我(?:的|现在|之前|以前|当时|呢|还|会|要|想|喜欢|不)|我的/u.test(query) && identity.senderId) subjectIds.push(String(identity.senderId));
  const names = new Map();
  for (const member of identity.members || []) for (const name of [member.id, ...(member.names || [])].filter(value => String(value || "").length > 1)) {
    if (!names.has(name)) names.set(name, new Set());
    if (member.id) names.get(name).add(String(member.id));
  }
  for (const [name, ids] of names) if (ids.size === 1 && query.includes(name)) subjectIds.push(...ids);
  const conditions = [], excludedConditions = [];
  for (const match of query.matchAll(/(?:如果|假如|条件[：:]|在)([^，。！？,!?\n]{1,32}?)(?:的时候|情况下|的话|时|[，,])/gu)) {
    const value = conditionKey(match[1]);
    if (!value) continue;
    conditions.push(value);
    if (/^(?:不|没有|非)/u.test(value)) excludedConditions.push(value.replace(/^(?:不|没有|非)/u, ""));
  }
  if (/周末/u.test(query) && !/工作日/u.test(query)) { conditions.push("周末"); excludedConditions.push("工作日"); }
  if (/工作日/u.test(query) && !/周末/u.test(query)) { conditions.push("工作日"); excludedConditions.push("周末"); }
  let timeRange;
  const dates = [...query.matchAll(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/gu), ...query.matchAll(/(20\d{2})年(\d{1,2})月(\d{1,2})日/gu)];
  const days = [];
  for (const date of dates) {
    const candidate = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    if (candidate.getFullYear() === Number(date[1]) && candidate.getMonth() === Number(date[2]) - 1 && candidate.getDate() === Number(date[3])) days.push(candidate);
  }
  for (const [word, offset] of [["今天", 0], ["昨天", -1], ["明天", 1]]) if (query.includes(word)) {
    const day = new Date(now); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() + offset); days.push(day);
  }
  if (days.length) {
    const until = new Date(Math.max(...days.map(day => day.getTime()))); until.setDate(until.getDate() + 1);
    timeRange = { from: Math.min(...days.map(day => day.getTime())), to: until.getTime() - 1 };
  }
  return { ...(subjectIds.length ? { subjectIds: [...new Set(subjectIds)] } : {}),
    ...(conditions.length ? { conditions: [...new Set(conditions)] } : {}),
    ...(excludedConditions.length ? { excludedConditions: [...new Set(excludedConditions)] } : {}), ...(timeRange ? { timeRange } : {}) };
}

// Read only visible dialogue, not memories, tool results, host instructions or
// summarized-away transcripts. These snippets guide retrieval, never authority.
function visibleRecallDialogue(history) {
  const rows = [];
  const visit = records => {
    for (const record of messagesAfterLastCompactBoundary(records || [])) {
      if (record.includeInContext === false || record.active === false) continue;
      if (record.source === "conversation_compaction") { visit(record.compactedMessages); continue; }
      if (record.source === "channel_reply_delivery_receipt") {
        for (const reminder of parseSystemReminders(record.content)) if (reminder.source === "channel_reply_delivery"
          && ["sent", "partial"].includes(reminder.payload?.status) && reminder.payload.publicContent) rows.push({ role: "assistant", content: reminder.payload.publicContent });
        continue;
      }
      if (record.role === "assistant" && record.toolCallsJson) {
        try { for (const call of JSON.parse(record.toolCallsJson)) visit(call.userContextMessages); } catch { /* unreadable trace is not dialogue */ }
        continue;
      }
      if (!["user", "assistant"].includes(record.role) || record.source && !["channel", "channel_inbound", "channel_input", "conversation_input"].includes(record.source)) continue;
      const text = Array.isArray(record.content) ? record.content.filter(part => part.type === "text").map(part => part.text || "").join("\n") : String(record.content || "");
      let hasDelta = false;
      for (const delta of text.matchAll(/<(?:qq|channel)_conversation_delta\b[^>]*>([\s\S]*?)<\/(?:qq|channel)_conversation_delta>/g)) {
        hasDelta = true;
        for (const line of delta[1].split("\n")) {
          try {
            const row = JSON.parse(line);
            if (row.id && row.content && !row.interaction && !row.replyBlocked) rows.push({ id: row.id, senderId: row.senderId,
              role: row.role === "bot" ? "assistant" : "user", content: row.content, createdAt: row.createdAt,
              names: [row.senderName, row.senderPreferredAddress, ...(row.senderAliases || [])].filter(Boolean) });
          } catch { /* wrappers and omission notices are not query text */ }
        }
      }
      if (!hasDelta && text && !/^\s*(?:<system-reminder|\[DONE\])/u.test(text)) rows.push({ role: record.role, content: text,
        senderId: record.senderId, createdAt: record.createdAt, id: record.id });
    }
  };
  visit(history);
  return rows.slice(-12);
}

function relatedRecallTopics(rows, topics = []) {
  const sourceIds = new Set(rows.map(row => row.id).filter(Boolean));
  const text = rows.map(row => row.content).join("\n");
  const tokens = new Set(searchTokens(text).filter(token => token.length > 1));
  return topics.filter(topic => !["closed", "completed", "canceled", "invalidated"].includes(topic.status)
    && !topic.documentUnavailable && !topic.documentPending)
    .filter(topic => (topic.sourceIds || []).some(id => sourceIds.has(id))
      || searchTokens([topic.title, ...(topic.keywords || [])].filter(Boolean).join(" ")).filter(token => tokens.has(token)).length >= 2)
    .slice(0, 2).map(topic => [topic.title, ...(topic.keywords || [])].filter(Boolean).join(" ").slice(0, 160));
}

function contextualRecallInput(query, history, context = {}, topics = []) {
  query = plain(query);
  if (lowInformation(query)) return { query, skipAutomaticRecall: true, mode: "low_information", retrievalContext: {} };
  const changed = topicChanged(query), followup = !changed && shortFollowup(query);
  const dialogue = visibleRecallDialogue(history);
  const identity = { ...context.recallContext, senderId: context.recallContext?.senderId || context.channelPrincipal?.senderId };
  const own = dialogue.filter(row => row.role === "user" && (!identity.senderId || !row.senderId || String(row.senderId) === String(identity.senderId)));
  const quoted = identity.replyToMessageId && dialogue.findLast(row => row.id === identity.replyToMessageId);
  const anchor = quoted || own.findLast(row => !lowInformation(row.content) && !shortFollowup(row.content));
  const neighbours = anchor ? [anchor] : [];
  if (anchor) {
    const index = dialogue.indexOf(anchor);
    if (dialogue[index + 1]?.role === "assistant") neighbours.push(dialogue[index + 1]);
  }
  const related = followup && neighbours.length ? relatedRecallTopics(neighbours, topics) : [];
  const contextualQuery = followup && neighbours.length
    ? [query, ...neighbours.map(row => plain(row.content).slice(0, 240)), ...related].join("\n").slice(0, 800) : query;
  const members = [...(identity.members || []), ...dialogue.filter(row => row.senderId).map(row => ({ id: row.senderId, names: row.names || [] }))];
  return { query, mode: changed ? "topic_change" : followup ? "followup" : "direct",
    skipAutomaticRecall: followup && !neighbours.length,
    retrievalContext: { ...(contextualQuery !== query ? { contextualQuery } : {}),
      ...explicitRecallConstraints(query, { ...identity, members }, identity.at || Date.now()) } };
}

// Callers supply events read from the bound chat repository, never parsed chat
// wording or a model-supplied trigger. Unknown source records keep normal recall.
function channelRecallInput(events, fallback = "") {
  const poke = event => (String(event?.event?.kind || event?.oneBotEvent?.noticeType || "").toLowerCase() === "notify"
    && String(event?.event?.subtype || event?.oneBotEvent?.subType || "").toLowerCase() === "poke");
  const known = Array.isArray(events) && events.length > 0 && events.every(Boolean);
  const ordinary = (events || []).filter(event => event && !poke(event));
  return {
    skipAutomaticRecall: known && ordinary.length === 0,
    query: ordinary.map(event => String(event.agentContent ?? event.content ?? "")).filter(Boolean).join("\n") || String(fallback || ""),
    recallContext: { senderId: ordinary.at(-1)?.sender?.id || "", at: ordinary.at(-1)?.createdAt,
      replyToMessageId: ordinary.at(-1)?.replyToMessageId || ordinary.at(-1)?.reply?.messageId || "",
      members: ordinary.map(event => ({ id: event.sender?.id || "", names: [event.sender?.name].filter(Boolean) })) },
  };
}

module.exports = { channelRecallInput, contextualRecallInput, visibleRecallDialogue, relatedRecallTopics, explicitRecallConstraints, conditionKey, lowInformation };
