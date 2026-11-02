"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { documentScope, documentPath } = require("../../context/channel-document-repository.cjs");
const { withDocumentFileLock } = require("./channel-document-file-lock.cjs");
const hash = value => createHash("sha256").update(value).digest("hex");
const MAX_READ_BYTES = 8 * 1024 * 1024;
const fail = (message, code = "DOCUMENT_INVALID") => Object.assign(new Error(message), { code });
const inside = (root, target) => { const relative = path.relative(root, target); return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function checkPathStat(stat, current, target) {
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || stat.isFile() && stat.nlink > 1) throw fail("资料路径不能包含链接或特殊文件", "DOCUMENT_PATH_DENIED");
  if (current !== target && !stat.isDirectory()) throw fail("资料上级路径不是目录");
}
function pathParts(target) {
  const root = path.parse(target).root;
  let current = root;
  return [root, ...target.slice(root.length).split(path.sep).filter(Boolean).map(part => current = path.join(current, part))];
}
function inspectSync(target) {
  let stat;
  for (const current of pathParts(target)) {
    try { stat = fsSync.lstatSync(current); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    checkPathStat(stat, current, target);
  }
  return stat;
}

async function inspect(target) {
  let stat;
  for (const current of pathParts(target)) {
    try { stat = await fs.lstat(current); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    checkPathStat(stat, current, target);
  }
  return stat;
}
function checkOpened(stat, opened) {
  if (!opened.isFile() || opened.nlink > 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw fail("资料文件已变化", "DOCUMENT_CONFLICT");
}
function decodedFile(buffer, length, opened) {
  if (length > MAX_READ_BYTES) throw fail("资料超过 8 MiB");
  const bytes = buffer.subarray(0, length);
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw fail("资料必须是 UTF-8 Markdown 文本"); }
  if (content.includes("\0")) throw fail("资料不是文本文件");
  return { content, bytes, hash: hash(bytes), mtimeMs: opened.mtimeMs };
}
function currentFileSync(target) {
  const stat = inspectSync(target);
  if (!stat) return null;
  if (!stat.isFile() || stat.size > MAX_READ_BYTES) throw fail("资料不存在、不是普通文件或超过 8 MiB");
  const handle = fsSync.openSync(target, "r");
  try {
    const opened = fsSync.fstatSync(handle); checkOpened(stat, opened);
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1); let length = 0;
    while (length < buffer.length) {
      const bytesRead = fsSync.readSync(handle, buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const latest = fsSync.fstatSync(handle);
    if (opened.size !== latest.size || opened.mtimeMs !== latest.mtimeMs || opened.ctimeMs !== latest.ctimeMs) throw fail("资料读取期间发生变化", "DOCUMENT_CONFLICT");
    return decodedFile(buffer, length, opened);
  } finally { fsSync.closeSync(handle); }
}
async function currentFile(target) {
  const stat = await inspect(target);
  if (!stat) return null;
  if (!stat.isFile() || stat.size > MAX_READ_BYTES) throw fail("资料不存在、不是普通文件或超过 8 MiB");
  const handle = await fs.open(target, "r");
  try {
    const opened = await handle.stat();
    checkOpened(stat, opened);
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const latest = await handle.stat();
    if (opened.size !== latest.size || opened.mtimeMs !== latest.mtimeMs || opened.ctimeMs !== latest.ctimeMs) throw fail("资料读取期间发生变化", "DOCUMENT_CONFLICT");
    return decodedFile(buffer, length, opened);
  } finally { await handle.close(); }
}

function createChannelDocumentService({ repository, rootForScope, historyRootsFor = () => [], withLock = withDocumentFileLock, now = Date.now, afterReplace } = {}) {
  if (!repository || typeof rootForScope !== "function") throw new Error("资料服务需要仓库和范围目录解析器");
  function resolveTarget(configured, relativePath) {
    if (typeof configured !== "string" || !path.isAbsolute(configured)) throw fail("资料范围未绑定有效目录", "DOCUMENT_PATH_DENIED");
    const root = path.resolve(configured), relative = documentPath({ relativePath });
    const target = path.resolve(root, ...relative.split("/"));
    if (!inside(root, target)) throw fail("资料路径超出所属范围", "DOCUMENT_PATH_DENIED");
    return { root, target };
  }
  function targetForSync(scope, relativePath) {
    const resolved = resolveTarget(rootForScope(documentScope(scope)), relativePath);
    inspectSync(resolved.root); inspectSync(resolved.target);
    return resolved;
  }
  async function targetFor(scope, relativePath, create = false) {
    scope = documentScope(scope);
    const { root, target } = resolveTarget(await rootForScope(scope), relativePath);
    await inspect(root); await inspect(target);
    if (create) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await inspect(root); await inspect(path.dirname(target)); await inspect(target);
    }
    return { root, target };
  }
  async function backup(root, op, current) {
    if (!current) return;
    const relativePath = `notes/.history/${hash(op.artifactId).slice(0, 32)}/${current.hash}.md`;
    const file = await targetFor(op.scope, relativePath, true);
    if (file.root !== root) throw fail("资料目录在写回期间发生变化", "DOCUMENT_PATH_DENIED");
    let handle;
    try {
      handle = await fs.open(file.target, "wx", 0o600);
      await handle.writeFile(current.bytes); await handle.sync();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await currentFile(file.target);
      if (previous?.hash !== current.hash) throw fail("资料历史版本内容不匹配");
    } finally { await handle?.close(); }
    const time = new Date(now()); await fs.utimes(file.target, time, time);
    const directory = path.dirname(file.target);
    const history = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.md$/.test(entry.name)) continue;
      const target = path.join(directory, entry.name), stat = await inspect(target);
      if (stat?.isFile()) history.push({ target, mtimeMs: stat.mtimeMs });
    }
    history.sort((a, b) => b.mtimeMs - a.mtimeMs || a.target.localeCompare(b.target));
    for (const old of history.slice(10)) {
      if (!inside(root, old.target)) throw fail("历史资料路径超出范围");
      await inspect(old.target); await fs.unlink(old.target);
    }
  }
  function activeOperation(opId) {
    const op = repository.getOperation(opId);
    if (!op) throw fail("写回操作不存在");
    if (op.state === "canceled" || repository.get(op.scope, op.artifactId)?.revokedAt) throw fail("资料已撤销", "DOCUMENT_REVOKED");
    return op;
  }
  const resultFor = (op, extra = {}) => ({ opId: op.opId, artifactId: op.artifactId, state: op.state,
    operation: op, document: repository.get(op.scope, op.artifactId), ...extra });

  async function apply(opId) {
    let op = repository.getOperation(opId);
    if (!op) throw fail("写回操作不存在");
    if (["applied", "canceled", "conflict", "resolved"].includes(op.state)) return resultFor(op);
    let target;
    try {
      const resolved = await targetFor(op.scope, op.relativePath);
      target = resolved.target;
      return await withLock(target, async () => {
        op = activeOperation(opId);
        if (["applied", "conflict", "resolved"].includes(op.state)) return resultFor(op);
        const current = await currentFile(target);
        if (current?.hash === op.targetHash) {
          repository.finish(opId, { content: current.content, mtimeMs: current.mtimeMs });
          return resultFor(repository.getOperation(opId), { recovered: true });
        }
        if ((current?.hash || "new") !== op.expectedHash) return resultFor(repository.markConflict(opId));
        if (typeof op.content !== "string") throw fail("待写回操作缺少正文");
        const created = await targetFor(op.scope, op.relativePath, true);
        if (created.target !== target || created.root !== resolved.root) throw fail("资料目录在写回期间发生变化", "DOCUMENT_PATH_DENIED");
        await backup(resolved.root, op, current);
        activeOperation(opId);
        const temporary = path.join(path.dirname(target), `.document-write-${randomUUID()}.tmp`);
        try {
          const handle = await fs.open(temporary, "wx", 0o600);
          try { await handle.writeFile(op.content, "utf8"); await handle.sync(); }
          finally { await handle.close(); }
          // Recheck after awaits, including writes made by editors outside this host lock.
          const latest = currentFileSync(target);
          if ((latest?.hash || "new") !== op.expectedHash) return resultFor(repository.markConflict(opId));
          activeOperation(opId); inspectSync(path.dirname(target));
          // Keep the final compare-and-replace in one event-loop turn, including synchronous plugin writers.
          fsSync.renameSync(temporary, target);
          if (afterReplace) await afterReplace({ operation: op, path: target });
          const written = await currentFile(target);
          if (!written || written.hash !== op.targetHash) return resultFor(repository.markConflict(opId, "落盘后资料被再次修改，请重新读取后合并"));
          activeOperation(opId);
          repository.finish(opId, { content: written.content, mtimeMs: written.mtimeMs });
          return resultFor(repository.getOperation(opId), { recovered: false });
        } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
      });
    } catch (error) {
      const latest = repository.getOperation(opId);
      if (!latest) throw error;
      if (latest.state === "canceled" || error.code === "DOCUMENT_REVOKED") return resultFor(latest, { error: error.message });
      const marked = error.code === "DOCUMENT_CONFLICT" ? repository.markConflict(opId, error.message) : repository.markError(opId, error);
      return resultFor(marked, { error: error.message });
    }
  }
  function pageFor(scope, id, entry, target, current, { offset = 0, maxChars = 12000, expectedSha256 } = {}) {
    if (!current) { repository.markMissing(scope, id); throw fail("资料文件已移走或删除", "DOCUMENT_MISSING"); }
    if (repository.get(scope, id)?.revokedAt) throw fail("资料已撤销", "DOCUMENT_REVOKED");
    const document = repository.reconcileIndex(scope, id, { content: current.content, mtimeMs: current.mtimeMs });
    if (!Number.isInteger(offset) || offset < 0 || offset > current.content.length || !Number.isInteger(maxChars) || maxChars < 2 || maxChars > 12000) throw fail("资料分页范围无效");
    if (offset > 0 && !expectedSha256) throw fail("续读资料需要上一页的 sha256");
    if (expectedSha256 && expectedSha256 !== current.hash) throw fail("资料版本已变化，请从第一页重新读取", "DOCUMENT_CONFLICT");
    if (offset && /[\uDC00-\uDFFF]/.test(current.content[offset] || "") && /[\uD800-\uDBFF]/.test(current.content[offset - 1])) throw fail("请使用上一页返回的 nextOffset");
    let end = Math.min(offset + maxChars, current.content.length);
    if (end < current.content.length && /[\uD800-\uDBFF]/.test(current.content[end - 1])) end--;
    return { artifactId: id, path: target, relativePath: entry.relativePath, document, content: current.content.slice(offset, end),
      sha256: current.hash, offset, nextOffset: end < current.content.length ? end : null, totalChars: current.content.length };
  }
  function readableEntry(scope, id) {
    const entry = repository.get(scope, id);
    if (!entry || entry.revokedAt) throw fail("资料不存在或已撤销", "DOCUMENT_NOT_FOUND");
    return entry;
  }
  function readSync(scope, id, options = {}) {
    scope = documentScope(scope);
    const entry = readableEntry(scope, id);
    const { target } = targetForSync(scope, entry.relativePath);
    // No await: a synchronous caller observes a complete old or new file between atomic replacements.
    return pageFor(scope, id, entry, target, currentFileSync(target), options);
  }
  async function read(scope, id, options = {}) {
    scope = documentScope(scope);
    const entry = readableEntry(scope, id);
    const { target } = await targetFor(scope, entry.relativePath);
    return withLock(target, async () => pageFor(scope, id, entry, target, await currentFile(target), options));
  }
  async function resolveConflict(scope, id, { opId, expectedSha256, content, resolutionId } = {}) {
    scope = documentScope(scope);
    const original = repository.getOperation(opId);
    if (!original || original.artifactId !== id || JSON.stringify(original.scope) !== JSON.stringify(scope)) throw fail("写回冲突不属于当前资料", "DOCUMENT_NOT_FOUND");
    if (!["conflict", "resolved"].includes(original.state)) throw fail("写回操作当前不处于冲突状态", "DOCUMENT_OPERATION_CONFLICT");
    if (!/^[a-f0-9]{64}$/.test(expectedSha256 || "")) throw fail("解决冲突需要当前完整文件的 SHA-256");
    if (content !== undefined && typeof content !== "string") throw fail("合并后的正文必须是 Markdown 文本");
    const mode = content === undefined ? "adopt" : "merge";
    const nextId = resolutionId || `document-resolution-${hash(JSON.stringify([opId, expectedSha256, mode, content === undefined ? expectedSha256 : hash(content)]))}`;
    const existing = repository.getOperation(nextId);
    if (existing) {
      if (existing.resolvesOpId !== opId || existing.expectedHash !== expectedSha256 || existing.resolutionMode !== mode
        || content !== undefined && existing.targetHash !== hash(content)) throw fail("冲突处理编号已用于不同内容", "DOCUMENT_OPERATION_CONFLICT");
      return { ...await apply(existing.opId), resolutionOf: opId };
    }
    if (original.state === "resolved") throw fail("该冲突已处理，请读取最新版本", "DOCUMENT_OPERATION_CONFLICT");
    const { target } = await targetFor(scope, original.relativePath);
    const operation = await withLock(target, async () => {
      if (repository.get(scope, id)?.revokedAt) throw fail("资料已撤销", "DOCUMENT_REVOKED");
      const current = currentFileSync(target);
      if (!current || current.hash !== expectedSha256) throw fail("资料版本已变化，请读取全文后重新合并", "DOCUMENT_CONFLICT");
      return repository.enqueue(scope, { ...original.metadata, artifactId: id, relativePath: original.relativePath,
        expectedHash: expectedSha256, content: content === undefined ? current.content : content,
        opId: nextId, resolvesOpId: opId, resolutionMode: mode });
    });
    return { ...await apply(operation.opId), resolutionOf: opId };
  }
  function purgeHistories(scope, id, entry, root, target) {
      const history = path.join(root, "notes", ".history", hash(id).slice(0, 32));
      const historyStat = inspectSync(history);
      if (historyStat) {
        if (!historyStat.isDirectory()) throw fail("资料历史路径不是目录", "DOCUMENT_PATH_DENIED");
        for (const name of fsSync.readdirSync(history)) {
          if (!/^[a-f0-9]{64}\.md$/.test(name)) continue;
          const previous = path.join(history, name), previousStat = inspectSync(previous);
          if (previousStat?.isFile() && inside(root, previous)) fsSync.unlinkSync(previous);
        }
      }
      // Other host tools own their backup layouts; only their trusted resolver
      // can name exact per-file directories outside the document workspace.
      const external = historyRootsFor(scope, { target, relativePath: entry.relativePath });
      if (!Array.isArray(external)) throw fail("资料历史目录配置无效", "DOCUMENT_PATH_DENIED");
      for (const item of external) {
        if (!item || typeof item.root !== "string" || typeof item.dir !== "string" || !path.isAbsolute(item.root) || !path.isAbsolute(item.dir)) throw fail("资料历史目录配置无效", "DOCUMENT_PATH_DENIED");
        const historyRoot = path.resolve(item.root), directory = path.resolve(item.dir);
        if (!inside(historyRoot, directory)) throw fail("资料历史目录超出范围", "DOCUMENT_PATH_DENIED");
        inspectSync(historyRoot);
        const stat = inspectSync(directory);
        if (!stat) continue;
        if (!stat.isDirectory()) throw fail("资料历史路径不是目录", "DOCUMENT_PATH_DENIED");
        for (const name of fsSync.readdirSync(directory)) {
          const previous = path.join(directory, name), previousStat = inspectSync(previous);
          if (previousStat?.isFile() && inside(directory, previous)) fsSync.unlinkSync(previous);
        }
      }
  }
  async function clearHistory(scope, id) {
    scope = documentScope(scope);
    const entry = repository.get(scope, id);
    if (!entry || entry.unregistered) return { artifactId: id, cleared: true };
    const { root, target } = await targetFor(scope, entry.relativePath);
    return withLock(target, async () => {
      const checked = targetForSync(scope, entry.relativePath);
      if (checked.root !== root || checked.target !== target) throw fail("资料目录在清理期间发生变化", "DOCUMENT_PATH_DENIED");
      purgeHistories(scope, id, entry, root, target);
      return { artifactId: id, cleared: true };
    });
  }
  async function forget(scope, id, reason = "") {
    scope = documentScope(scope);
    const entry = repository.revoke(scope, id, reason);
    if (entry.unregistered) return { artifactId: id, state: "revoked", document: entry };
    const { root, target } = await targetFor(scope, entry.relativePath);
    return withLock(target, async () => {
      // Revocation precedes all I/O and remains durable when deletion must be retried.
      const checked = targetForSync(scope, entry.relativePath);
      if (checked.root !== root || checked.target !== target) throw fail("资料目录在遗忘期间发生变化", "DOCUMENT_PATH_DENIED");
      const stat = inspectSync(target);
      if (stat) {
        if (!stat.isFile()) throw fail("资料路径不是普通文件", "DOCUMENT_PATH_DENIED");
        fsSync.unlinkSync(target);
      }
      purgeHistories(scope, id, entry, root, target);
      return { artifactId: id, state: "revoked", document: repository.get(scope, id) };
    });
  }
  async function drain(scope = null, { after = 0, limit = 100 } = {}) {
    const page = repository.pending(scope, { after, limit }), items = [];
    for (const op of page.items) items.push(await apply(op.opId));
    return { items, nextCursor: page.nextCursor,
      applied: items.filter(item => item.state === "applied").length, conflicts: items.filter(item => item.state === "conflict").length,
      errors: items.filter(item => item.state === "error").length };
  }
  async function reconcile(scope, { after = "", limit = 100 } = {}) {
    const page = repository.list(scope, { after, limit }), items = [];
    for (const entry of page.records) {
      try { const value = await read(scope, entry.artifactId, { maxChars: 2 }); items.push({ artifactId: entry.artifactId, state: "ready", contentHash: value.sha256 }); }
      catch (error) { items.push({ artifactId: entry.artifactId, state: error.code === "DOCUMENT_MISSING" ? "missing" : "error", error: error.message }); }
    }
    return { items, nextCursor: page.nextCursor };
  }
  return { queue: (scope, proposal) => repository.enqueue(scope, proposal), apply, drain, read, readSync, reconcile, forget, clearHistory, resolveConflict,
    versionSync(scope, relativePath) { return currentFileSync(targetForSync(scope, relativePath).target)?.hash || "new"; },
    restoreSync(scope, relativePath, content, expectedHashes) {
      const { target } = targetForSync(scope, relativePath);
      const current = currentFileSync(target), targetHash = content == null ? "new" : hash(Buffer.from(content, "utf8"));
      if (!expectedHashes.includes(current?.hash || "new")) throw fail("笔记在回滚期间被修改，请重新核对", "DOCUMENT_CONFLICT");
      if ((current?.hash || "new") === targetHash) return;
      if (content == null) { fsSync.unlinkSync(target); return; }
      fsSync.mkdirSync(path.dirname(target), { recursive: true }); inspectSync(path.dirname(target));
      const temporary = path.join(path.dirname(target), `.document-rollback-${randomUUID()}.tmp`);
      try {
        const handle = fsSync.openSync(temporary, "wx", 0o600);
        try { fsSync.writeFileSync(handle, content, "utf8"); fsSync.fsyncSync(handle); } finally { fsSync.closeSync(handle); }
        if (!expectedHashes.includes(currentFileSync(target)?.hash || "new")) throw fail("笔记在回滚期间被修改", "DOCUMENT_CONFLICT");
        fsSync.renameSync(temporary, target);
      } finally { if (fsSync.existsSync(temporary)) fsSync.unlinkSync(temporary); }
    },
    revoke: (...args) => repository.revoke(...args) };
}
module.exports = { createChannelDocumentService };
