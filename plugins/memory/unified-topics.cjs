"use strict";
const { get, put } = require("./unified-state.cjs");
const key = scope => "plus:topics:" + scope.chatId;
const topicName = value => String(value || "").normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

function merge(storage, scope, topics, operations, receipts) {
  if (!topics.length) return;
  const known = new Map(get(storage, key(scope), []).map(topic => [topicName(topic.title), topic]));
  for (const topic of topics) {
    const name = topicName(topic.title), previous = known.get(name);
    const related = receipts.flatMap((receipt, index) => {
      const record = operations[index]?.record || operations[index]?.patch;
      return receipt?.id && receipt.ok !== false && record?.sources?.some(ref => topic.sourceIds.includes(ref.id)) ? [{ id: receipt.id, revision: receipt.revision }] : [];
    });
    const sources = [...new Map([...(previous?.sources || []), ...(topic.sources || [])].map(ref => [ref.id, ref])).values()].slice(-8);
    const notes = [...new Map([...(previous?.notes || []), ...related].map(note => [note.id, note])).values()].slice(-12);
    known.set(name, { ...topic, keywords: [...new Set([...(previous?.keywords || []), ...topic.keywords])].slice(-8),
      sourceIds: [...new Set([...(previous?.sourceIds || []), ...topic.sourceIds])].slice(-8), sources, notes,
      from: previous ? Math.min(previous.from || topic.from, topic.from) : topic.from, to: Math.max(previous?.to || 0, topic.to || 0) });
  }
  put(storage, key(scope), [...known.values()].sort((a, b) => b.to - a.to).slice(0, 32));
}

async function read(ctx, storage, scope, input) {
  const query = topicName(input.query).slice(0, 200), limit = Math.max(1, Math.min(5, Number(input.limit) || 4));
  const matches = get(storage, key(scope), []).filter(topic => !query || topicName([topic.title, ...topic.keywords].join(" ")).includes(query)).slice(0, limit);
  const topics = [];
  for (const topic of matches) {
    const sources = [];
    for (const ref of (topic.sources || []).slice(-4)) {
      ctx.signal.throwIfAborted();
      const { item } = await ctx.api.sources({ action: "read", chatId: scope.chatId, ...ref, limit: 1 });
      if (item && item.version === ref.version && !item.deleted && !item.routeBlocked && !item.memoryExcluded) sources.push(ref);
    }
    if (!sources.length) continue;
    const notes = [];
    for (const ref of (topic.notes || []).slice(-5)) {
      ctx.signal.throwIfAborted();
      try {
        const { item } = await ctx.api.memory({ action: "read", chatId: scope.chatId, id: ref.id, limit: 240 });
        if (item?.currentAvailable && item.sources?.some(source => sources.some(current => current.id === source.id && current.version === source.version)))
          notes.push({ id: item.id, revision: item.revision, preview: item.content });
      } catch (error) { if (!["MEMORY_SOURCE", "MEMORY_NOT_FOUND", "MEMORY_FORGOTTEN_SOURCE"].includes(error.code)) throw error; }
    }
    topics.push({ title: topic.title, status: topic.status, notes, sources });
  }
  return { searchIn: "topics", topics };
}

module.exports = { merge, read };
