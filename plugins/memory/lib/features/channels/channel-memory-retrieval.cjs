"use strict";

const { memoryRecallScore, searchTokens } = require("./channel-memory-policy.cjs");
const { activeFact } = require("./channel-memory-write.cjs");
const { conditionKey, lowInformation } = require("./channel-recall-input.cjs");

function memoryApplicability(entry, options = {}) {
  const fact = activeFact(entry);
  const subject = String(fact?.subjectId || entry.subjectId || "");
  const subjects = Array.isArray(options.subjectIds) ? options.subjectIds.filter(value => typeof value === "string" && value).slice(0, 12) : [];
  if (subject && subjects.length && !subjects.includes(subject)) return { allowed: false };
  const known = new Set((Array.isArray(options.conditions) ? options.conditions : []).map(conditionKey).filter(Boolean));
  const excluded = new Set((Array.isArray(options.excludedConditions) ? options.excludedConditions : []).map(conditionKey).filter(Boolean));
  const conditions = (fact?.conditions || []).map(conditionKey).filter(Boolean);
  // Unknown conditions stay eligible. Only an explicitly contradictory condition
  // removes a candidate; absence of a condition in the query is not its negation.
  if (conditions.some(value => excluded.has(value)
    || /^(?:不|没有|非)/u.test(value) && known.has(value.replace(/^(?:不|没有|非)/u, "")))) return { allowed: false };
  const range = options.timeRange;
  if (range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.to >= range.from) {
    if (Number(entry.validFrom) > 0 && Number(entry.validFrom) > range.to
      || Number(entry.validTo) > 0 && Number(entry.validTo) <= range.from) return { allowed: false };
  }
  return { allowed: true, weight: 1 + (subjects.includes(subject) ? 0.35 : 0) + (conditions.some(value => known.has(value)) ? 0.2 : 0) };
}

// Bounded overlapping passages keep later facts searchable without fragmenting
// each sentence into the former short-encoder input size.
function memoryChunks(text) {
  const chars = [...String(text || "")];
  const chunks = [];
  for (let offset = 0; offset < chars.length; offset += 640) chunks.push(chars.slice(offset, offset + 768).join(""));
  return chunks.length ? chunks : [""];
}

function lexicalRanks(query, entries, now) {
  const tokens = searchTokens(query);
  const docs = entries.map(entry => ({
    entry,
    text: `${entry.content}\n${entry.createdByUserName}\n${entry.createdByUserId}\n${entry.subjectId}`.normalize("NFKC").toLowerCase(),
  }));
  const idf = new Map(tokens.map(token => [token, Math.log(1 + entries.length / (1 + docs.filter(doc => doc.text.includes(token)).length))]));
  return docs.map(({ entry, text }) => {
    const matched = tokens.filter(token => text.includes(token));
    const lexicalScore = matched.reduce((score, token) => score + idf.get(token), 0)
      + (text.includes(String(query).normalize("NFKC").toLowerCase()) ? 3 : 0);
    return { entry, lexicalScore, matchedTerms: matched, recallScore: memoryRecallScore(entry) };
  }).sort((a, b) => b.lexicalScore - a.lexicalScore || b.entry.createdAt - a.entry.createdAt || a.entry.id.localeCompare(b.entry.id));
}

function createMemoryRetrieval({ index }) { return { rank: (scope, query, entries, limit = 8, options = {}) => index.rankEntries(scope, query, entries, limit, options) }; }
module.exports = { createMemoryRetrieval, memoryChunks, lexicalRanks, memoryApplicability };
