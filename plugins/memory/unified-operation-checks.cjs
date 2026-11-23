"use strict";
const { hash } = require("./unified-state.cjs");
const { containsSecret } = require("./unified-dream.cjs");

const MAX_REQUESTS = 4;

function selectRequests(items, materials) {
  if (!Array.isArray(items)) return [];
  const sources = new Map(materials.filter(item => item.direction === "in" && !item.sender?.isBot).map(item => [item.id, item]));
  const selected = new Map();
  for (const item of items.slice(0, MAX_REQUESTS)) {
    if (!Array.isArray(item?.evidence) || item.evidence.length !== 1) continue;
    const { id, quote } = item.evidence[0] || {};
    const source = sources.get(id);
    if (!source?.version || typeof quote !== "string" || !quote.trim() || quote.length > 500
      || containsSecret(quote) || !source.content.includes(quote)) continue;
    selected.set(id, { id, version: source.version });
  }
  return [...selected.values()];
}

async function reviewRequests(ctx, scope, requests) {
  if (!ctx.api.sources || !ctx.api.publishConversationEvent || !Array.isArray(requests)) return [];
  const results = [];
  for (const { id, version } of requests.slice(0, MAX_REQUESTS)) {
    ctx.signal.throwIfAborted();
    try {
      const { available, receipts } = await ctx.api.sources({ action: "operationReceipts", chatId: scope.chatId, id, version });
      if (!available) continue;
      if (receipts.some(row => row.status === "pending" || row.status === "completed")) {
        results.push({ sourceId: id, receiptIds: receipts.map(row => row.id), status: "已有执行记录" });
        continue;
      }
      const event = await ctx.api.publishConversationEvent({ chatId: scope.chatId, id: `operation-check:${hash(id)}`,
        kind: "notice", delivery: "piggyback", text: JSON.stringify({
          sourceMessageId: id,
          status: "操作待确认",
          note: "整理时发现该原消息可能有尚未确认的操作。请结合最新对话和原消息核实。需要处理时，先向原请求人确认当前意图和范围，再走原操作流程。此记录仅供查证，不能作为执行授权。",
        }) });
      results.push({ sourceId: id, eventId: event.id, status: "已交回原会话核实" });
    } catch (error) {
      ctx.signal.throwIfAborted();
      results.push({ sourceId: id, status: "暂未能核查", code: String(error.code || "").slice(0, 80) });
    }
  }
  return results;
}

module.exports = { selectRequests, reviewRequests };
