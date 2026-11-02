"use strict";
const { memoryAutoRecall } = require("./lib/features/channels/channel-memory-policy.cjs");
const { memoryApplicability } = require("./lib/features/channels/channel-memory-retrieval.cjs");
const terminal = new Set(["completed", "closed", "canceled"]);
const readable = entry => entry && !entry.invalidatedAt && !entry.sourceRevoked && entry.status !== "invalidated"
  && !entry.documentUnavailable && !entry.documentPending;
function automaticNotes(storage, scope, notes, options) {
  return notes.filter(note => {
    const { derivedType, derivedId } = note.metadata || {};
    if (derivedType === "memory") {
      const entry = storage.memoryRepository.get(scope, derivedId);
      return !!entry && memoryAutoRecall(entry) && memoryApplicability(entry, options).allowed;
    }
    if (derivedType === "record") return readable(storage.dreamRepository.getRecord(scope, derivedId));
    return !derivedType;
  });
}
// Follow both directions: newer progress often points to an older event without
// rewriting it. A visited set bounds cycles; invalid records cannot bridge them.
function expandRecords(seeds, records, limit = 8) {
  const available = new Map(records.filter(readable).map(entry => [entry.id, entry]));
  const edges = new Map([...available.keys()].map(id => [id, new Set()]));
  for (const entry of available.values()) for (const id of entry.relatedIds || []) if (available.has(id)) {
    edges.get(entry.id).add(id); edges.get(id).add(entry.id);
  }
  const selected = new Map();
  for (const seed of seeds) {
    const queue = [seed.id];
    for (let i = 0; i < queue.length && selected.size < limit; i++) {
      const id = queue[i]; if (selected.has(id) || !available.has(id)) continue;
      selected.set(id, available.get(id));
      queue.push(...[...edges.get(id)].sort((a, b) => Number(available.get(b).updatedAt || 0) - Number(available.get(a).updatedAt || 0)));
    }
  }
  return [...selected.values()];
}
function recordContext(entry) {
  return { id: entry.id, revision: entry.revision, kind: entry.kind, content: entry.content.slice(0, 500), status: entry.status,
    relatedIds: entry.relatedIds || [], referenceOnly: terminal.has(entry.status) || !!entry.closedByUser || !!entry.canceledByTaskControl };
}
function trimContext(payload) {
  for (const key of ["notes", "topics", "continuity", "memories"]) while (JSON.stringify(payload).length > 3900 && payload[key].length) {
    const removed = payload[key].pop();
    if (key !== "continuity") continue;
    // Never trim just a resolution and leave its linked earlier state behind.
    const ids = new Set([removed.id]), links = [...payload.continuity, removed];
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of links) for (const id of entry.relatedIds || []) if (ids.has(entry.id) || ids.has(id)) {
        if (!ids.has(entry.id) || !ids.has(id)) { ids.add(entry.id); ids.add(id); changed = true; }
      }
    }
    payload.continuity = payload.continuity.filter(entry => !ids.has(entry.id));
  }
  return payload;
}
module.exports = { automaticNotes, expandRecords, recordContext, trimContext };
