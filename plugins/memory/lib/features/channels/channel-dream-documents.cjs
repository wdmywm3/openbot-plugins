"use strict";

const path = require("node:path");
const { createHash } = require("node:crypto");
const { renderDreamDocument, renderDreamDaily, contentFromDreamDocument } = require("./channel-dream-documents-format.cjs");
const { isPrivateDreamScope } = require("./channel-dream-settings.cjs");
const { documentPath } = require("../../context/channel-document-repository.cjs");
const hash = text => createHash("sha256").update(String(text)).digest("hex");
const DAILY_START = "<!-- openbot:dream-index:start -->", DAILY_END = "<!-- openbot:dream-index:end -->";
function managedDaily(previous, rendered) {
  const body = contentFromDreamDocument(rendered);
  let personal = previous ? contentFromDreamDocument(previous) : "";
  const start = personal.indexOf(DAILY_START), end = personal.indexOf(DAILY_END, start);
  if (start >= 0 && end >= start) personal = personal.slice(0, start) + personal.slice(end + DAILY_END.length);
  else if (previous) {
    // Upgrade the earlier generated format. Remove its registered link lines,
    // keeping unrelated paragraphs added by the user.
    const header = previous.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    try {
      const metadata = header && require("js-yaml").load(header[1], { schema: require("js-yaml").JSON_SCHEMA });
      const old = metadata?.kind === "daily" && renderDreamDaily(metadata);
      const generated = new Set(contentFromDreamDocument(old || "").split("\n"));
      personal = personal.split("\n").filter(line => !generated.has(line)).join("\n");
    } catch { /* malformed user metadata is never executed */ }
  }
  const prefix = rendered.slice(0, rendered.length - (body ? `${body}\n`.length : 0)).trimEnd();
  return `${prefix}\n\n${DAILY_START}\n${body}\n${DAILY_END}\n${personal.trim() ? `\n${personal.trim()}\n` : ""}`;
}

