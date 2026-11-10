"use strict";

const PIXEL_LIMIT = "EMBEDDING_IMAGE_PIXEL_LIMIT";
const imageFailures = new Set([PIXEL_LIMIT, "EMBEDDING_IMAGE_DECODE"]);
const searchText = value => String(value || "").normalize("NFKC").toLowerCase();

function sourceImage(item, attachment) {
  return { id: item.id, version: item.version, index: attachment.index, createdAt: item.createdAt || 0,
    searchText: searchText(`${String(item.content || "").slice(0, 768)}\n${String(attachment.name || "").slice(0, 300)}`) };
}

function imageFailureStore(storage, scope, markOversized) {
  const { db } = storage, { chatId } = scope;
  const find = db.prepare("SELECT code FROM source_image_failures WHERE chat_id=? AND source_id=? AND image_index=? AND source_version=? AND model_version=?");
  const clear = db.prepare("DELETE FROM source_image_failures WHERE chat_id=? AND source_id=? AND image_index=?");
  const prune = db.prepare("DELETE FROM source_image_failures WHERE chat_id=? AND source_id=? AND source_version<>?");
  const save = db.prepare(`INSERT INTO source_image_failures
    (chat_id,source_id,image_index,source_version,model_version,code,marked,created_at,search_text)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,source_id,image_index) DO UPDATE SET
    marked=CASE WHEN source_version=excluded.source_version AND code=excluded.code THEN max(marked,excluded.marked) ELSE excluded.marked END,
    source_version=excluded.source_version,model_version=excluded.model_version,code=excluded.code,
    created_at=excluded.created_at,search_text=excluded.search_text`);
  return {
    known: (image, modelVersion) => find.get(chatId, image.id, image.index, image.version, modelVersion)?.code,
    record(image, modelVersion, code) {
      const oversized = code === PIXEL_LIMIT;
      save.run(chatId, image.id, image.index, image.version, modelVersion, code, Number(markOversized && oversized), image.createdAt, oversized ? image.searchText : "");
    },
    indexed: image => clear.run(chatId, image.id, image.index),
    prune: (id, version) => prune.run(chatId, id, version),
  };
}

function findSkippedImages(storage, scope, input, markOversized) {
  const query = searchText(input.query).trim(), id = String(input.imageMessageId || "");
  const index = Number.isInteger(input.imageIndex) ? input.imageIndex : null;
  const limit = Math.max(1, Math.min(20, Math.floor(Number(input.limit) || 8)));
  return storage.db.prepare(`SELECT source_id,source_version,image_index FROM source_image_failures
    WHERE chat_id=? AND code=? AND (marked=1 OR ?=1) AND (?='' OR source_id=?) AND (? IS NULL OR image_index=?)
      AND (?='' OR instr(search_text,?)>0 OR source_id=?)
    ORDER BY created_at DESC,source_id,image_index LIMIT ?`)
    .all(scope.chatId, PIXEL_LIMIT, Number(markOversized), id, id, index, index, query, query, String(input.query || "").trim(), limit);
}

// Keep the normal batch fast. Only split deterministic image input failures;
// cancellation, permission errors and infrastructure failures retain their normal handling.
async function writeImageBatch(records, options) {
  if (!records.length) return true;
  const { write, signal, isImage, onIndexed, onFailure } = options;
  signal?.throwIfAborted();
  const operation = write(records);
  if (!operation) return false;
  try { await operation; }
  catch (error) {
    signal?.throwIfAborted();
    if (!imageFailures.has(error?.code) || !records.some(isImage)) throw error;
    if (records.length === 1) {
      onFailure(records[0], error.code);
      return true;
    }
    const middle = Math.floor(records.length / 2);
    return await writeImageBatch(records.slice(0, middle), options) && writeImageBatch(records.slice(middle), options);
  }
  signal?.throwIfAborted();
  onIndexed(records);
  return true;
}

module.exports = { sourceImage, imageFailureStore, findSkippedImages, writeImageBatch };
