"use strict";

const { isPrivateDreamScope } = require("./channel-dream-settings.cjs");
const { digest, sourceMetadata } = require("./channel-memory-write.cjs");

function preferredAddress(scope, event) {
  if (!isPrivateDreamScope(scope) || !event?.id || !event.sender?.id || event.sender.isBot
    || !["in", "inbound"].includes(event.direction) || event.deleted || event.routeBlocked
    || event.source && !["chat", "qq", "onebot", "qqbot"].includes(event.source)) return null;
  const text = String(event.content || "").trim();
  // One entire explicit statement only. Questions, quotes, reported speech,
  // temporary conditions and compound statements are left for the model.
  const match = /^(?:请记住[，,：:]?\s*)?(?:以后(?:请)?叫我|以后(?:请)?称呼我为|请叫我)([\p{Script=Han}A-Za-z0-9_·]{1,16})(?:[，,]\s*(?:记住(?:了)?|请记住))?[。！!]?$/u.exec(text);
  if (!match || /[吗呢吧]$|(?:可能|也许|暂时|今天|明天|如果|不要|别叫|不叫|而是|先叫|可以|但是|或者|然后|的话)/.test(match[1])) return null;
  const subjectId = String(event.sender.id), value = match[1];
  return { id: `rule-${digest(JSON.stringify([event.id, subjectId, "preferred_address", value])).slice(0, 32)}`,
    content: `用户（${subjectId}）希望被称呼为“${value}”。`, kind: "preference", subjectId,
    fact: { subjectId, facet: "preferred_address", value, conditions: [], assertion: "self" },
    sourceMessageId: event.id, sourceIds: [event.id], evidence: [{ id: event.id, quote: text, offset: event.content.indexOf(text) }],
    sources: [sourceMetadata(event)], createdByUserId: subjectId, createdByUserName: event.sender.name || "",
    origin: "rule", createdAt: event.createdAt, retention: "short_term", expiresAt: 0 };
}

module.exports = { preferredAddress };