// Only the host chooses ownership. Neither model output nor Markdown frontmatter
// can change a document's scope, identity, or a task's operational state.
function createDreamDocuments({ storage, now = Date.now, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }) {
  const catalog = storage.documentRepository, files = storage.documentService;
  const memories = storage.memoryRepository, dream = storage.dreamRepository;
  const scopeOf = (scope, ref) => ({ ...scope, ownerId: ref.ownerId || "host" });
  const owners = scope => catalog.owners(scope);
  function allDocuments(scope, options = {}) {
    const result = [];
    for (const ownerId of owners(scope)) {
      let after = "";
      do {
        const page = catalog.list({ ...scope, ownerId }, { ...options, after, limit: 200 });
        result.push(...page.records); after = page.nextCursor;
      } while (after);
    }
    return result;
  }
  function* records(scope) {
    let after = "";
    do {
      const page = dream.recordPage(scope, { after, limit: 200 });
      yield* page.records; after = page.nextCursor;
    } while (after);
  }
  function allowed(scope, entry, type) {
    return !entry.invalidatedAt && entry.status !== "invalidated" && !entry.sourceRevoked
      && !(entry.sourceIds || []).some(id => memories.excluded(scope, "", [id]))
      && (isPrivateDreamScope(scope) || (type === "memory" ? entry.kind !== "preference" && (entry.origin !== "dream" || entry.kind === "fact") : entry.kind === "episode"));
  }
  function ownerFor(scope, entry, type) {
    if (entry.documentRef) return entry.documentRef.ownerId;
    const synthetic = /^agent:plugin:(.+)$/.exec(scope.chatId);
    if (synthetic) return `plugin:${synthetic[1]}`;
    if (type !== "record" || entry.kind !== "episode" || !entry.sourceIds?.length) return "host";
    const plugins = entry.sourceIds.map(id => dream.source(scope, id, Number.MAX_SAFE_INTEGER)?.provenance?.pluginId);
    return plugins.every(id => id && id === plugins[0]) ? `plugin:${plugins[0]}` : "host";
  }
  function stage(scope, entry, type = "record") {
    if (!allowed(scope, entry, type)) throw new Error("资料来源已撤销或不属于当前可保存范围");
    const previous = type === "memory" ? memories.get(scope, entry.id) : dream.getRecord(scope, entry.id);
    let ref = entry.documentRef || previous?.documentRef;
    if (ref && previous?.content === entry.content && ["title", "sourceIds", "noteRefs", "occurredAt"]
      .every(key => JSON.stringify(previous?.[key]) === JSON.stringify(entry[key]))) return { ...entry, documentRef: ref };
    if (previous?.documentTruncated && ref) throw new Error("笔记包含未完整读取的正文，请先读取全文后合并");
    let artifactId = ref?.artifactId || `dream-${type}-${hash(entry.id).slice(0, 32)}`;
    const ownerId = ref?.ownerId || ownerFor(scope, entry, type) || "host";
    const targetScope = { ...scope, ownerId };
    let existing = catalog.get(targetScope, artifactId);
    if (existing?.revokedAt) {
      if (!(previous?.sourceRevoked || previous?.invalidatedAt || previous?.status === "invalidated")
        || memories.excluded(scope, entry.content, entry.sourceIds || [])) throw new Error("已遗忘的笔记不能重新写入");
      // A revalidated source is a new document generation. The retired file and
      // its tombstone stay retired; an explicit forgetting exclusion still wins.
      artifactId = `dream-${type}-${hash(JSON.stringify([entry.id, artifactId, previous.revision])).slice(0, 32)}`;
      ref = null; existing = catalog.get(targetScope, artifactId);
    }
    const sourceTimes = (entry.sources || []).map(source => source.createdAt).filter(Number.isFinite);
    const occurredAt = Number(entry.occurredAt) || Math.max(0, ...sourceTimes) || Number(entry.createdAt) || now();
    const title = entry.title || entry.content.slice(0, 60).replace(/\s+/g, " ");
    const value = { id: artifactId, kind: entry.kind || "fact", title, content: entry.content,
      createdAt: existing?.createdAt || entry.createdAt || now(), updatedAt: now(), occurredAt,
      sourceIds: entry.sourceIds || [entry.sourceMessageId].filter(Boolean), noteRefs: entry.noteRefs || [] };
    const operation = files.queue(targetScope, { ...value, artifactId, content: renderDreamDocument(value),
      relativePath: existing?.relativePath || ref?.relativePath,
      expectedHash: ref ? previous?.documentHash || ref.contentHash || existing?.contentHash || "new" : existing?.contentHash || "new",
      metadata: { derivedType: type, derivedId: entry.id, timeZone } });
    return { ...entry, occurredAt, documentRef: { artifactId, ownerId, relativePath: operation.relativePath,
      contentHash: operation.targetHash, opId: operation.opId } };
  }
  function migrate(scope) {
    dream.transaction(() => {
      for (const entry of memories.list(scope, { includeExpired: true })) {
        if (!entry.documentRef && allowed(scope, entry, "memory")) memories.save(scope, stage(scope, entry, "memory"), entry.revision);
      }
      for (const entry of records(scope)) {
        if (!entry.documentRef && allowed(scope, entry, "record")) dream.saveRecord(scope, stage(scope, entry), entry.revision);
      }
    });
  }
  async function drain(scope = null) {
    // Outbox pagination uses immutable sequence IDs; a failed first item cannot
    // starve later documents. Failed writes remain durable for the next pass.
    let after = 0;
    const results = [];
    do {
      const page = catalog.pending(scope, { after, limit: 100 });
      for (const op of page.items) results.push(await files.apply(op.opId));
      after = page.nextCursor;
    } while (after);
    return results;
  }
  function dayOf(value) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  async function daily(scope) {
    const all = allDocuments(scope, { includeRevoked: true });
    for (const ownerId of owners(scope)) {
      const targetScope = { ...scope, ownerId };
      const documents = all.filter(doc => doc.ownerId === ownerId);
      const days = new Set(documents.filter(doc => doc.kind !== "daily").map(doc => dayOf(doc.occurredAt)));
      for (const day of days) {
        const artifactId = `dream-daily-${day}`;
        const relativePath = documentPath({ kind: "daily", day });
        const entries = documents.filter(doc => doc.kind !== "daily" && !doc.revokedAt && !doc.missingAt && dayOf(doc.occurredAt) === day)
          .map(doc => ({ ...doc, id: doc.artifactId, relativePath: path.posix.relative(path.posix.dirname(relativePath), doc.relativePath) }));
        const previous = catalog.get(targetScope, artifactId);
        if (previous?.revokedAt) continue;
        let actual = previous;
        if (previous) {
          try { actual = files.readSync(targetScope, artifactId, { maxChars: 2 }).document; } catch { continue; }
        }
        const content = managedDaily(actual?.content, renderDreamDaily({ date: day, timeZone, entries }));
        if (actual?.contentHash === hash(content)) continue;
        const op = files.queue(targetScope, { artifactId, kind: "daily", title: day, day, content,
          occurredAt: entries[0]?.occurredAt || previous?.occurredAt || now(),
          expectedHash: actual?.contentHash || "new", sourceIds: [], metadata: { timeZone, generated: true } });
        await files.apply(op.opId);
      }
    }
  }
  async function revokeUnavailable(scope) {
    for (const doc of allDocuments(scope, { includeRevoked: true })) {
      if (doc.kind === "daily") continue;
      const type = doc.metadata?.derivedType, id = doc.metadata?.derivedId;
      const entry = type === "memory" ? memories.get(scope, id) : type === "record" ? dream.getRecord(scope, id) : null;
      if (doc.revokedAt || type && (!entry || !allowed(scope, entry, type))) await files.forget({ ...scope, ownerId: doc.ownerId }, doc.artifactId);
    }
  }
  async function prepare(scope) {
    migrate(scope);
    // Drain every owner of this chat, including a newly queued plugin document.
    for (const ownerId of owners(scope)) await drain({ ...scope, ownerId });
    await revokeUnavailable(scope);
    await daily(scope);
    await clearRevokedDailyHistory(scope);
  }
  async function recover() {
    await drain();
    for (const scope of catalog.scopes()) { await revokeUnavailable(scope); await daily(scope); await clearRevokedDailyHistory(scope); }
  }
  function read(scope, id) {
    for (const ownerId of owners(scope)) {
      const document = catalog.get({ ...scope, ownerId }, id);
      if (!document || document.revokedAt) continue;
      const type = document.metadata?.derivedType, derivedId = document.metadata?.derivedId;
      const entry = type === "memory" ? memories.get(scope, derivedId) : type === "record" ? dream.getRecord(scope, derivedId) : null;
      if (type && (!entry || !allowed(scope, entry, type))) continue;
      try {
        // qqHistory supplies its own bounded paging. The file service enforces
        // the 8 MiB read ceiling before this internal full-text read.
        const full = files.readSync({ ...scope, ownerId }, id, { maxChars: 2 });
        return { id, content: full.document.content, createdAt: document.occurredAt, direction: "out",
          source: "dream_document", provenance: { kind: "document", ownerId, path: document.relativePath, sha256: full.sha256 },
          noteRefs: document.noteRefs || [] };
      } catch { return null; }
    }
    return null;
  }
  function search(scope, { query = "", limit = 20, from, to } = {}) {
    const rows = [];
    for (const doc of allDocuments(scope)) {
      if (doc.kind === "daily") continue;
      const source = read(scope, doc.artifactId);
      if (!source || from != null && source.createdAt < from || to != null && source.createdAt > to) continue;
      if (query && !`${doc.title}\n${source.content}`.toLowerCase().includes(query.toLowerCase())) continue;
      rows.push({ id: doc.artifactId, title: doc.title, kind: doc.kind, occurredAt: doc.occurredAt,
        ownerId: doc.ownerId, relativePath: doc.relativePath, contentHash: source.provenance.sha256 });
    }
    return rows.sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id)).slice(0, Math.min(100, Math.max(1, limit)));
  }
  async function forget(scope, entry) {
    if (entry.documentRef) await files.forget(scopeOf(scope, entry.documentRef), entry.documentRef.artifactId);
    await revokeUnavailable(scope);
    await daily(scope);
    await clearRevokedDailyHistory(scope);
  }
  async function clearRevokedDailyHistory(scope) {
    const targets = new Map();
    for (const doc of allDocuments(scope, { includeRevoked: true })) {
      if (doc.revokedAt && doc.kind !== "daily") targets.set(`${doc.ownerId}:${dayOf(doc.occurredAt)}`, doc);
    }
    for (const doc of targets.values()) {
      const id = `dream-daily-${dayOf(doc.occurredAt)}`;
      if (catalog.get({ ...scope, ownerId: doc.ownerId }, id)) await files.clearHistory({ ...scope, ownerId: doc.ownerId }, id);
    }
  }
  function revoke(scope, entry) {
    if (entry.documentRef) catalog.revoke(scopeOf(scope, entry.documentRef), entry.documentRef.artifactId, "forgotten");
  }
  function status(scope) {
    const entries = [...memories.list(scope, { includeExpired: true }), ...records(scope)];
    return entries.flatMap(entry => {
      const op = entry.documentRef?.opId && catalog.getOperation(entry.documentRef.opId);
      return op && !["applied", "resolved", "canceled"].includes(op.state)
        ? [{ id: entry.id, artifactId: op.artifactId, opId: op.opId, ownerId: op.ownerId, state: op.state, error: op.error || "" }] : [];
    });
  }
  async function resolve(scope, proposal) {
    const entries = [...memories.list(scope, { includeExpired: true }).map(entry => ({ entry, type: "memory" })),
      ...[...records(scope)].map(entry => ({ entry, type: "record" }))];
    const match = entries.find(({ entry }) => entry.documentRef?.artifactId === proposal.artifactId && entry.documentRef.opId === proposal.opId);
    if (!match) throw new Error("待合并笔记不在当前聊天中或版本已变化");
    const ref = match.entry.documentRef;
    const result = await files.resolveConflict(scopeOf(scope, ref), ref.artifactId, proposal);
    if (result.state !== "applied") throw new Error(result.error || result.operation?.error || "笔记合并尚未完成");
    const live = match.type === "memory" ? memories.get(scope, match.entry.id) : dream.getRecord(scope, match.entry.id);
    if (live?.documentRef?.opId === ref.opId) {
      const value = { ...live, documentRef: { ...ref, opId: result.operation.opId, contentHash: result.operation.targetHash } };
      if (match.type === "memory") memories.save(scope, value, live.revision);
      else dream.saveRecord(scope, value, live.revision);
    }
    await prepare(scope);
    return { artifactId: ref.artifactId, state: result.state, contentHash: result.operation.targetHash };
  }
  return { stage, migrate, prepare, recover, drain, read, search, forget, revoke, status, resolve };
}

module.exports = { createDreamDocuments };
