"use strict";
const crypto = require("node:crypto"), zlib = require("node:zlib");
// Stable, lossless wire representation, compressed only when it saves space.
// JSON remains an API representation, not a repeated text document on disk.
function encodeRecord(value) {
  const raw = Buffer.from(JSON.stringify(value ?? null));
  if (raw.length > 32 * 1024 * 1024) throw new Error("插件记录超过大小限制，原记录未修改");
  const packed = raw.length >= 256 ? zlib.deflateRawSync(raw, { level: 3 }) : raw;
  const compressed = packed.length + 24 < raw.length;
  return { hash: crypto.createHash("sha256").update(raw).digest("hex"), encoding: compressed ? "deflate-json-v1" : "json-v1",
    bytes: raw.length, data: compressed ? packed : raw };
}
function decodeRecord(row) {
  if (!row) return undefined;
  if (!["json-v1", "deflate-json-v1"].includes(row.encoding) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 32 * 1024 * 1024) throw new Error("插件记录编码无效");
  const bytes = row.encoding === "deflate-json-v1" ? zlib.inflateRawSync(row.data, { maxOutputLength: Math.max(1, row.bytes) }) : Buffer.from(row.data);
  if (bytes.length !== row.bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== row.hash) throw new Error("插件记录校验失败");
  return JSON.parse(bytes.toString("utf8"));
}
module.exports = { encodeRecord, decodeRecord };
