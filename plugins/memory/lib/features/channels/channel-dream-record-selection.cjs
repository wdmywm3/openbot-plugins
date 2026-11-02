"use strict";

const { isPrivateDreamScope } = require("./channel-dream-settings.cjs");
const { searchTokens } = require("./channel-memory-policy.cjs");
const MAX_RECORDS = 40;
const compareIds = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const terminal = new Set(["completed", "closed", "canceled"]);
const unfinished = entry => ["goal", "question", "followup"].includes(entry.kind)
  && ["active", "waiting"].includes(entry.status) && !entry.closedByUser && !entry.canceledByTaskControl;

function modelRecord(entry) {
  return { id: entry.id, revision: entry.revision, kind: entry.kind, title: String(entry.title || "").slice(0, 160),
    content: String(entry.content || "").slice(0, 800), status: entry.status,
    sourceIds: (entry.sourceIds || []).slice(0, 12), relatedIds: (entry.relatedIds || []).slice(0, 12),
    nextReviewAt: Number(entry.nextReviewAt) || 0, occurredAt: Number(entry.occurredAt) || 0,
    referenceOnly: terminal.has(entry.status) || !!entry.closedByUser || !!entry.canceledByTaskControl };
}

function queryTokens(query) {
  const text = String(query || "");
  // Sample every part of a long tool page instead of letting its opening boilerplate
  // consume the whole query vocabulary before the useful tail has been considered.
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += 2000) chunks.push(searchTokens(text.slice(offset, offset + 2000)));
  const tokens = new Set();
  for (let index = 0; tokens.size < 160 && chunks.some(chunk => index < chunk.length); index++) {
    for (const chunk of chunks) if (chunk[index] && tokens.size < 160) tokens.add(chunk[index]);
  }
  return [...tokens];
}

function createDreamRecordSelector({ repository, containsSecret = () => false, allowSource = () => true }) {
  function readable(scope, entry, job, sourceCache = new Map()) {
    if (!entry?.id || !entry.content || entry.invalidatedAt || entry.sourceRevoked || entry.status === "invalidated"
      || entry.documentUnavailable || entry.documentPending || containsSecret(`${entry.title}\n${entry.content}`)
      || !isPrivateDreamScope(scope) && entry.kind !== "episode") return false;
    // A record is context, not a new source. Every linked source still has to
    // exist in the frozen job and pass the same current forgetting/scope policy.
    if (!Array.isArray(entry.sourceIds) || !entry.sourceIds.length) return false;
    return entry.sourceIds.every(id => {
      if (!sourceCache.has(id)) {
        const source = repository.source(scope, id, job.upper, job.cutoff);
        sourceCache.set(id, !!source && !source.deleted && !!source.content && source.createdAt <= job.cutoff
          && !containsSecret(source.content) && allowSource(scope, source, job.cutoff));
      }
      return sourceCache.get(id);
    });
  }
  function select(scope, job, { query = "", cursor = "", limit = MAX_RECORDS, relateToSelected = false, semantic = [] } = {}) {
    limit = Math.max(1, Math.min(MAX_RECORDS, Math.floor(Number(limit)) || MAX_RECORDS));
    const entries = [], sourceCache = new Map();
    let after = "";
    do {
      const page = repository.recordPage(scope, { after, limit: 200 });
      for (const entry of page.records) if (readable(scope, entry, job, sourceCache)) entries.push(entry);
      after = page.nextCursor;
    } while (after);
    const selected = [], selectedIds = new Set();
    const add = (candidates, count) => {
      let added = 0;
      for (const entry of candidates) {
        if (selected.length >= limit || added >= count) break;
        if (selectedIds.has(entry.id)) continue;
        selected.push(entry); selectedIds.add(entry.id); added++;
      }
    };
    const current = isPrivateDreamScope(scope) ? entries.filter(unfinished).sort(compareIds) : [];
    const due = current.filter(entry => entry.kind === "followup" && entry.nextReviewAt > 0 && entry.nextReviewAt <= job.cutoff)
      .sort((a, b) => a.nextReviewAt - b.nextReviewAt || compareIds(a, b));
    // Urgent dates lead, but never consume the whole context. The independent
    // ID rotation guarantees progress even when the same overdue items remain.
    add(due, Math.min(8, Math.max(1, Math.floor(limit / 5))));
    const ordered = [...current.filter(entry => entry.id > cursor), ...current.filter(entry => entry.id <= cursor)];
    const rotation = ordered.filter(entry => !selectedIds.has(entry.id)).slice(0, Math.min(limit - selected.length, Math.max(1, Math.floor(limit / 2))));
    add(rotation, rotation.length);
    const nextCursor = rotation.at(-1)?.id || (current.length ? cursor : "");

    const relatedQuery = relateToSelected ? selected.filter(unfinished).map(entry => `${entry.title}\n${String(entry.content).slice(0, 400)}`).join("\n") : "";
    const semanticIds = new Set(semantic.map(entry => entry.id));
    add(entries.filter(entry => semanticIds.has(entry.id)).sort((a, b) => semantic.findIndex(entry => entry.id === a.id) - semantic.findIndex(entry => entry.id === b.id)), Math.max(1, Math.floor(limit / 5)));
    const tokens = queryTokens(`${query}\n${relatedQuery}`);
    const texts = entries.map(entry => ({ entry, title: String(entry.title || "").normalize("NFKC").toLowerCase(),
      body: String(entry.content || "").normalize("NFKC").toLowerCase() }));
    const weights = new Map(tokens.map(token => [token, Math.log(1 + entries.length / (1 + texts.filter(text => text.title.includes(token) || text.body.includes(token)).length))]));
    const ranked = texts.map(({ entry, title, body }) => {
      const matched = tokens.filter(token => title.includes(token) || body.includes(token));
      return { entry, score: matched.reduce((sum, token) => sum + weights.get(token) * (title.includes(token) ? 3 : 1), 0) };
    }).filter(row => row.score > 0).sort((a, b) => b.score - a.score
      || Number(b.entry.updatedAt || 0) - Number(a.entry.updatedAt || 0) || compareIds(a.entry, b.entry)).map(row => row.entry);
    add(ranked, Math.min(Math.max(0, limit - selected.length - 4), Math.max(1, Math.floor(limit / 5))));
    // Include explicit relationships before unrelated recent history. A closed
    // parent is useful context for an old followup, but stays reference-only.
    const related = new Set(selected.flatMap(entry => entry.relatedIds || []));
    add(entries.filter(entry => related.has(entry.id)).sort(compareIds), 4);
    const recent = entries.slice().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0) || compareIds(a, b));
    add(ordered, Math.max(0, limit - selected.length - 4));
    add(ranked, limit);
    add(recent, limit);
    return { records: selected.map(modelRecord), nextCursor };
  }
  function current(scope, records, job) {
    const sourceCache = new Map();
    return records.filter(entry => {
      const live = repository.getRecord(scope, entry.id);
      return live?.revision === entry.revision && readable(scope, live, job, sourceCache);
    });
  }
  return { select, current, readable };
}

module.exports = { createDreamRecordSelector, modelRecord, MAX_RECORDS };
