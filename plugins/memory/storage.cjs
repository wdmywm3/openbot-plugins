"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const databases = new Map();
const hash = value => crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
function open(root) {
  if (databases.has(root)) return databases.get(root);
  fs.mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, "memory.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS channel_events(channel_id TEXT,chat_id TEXT,event_id TEXT,event_encoding TEXT,event_json BLOB,
      search_text TEXT DEFAULT '',searchable INTEGER DEFAULT 1,sender_id TEXT DEFAULT '',created_at INTEGER DEFAULT 0,PRIMARY KEY(channel_id,chat_id,event_id));
    CREATE TABLE IF NOT EXISTS source_cursors(chat_id TEXT PRIMARY KEY,cursor INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS source_buffers(chat_id TEXT,source_id TEXT,seq INTEGER,value_json TEXT,PRIMARY KEY(chat_id,source_id));
    CREATE TABLE IF NOT EXISTS embedding_receipts(chat_id TEXT,collection TEXT,id TEXT,revision INTEGER,version TEXT,PRIMARY KEY(chat_id,collection,id));
    CREATE TABLE IF NOT EXISTS plugin_answers(chat_id TEXT,id TEXT,content TEXT,PRIMARY KEY(chat_id,id));
    CREATE TABLE IF NOT EXISTS plugin_followups(id TEXT PRIMARY KEY,value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plugin_meta(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);`);
  if (!db.prepare("PRAGMA table_info(embedding_receipts)").all().some(column => column.name === "chunk_ids")) db.exec("ALTER TABLE embedding_receipts ADD COLUMN chunk_ids TEXT NOT NULL DEFAULT '[]'");
  for (const [name, fallback] of [["complete", 1], ["cursor", 0]]) if (!db.prepare("PRAGMA table_info(embedding_receipts)").all().some(column => column.name === name)) db.exec(`ALTER TABLE embedding_receipts ADD COLUMN ${name} INTEGER NOT NULL DEFAULT ${fallback}`);
  let storage;
  const readDocument = (scope, ref) => {
    if (storage.dreamRepository.rollback.pending(scope)) return { rollbackPending: true };
    const result = storage.documentService.readSync({ ...scope, ownerId: ref.ownerId || "host" }, ref.artifactId);
    return { ...result, content: result.document.content,
      pending: ref.opId ? !["applied", "resolved"].includes(storage.documentRepository.getOperation(ref.opId)?.state) : false };
  };
  const memoryRepository = require("./lib/context/channel-memory-repository.cjs").createChannelMemoryRepository(db, { readDocument });
  const dreamRepository = require("./lib/context/channel-dream-repository.cjs").createChannelDreamRepository(db, { readDocument });
  const documentRepository = require("./lib/context/channel-document-repository.cjs").createChannelDocumentRepository(db);
  const scheduledTaskRepository = require("./lib/context/scheduled-task-repository.cjs").createScheduledTaskRepository(db);
  const documentService = require("./lib/features/channels/channel-document-service.cjs").createChannelDocumentService({ repository: documentRepository,
    rootForScope(scope) { const folder = path.join(root, "chats", hash(scope.chatId), ...(scope.ownerId && scope.ownerId !== "host" ? ["owners", hash(scope.ownerId)] : [])); fs.mkdirSync(folder, { recursive: true }); return folder; } });
  storage = { db, root, memoryRepository, dreamRepository, documentRepository, documentService, scheduledTaskRepository,
    getEvent: (channelId, chatId, id) => dreamRepository.source({ channelId, chatId }, id, Number.MAX_SAFE_INTEGER),
    getIdentityProfile: () => null, flush: async () => {},
  };
  storage.documents = require("./lib/features/channels/channel-dream-documents.cjs").createDreamDocuments({ storage });
  databases.set(root, storage); return storage;
}
function close() { for (const storage of databases.values()) { storage.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); storage.db.close(); } databases.clear(); }
module.exports = { open, close, hash };
