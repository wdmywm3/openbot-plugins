"use strict";
const fs = require("node:fs"), path = require("node:path"), { backup } = require("node:sqlite");
const { hash } = require("./storage.cjs");
const { contentFromDreamDocument } = require("./lib/features/channels/channel-dream-documents-format.cjs");
const { decodeRecord } = require("./lib/plugins/plugin-record-codec.cjs");
const running = new Map();
const numericTime = value => value == null || value === "" || Number(value) === 0 ? null : Number.isFinite(Number(value)) ? Number(value) : Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
function metadata(entry) {
  const { content, text, documentContent, ...rest } = entry;
  return rest;
}
function converted(entry, kind, content = entry.content || entry.title || "") {
  const status = entry.invalidatedAt || entry.status === "invalidated" ? "invalidated" : entry.archivedAt || entry.status === "archived" ? "archived"
    : entry.reviewStatus === "pending" || entry.documentUnavailable || entry.documentPending ? "pending" : "active";
  const matter = ["goal", "question", "followup"].includes(kind);
  return { content, kind: matter ? "matter" : kind === "episode" ? "experience" : ["fact", "preference", "experience", "matter"].includes(kind) ? kind : "fact",
    ...(matter ? { subtype: kind, progress: ["active", "waiting", "completed", "canceled", "closed"].includes(entry.status) ? entry.status : "active" } : {}),
    // Legacy retention did not determine validity. Preserve it as provenance rather than inventing expiry or promotion.
    tier: entry.pinned || entry.promotedAt ? "long_term" : "working", status,
    validFrom: numericTime(entry.validFrom), validTo: numericTime(entry.validTo), expiresAt: numericTime(entry.expiresAt),
    subjectRefs: entry.subjectId ? [entry.subjectId] : [], conditions: entry.fact?.conditions || [], sources: [],
    attributes: { legacy: metadata(entry), migration: "memory-plus-v2", provenancePending: true,
      ...(kind === "followup" && numericTime(entry.nextReviewAt) ? { nextReviewAt: numericTime(entry.nextReviewAt) } : {}) } };
}
async function sourceRefs(ctx, chatId, entry) {
  const refs = [], ids = [...new Set([...(entry.sourceIds || []), entry.sourceMessageId].filter(Boolean))];
  for (const id of ids) {
    const result = await ctx.api.sources({ action: "read", chatId, id });
    if (!result.item || result.item.deleted || result.item.routeBlocked) return { refs: [], pending: true };
    refs.push({ chatId, id: result.item.id, version: result.item.version });
  }
  return { refs, pending: !ids.length };
}
function completeDocument(storage, scope, entry) {
  let offset = 0, digest, content = "";
  do {
    const page = storage.documentService.readSync({ ...scope, ownerId: entry.ownerId || "host" }, entry.artifactId,
      { offset, maxChars: 12000, ...(digest ? { expectedSha256: digest } : {}) });
    digest = page.sha256; content += page.content; offset = page.nextOffset;
  } while (offset !== null);
  return { content, sha256: digest };
}
async function writeSnapshot(storage) {
  const identity = ["channel_memories", "channel_dream_records", "channel_documents"].map(table => storage.db.prepare(`SELECT count(*) AS count,coalesce(sum(revision),0) AS revisions FROM ${table}`).get());
  const chats = path.join(storage.root, "chats"), files = [];
  function inspect(directory) {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw Error("迁移备份不读取链接目录，请先处理对应旧文件");
      if (stat.isDirectory()) inspect(file);
      else if (stat.isFile()) files.push([path.relative(chats, file), stat.size, hash(fs.readFileSync(file))]);
    }
  }
  inspect(chats); identity.push(files);
  const folder = path.join(storage.root, "migration-backups", `unified-v2-${hash(JSON.stringify(identity)).slice(0, 16)}`);
  if (fs.existsSync(path.join(folder, "complete.json"))) return folder;
  fs.mkdirSync(folder, { recursive: true });
  const database = path.join(folder, "legacy-memory.sqlite");
  await backup(storage.db, database);
  if (fs.existsSync(chats)) fs.cpSync(chats, path.join(folder, "chats"), { recursive: true, force: true,
    filter(file) { if (fs.lstatSync(file).isSymbolicLink()) throw Error("迁移备份不读取链接目录，请先处理对应旧文件"); return true; } });
  fs.writeFileSync(path.join(folder, "complete.json"), JSON.stringify({ version: 2, createdAt: Date.now(), database: "legacy-memory.sqlite" }));
  return folder;
}
function snapshot(storage) {
  const key = `snapshot:${storage.root}`;
  if (!running.has(key)) running.set(key, writeSnapshot(storage).finally(() => running.delete(key)));
  return running.get(key);
}
async function migrateScope(ctx, storage, scope) {
  if (!scope.chatId) return { migrated: 0 };
  const key = `unified:v2:${scope.chatId}`;
  const finished = storage.db.prepare("SELECT value_json FROM plugin_meta WHERE key=?").get(key);
  if (finished) return JSON.parse(finished.value_json);
  const backupFolder = await snapshot(storage);
  const exclusionRows = storage.db.prepare("SELECT content_hash,sources_json FROM channel_memory_exclusions WHERE channel_id=? AND chat_id=?").all(scope.channelId, scope.chatId);
  const exclusions = exclusionRows.map(row => row.content_hash), excludedSources = new Set(exclusionRows.flatMap(row => JSON.parse(row.sources_json)));
  for (let offset = 0; offset < exclusions.length; offset += 1000) await ctx.api.memory({ action: "import", chatId: scope.chatId,
    exclusions: exclusions.slice(offset, offset + 1000), requestKey: `migration-exclusions:${hash([scope.chatId, offset, exclusions.slice(offset, offset + 1000)].join(":"))}` });
  const sourceIds = [...excludedSources];
  for (let offset = 0; offset < sourceIds.length; offset += 1000) await ctx.api.memory({ action: "import", chatId: scope.chatId,
    excludedSources: sourceIds.slice(offset, offset + 1000).map(id => ({ chatId: scope.chatId, id })),
    requestKey: `migration-source-exclusions:${hash(JSON.stringify([scope.chatId, offset, sourceIds.slice(offset, offset + 1000)]))}` });
  const documents = storage.db.prepare("SELECT value_json,owner_id,artifact_id FROM channel_documents WHERE channel_id=? AND chat_id=? ORDER BY artifact_id").all(scope.channelId, scope.chatId)
    .map(row => ({ ...JSON.parse(row.value_json), ownerId: row.owner_id, artifactId: row.artifact_id }));
  const entries = storage.db.prepare("SELECT entry_json FROM channel_memories WHERE channel_id=? AND chat_id=? ORDER BY id").all(scope.channelId, scope.chatId)
    .map(row => ({ entry: JSON.parse(row.entry_json), family: "fact" }));
  entries.push(...storage.db.prepare("SELECT value_json FROM channel_dream_records WHERE channel_id=? AND chat_id=? ORDER BY id").all(scope.channelId, scope.chatId)
    .map(row => ({ entry: JSON.parse(row.value_json), family: "record" })));
  const ambiguousId = (family, id) => entries.some(item => item.family !== family && item.entry.id === id);
  const linkedArtifacts = (entry, family) => [...new Set([entry.documentRef?.artifactId, ...documents.filter(doc => doc.metadata?.derivedId === entry.id
    && (doc.metadata.derivedType ? doc.metadata.derivedType === (family === "fact" ? "memory" : "record") : !ambiguousId(family, entry.id))).map(doc => doc.artifactId)].filter(Boolean))];
  const sourceExcluded = entry => [...(entry.sourceIds || []), entry.sourceMessageId].filter(Boolean).some(id => excludedSources.has(id));
  const excludedArtifacts = new Set(entries.filter(({ entry }) => sourceExcluded(entry)).flatMap(({ entry, family }) => linkedArtifacts(entry, family)));
  for (const document of documents) if (sourceExcluded(document)) excludedArtifacts.add(document.artifactId);
  const consumed = new Set(excludedArtifacts);
  const files = new Map();
  for (const document of documents) {
    if (consumed.has(document.artifactId) || sourceExcluded(document)) continue;
    try { files.set(document.artifactId, completeDocument(storage, scope, document)); }
    catch (error) { throw Object.assign(Error(`旧记忆正文需要核对：${document.relativePath || document.artifactId}；${error.message}`), { code: "MEMORY_MIGRATION_DOCUMENT", artifactId: document.artifactId }); }
  }
  const mapping = new Map(); let migrated = 0, skippedForgotten = 0;
  async function submit(input) {
    try { const result = await ctx.api.memory(input); if (result.forgotten) { skippedForgotten++; return null; } return result; }
    catch (error) { if (error.code !== "MEMORY_FORGOTTEN_SOURCE") throw error; skippedForgotten++; return null; }
  }
  for (const { entry, family } of entries) {
    for (const artifactId of linkedArtifacts(entry, family)) consumed.add(artifactId);
    if (sourceExcluded(entry)) { skippedForgotten++; continue; }
    const origin = `${family}:${entry.id}`, versions = family === "fact" ? storage.db.prepare("SELECT entry_json FROM channel_memory_revisions WHERE channel_id=? AND chat_id=? AND memory_id=? ORDER BY revision")
      .all(scope.channelId, scope.chatId, entry.id).map(row => JSON.parse(row.entry_json)) : [];
    if (family === "record") {
      for (const row of storage.db.prepare("SELECT before_hash,after_hash FROM channel_dream_undo WHERE channel_id=? AND chat_id=? AND kind='record' AND item_id=?").all(scope.channelId, scope.chatId, entry.id))
        for (const digest of [row.before_hash, row.after_hash]) {
          const blob = storage.db.prepare("SELECT * FROM channel_dream_run_payloads WHERE hash=?").get(digest);
          const version = blob && decodeRecord(blob);
          if (version?.revision && !versions.some(old => old.revision === version.revision)) versions.push(version);
        }
      versions.sort((a, b) => a.revision - b.revision);
    }
    if (!versions.length || versions.at(-1).revision !== entry.revision) versions.push(entry);
    else versions[versions.length - 1] = entry;
    const artifact = linkedArtifacts(entry, family)[0];
    const output = [];
    for (const version of versions) {
      const value = converted(version, family === "fact" ? version.kind || "fact" : version.kind);
      if (version.documentRef || !value.content.trim()) {
        const ref = version.documentRef, file = files.get(ref?.artifactId || artifact);
        const oldWrite = ref?.opId && storage.db.prepare("SELECT content_text FROM channel_document_writes WHERE channel_id=? AND chat_id=? AND op_id=?")
          .get(scope.channelId, scope.chatId, ref.opId);
        const exact = oldWrite?.content_text && (!ref.contentHash || hash(oldWrite.content_text) === ref.contentHash) ? oldWrite.content_text
          : file && (version === entry || ref?.contentHash === file.sha256) ? file.content : "";
        if (exact) value.content = contentFromDreamDocument(exact);
      }
      const provenance = await sourceRefs(ctx, scope.chatId, version);
      value.sources = provenance.refs; value.attributes.provenancePending = provenance.pending;
      if (provenance.pending && version.source !== "manual" && value.status === "active") value.status = "pending";
      if (!value.content.trim()) throw Error(`旧记忆 ${origin} 缺少正文，请核对原文件`);
      output.push(value);
    }
    if (artifact && files.has(artifact)) {
      consumed.add(artifact);
      const body = contentFromDreamDocument(files.get(artifact).content);
      if (!body.trim()) throw Error(`旧记忆 ${origin} 的正文文件为空，请核对`);
      if (body !== output.at(-1).content) output.push({ ...output.at(-1), content: body,
        attributes: { ...output.at(-1).attributes, importedFileHash: files.get(artifact).sha256 } });
    }
    const result = await submit({ action: "import", chatId: scope.chatId, origin, versions: output,
      requestKey: `migration-record:${hash(`${scope.chatId}:${origin}`)}` });
    if (!result) continue;
    if (!result.ok || !result.id) throw Error(`旧记忆 ${origin} 已遗忘或不能导入`);
    mapping.set(origin, result); migrated++;
    storage.db.prepare("INSERT OR REPLACE INTO plugin_meta VALUES(?,?)").run(`unified-map:${scope.chatId}:${origin}`, JSON.stringify({ ...result, legacyRevision: entry.revision }));
  }
  for (const document of documents) {
    if (consumed.has(document.artifactId)) continue;
    if (sourceExcluded(document)) { skippedForgotten++; continue; }
    const original = files.get(document.artifactId), content = contentFromDreamDocument(original.content);
    if (document.kind === "daily" && document.metadata?.generated && !document.externallyModified && original.sha256 === document.contentHash) continue;
    if (!content.trim()) continue;
    // Daily files can contain handwritten paragraphs. Keep their complete body for review instead of treating every daily file as a disposable index.
    const record = converted({ ...document, id: document.artifactId, content, reviewStatus: "pending" }, "experience");
    record.attributes.importedFileHash = original.sha256;
    const result = await submit({ action: "import", chatId: scope.chatId, origin: `document:${document.artifactId}`, versions: [record],
      requestKey: `migration-document:${hash(`${scope.chatId}:${document.artifactId}`)}` });
    if (!result) continue;
    if (!result.ok) throw Error("旧文件已遗忘或不能导入"); migrated++;
    storage.db.prepare("INSERT OR REPLACE INTO plugin_meta VALUES(?,?)").run(`unified-map:${scope.chatId}:document:${document.artifactId}`, JSON.stringify(result));
  }
  for (const { entry, family } of entries) {
    let original = mapping.get(`${family}:${entry.id}`);
    const links = [...new Set(entry.relatedIds || [])].map(id => ({ id, kind: "related" }));
    if (entry.supersedes?.id) links.push({ id: entry.supersedes.id, kind: entry.changeType === "correction" ? "corrects" : "supersedes" });
    for (const { id, kind } of links) {
      const target = mapping.get(`${family}:${id}`); if (!original || !target || target.id === original.id) continue;
      const relationOwner = ambiguousId(family, entry.id) ? `${family}:${entry.id}` : entry.id;
      const result = await ctx.api.memory({ action: "relate", chatId: scope.chatId, id: original.id, targetId: target.id, kind, expectedRevision: original.revision,
        requestKey: `migration-relation:${hash(`${scope.chatId}:${relationOwner}:${id}:${kind}`)}` });
      original = result; mapping.set(`${family}:${entry.id}`, result);
      storage.db.prepare("INSERT OR REPLACE INTO plugin_meta VALUES(?,?)").run(`unified-map:${scope.chatId}:${family}:${entry.id}`,
        JSON.stringify({ ...result, legacyRevision: entry.revision }));
    }
  }
  const pendingWrites = storage.db.prepare("SELECT * FROM channel_document_writes WHERE channel_id=? AND chat_id=? AND state NOT IN ('applied','resolved','canceled') ORDER BY seq")
    .all(scope.channelId, scope.chatId);
  for (const row of pendingWrites) {
    if (excludedArtifacts.has(row.artifact_id)) { skippedForgotten++; continue; }
    if (!row.content_text?.trim()) continue;
    const proposal = converted({ id: row.op_id, content: contentFromDreamDocument(row.content_text), reviewStatus: "pending",
      relativePath: row.relative_path, state: row.state, artifactId: row.artifact_id }, "experience");
    const receipt = await submit({ action: "import", chatId: scope.chatId, origin: `pending-write:${row.op_id}`, versions: [proposal],
      requestKey: `migration-pending:${hash(`${scope.chatId}:${row.op_id}`)}` });
    if (receipt) migrated++;
  }
  // Preserve old follow-up and rollback journals, but do not replay their external operations during migration.
  for (const { entry } of entries.filter(item => item.entry.kind === "followup")) {
    const reference = mapping.get(`record:${entry.id}`); if (!reference) continue;
    const task = entry.taskId ? storage.scheduledTaskRepository.get(entry.taskId) : null;
    const key = `plus:followup:${reference.id}`;
    if (!storage.db.prepare("SELECT 1 FROM plugin_meta WHERE key=?").get(key)) storage.db.prepare("INSERT INTO plugin_meta VALUES(?,?)").run(key, JSON.stringify({
      chatId: scope.chatId, memoryId: reference.id, recordRevision: reference.revision, attempt: 0, paused: true,
      fingerprint: hash(JSON.stringify([reference.id, reference.revision, numericTime(entry.nextReviewAt) || undefined])),
      completed: ["completed", "closed", "canceled"].includes(entry.status) || task?.lastStatus === "completed",
      legacyTask: task ? { id: task.id, status: task.lastStatus || "", lastRun: task.lastRun || null, pauseReason: task.pauseReason || "" } : null,
    }));
  }
  for (const task of storage.scheduledTaskRepository.list(scope.channelId).filter(item => item.chatId === scope.chatId))
    storage.scheduledTaskRepository.save({ ...task, enabled: false, running: null, pauseReason: "unified_memory_migration" });
  const result = { version: 2, migrated, skippedForgotten, at: Date.now(), followupsPaused: true, backupFolder };
  // A management read can race an explicitly submitted import job. An empty scope must not mark that future import complete.
  if (!entries.length && !documents.length && !exclusions.length && !pendingWrites.length) return result;
  storage.db.prepare("INSERT OR REPLACE INTO plugin_meta VALUES(?,?)").run(key, JSON.stringify(result));
  return result;
}
function migrate(ctx, storage, scope) {
  const key = `${storage.root}:${scope.chatId}`;
  if (!running.has(key)) running.set(key, migrateScope(ctx, storage, scope).finally(() => running.delete(key)));
  return running.get(key);
}
module.exports = { migrate, converted, completeDocument, snapshot };
