"use strict";
const retrieval = require("./unified-retrieval.cjs"), sources = require("./source-retrieval.cjs");
const { channelRecallInput, contextualRecallInput } = require("./lib/features/channels/channel-recall-input.cjs");
function anchorIds(ctx) {
  const message = (ctx.hook.messages || []).find(item => item.contextRecordId === ctx.hook.requestId);
  const text = Array.isArray(message?.content) ? message.content.filter(part => part.type === "text").map(part => part.text).join("\n") : message?.content || "";
  const ids = new Set(); let inside = false;
  for (const line of text.split("\n")) {
    if (/^<(?:qq|channel)_conversation_delta\b[^>]*>$/.test(line)) { inside = true; continue; }
    if (/^<\/(?:qq|channel)_conversation_delta>$/.test(line)) { inside = false; continue; }
    if (inside) try { const row = JSON.parse(line); if (row.role === "user" && row.id) ids.add(row.id); } catch { /* Not a source row. */ }
  }
  return ids;
}
async function recall(ctx, storage, scope, topics) {
  const inputs = ctx.hook.inputMessages?.length ? ctx.hook.inputMessages : [ctx.message];
  const anchors = anchorIds(ctx), selected = new Map(), priorities = [];
  const currentIndex = (ctx.hook.messages || []).findIndex(item => item.contextRecordId === ctx.hook.requestId);
  const earlier = currentIndex >= 0 ? ctx.hook.messages.slice(0, currentIndex) : ctx.hook.messages || [];
  const preceding = [], batches = [];
  // Use the same per-utterance path for text, image-only and mixed messages.
  for (const message of inputs) {
    const priority = []; priorities.push(priority);
    ctx.signal.throwIfAborted();
    const input = channelRecallInput([message], message?.content || "");
    const images = (message?.media || []).filter(item => ["image", "mface"].includes(item.type));
    const plain = String(input.query || "").replace(/\[(?:图片|表情|image)\]/giu, "").trim();
    const history = [...earlier, ...(preceding.length ? [{ role: "user", content:
      `<qq_conversation_delta trust="untrusted">\n${preceding.map(item => JSON.stringify({ id: item.id, role: "user", content: item.content, senderId: item.sender?.id, createdAt: item.createdAt })).join("\n")}\n</qq_conversation_delta>` }] : [])];
    const context = contextualRecallInput(plain, history, { recallContext: { ...input.recallContext, senderId: message?.sender?.id || ctx.principal.senderId } }, topics);
    const query = context.retrievalContext.contextualQuery || plain;
    const queries = [...(!input.skipAutomaticRecall && !context.skipAutomaticRecall && query ? [{ query, options: context.retrievalContext }] : []),
      ...images.map((_, index) => ({ query: "相关图片", index, options: { ...context.retrievalContext, queryImage: { messageId: message.id, index }, imageOnly: true } }))];
    batches.push(queries.map(task => ({ ...task, message, priority })));
    preceding.push(message);
  }
  // Leave time for source revalidation and returning the bounded result. Slow
  // embeddings must not turn an optional recall into a failed chat request.
  const deadline = Math.min(ctx.deadlineAt || Infinity, Date.now() + 60000) - 2000;
  if (Date.now() >= deadline || !batches.some(batch => batch.length)) return { contextItems: [], memories: [] };
  const catalog = await require("./unified-state.cjs").catalog(ctx, scope);
  const tasks = [];
  for (let at = 0; at < Math.max(0, ...batches.map(batch => batch.length)); at++) for (const batch of batches) if (batch[at]) tasks.push(batch[at]);
  let next = 0;
  await Promise.all([0, 1].map(async () => {
    for (;;) {
      const task = tasks[next++], timeoutMs = Math.floor(deadline - Date.now());
      if (!task || timeoutMs < 50) return;
      ctx.signal.throwIfAborted();
      const [result, raw] = await Promise.all([
        retrieval.search(ctx, storage, scope, task.query, 6, { ...task.options, catalog, timeoutMs }),
        sources.search(ctx, scope, task.query, { ...task.options, timeoutMs, before: task.message.createdAt, excludeIds: inputs.map(item => item.id) }),
      ]);
      task.entries = [...result.records.map(item => ({ key: `memory:${item.id}:${item.read.offset || 0}`, memory: { id: item.id, revision: item.revision,
        offset: item.read.offset || 0, limit: item.read.limit || 768 } })), ...raw.records];
    }
  }));
  // Fold results in source order, independent of query completion order.
  for (const batch of batches) for (const task of batch) {
      const { message, priority } = task;
      for (const entry of task.entries || []) {
        if (!selected.has(entry.key)) selected.set(entry.key, { ...entry, related: new Map(), afterMessageId: message.id });
        if (!priority.includes(entry.key)) priority.push(entry.key);
        const saved = selected.get(entry.key);
        if (!saved.related.has(message.id)) saved.related.set(message.id, new Set());
        if (task.index !== undefined) saved.related.get(message.id).add(task.index);
      }
  }
  // Allocate the shared budget across utterances, rather than letting the first
  // speaker's matches consume it. Every query still contributes associations.
  const keep = new Set();
  for (let rank = 0; rank < Math.max(0, ...priorities.map(items => items.length)) && keep.size < 8; rank++) {
    for (const items of priorities) { if (items[rank]) keep.add(items[rank]); if (keep.size >= 8) break; }
  }
  let budget = 10000;
  const contextItems = [...keep].map(key => selected.get(key)).map(({ related, afterMessageId, sourceImageIndex, ...item }) => ({ ...item,
    ...(anchors.has(afterMessageId) ? { placement: { afterMessageId, related: [...related].filter(([id]) => anchors.has(id))
      .map(([messageId, indexes]) => ({ messageId, ...(indexes.size ? { imageIndexes: [...indexes].sort((a, b) => a - b) } : {}) })) } } : {}) }))
  .filter(item => {
    const cost = JSON.stringify(item).length * 2 + (item.memory?.limit || item.source?.limit || 0) + 800;
    if (budget < cost) return false; budget -= cost; return true;
  });
  return { contextItems, memories: [...new Map(contextItems.filter(item => item.memory).map(item =>
    [`${item.memory.id}:${item.memory.revision}`, { id: item.memory.id, revision: item.memory.revision }])).values()] };
}
module.exports = { recall };
