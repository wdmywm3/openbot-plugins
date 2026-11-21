"use strict";

const { createHash } = require("node:crypto");
const { ImapFlow } = require("imapflow");
const { convert } = require("html-to-text");

const PAGE = 12, SEARCH_WINDOW = 1000, UID_WINDOW = 4096, NOTICE_BATCH = 3;
const BODY_BYTES = 48 * 1024, BODY_CHARS = 8000;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const failure = (code, message) => Object.assign(new Error(message), { code });
const validUid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const clip = (value, length) => String(value || "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, length);

function filters(input) {
  const result = {};
  for (const key of ["from", "subject"]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string" || input[key].length > 200 || /[\r\n\0]/.test(input[key]))
      throw failure("MAIL_FILTER", "邮件筛选条件无效。");
    if (input[key].trim()) result[key] = input[key].trim();
  }
  return result;
}

async function connection(ctx) {
  const user = (ctx.config.username || "").trim();
  if (!user) throw failure("MAIL_ACCOUNT_MISSING", "请在本实例的邮箱设置中填写邮箱账号。");
  const server = (await ctx.api.getSecret("imapServer") || "").trim();
  if (!server) throw failure("MAIL_SERVER_MISSING", "请在本实例的邮箱设置中填写 IMAP 服务器。");
  const { host, port } = endpoint(server, "IMAP", 993);
  const pass = await ctx.api.getSecret("imapPassword");
  if (!pass) throw failure("MAIL_PASSWORD_MISSING", "请在本实例的邮箱设置中填写邮箱授权码或应用密码。");
  return { host, port, user, pass, accountKey: hash([host, port, user]) };
}
function endpoint(server, protocol, defaultPort) {
  const match = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(server);
  if (!match || !match[1].split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))
    throw failure("MAIL_SERVER_INVALID", protocol + " 服务器须填写域名，可附加端口。");
  const host = match[1].toLowerCase(), port = Number(match[2] || defaultPort);
  if (port < 1 || port > 65535) throw failure("MAIL_PORT_INVALID", protocol + " 端口须在 1 至 65535 之间。");
  return { host, port };
}

function imapError(error, phase) {
  if (String(error.code || "").startsWith("MAIL_")) return error;
  if (error.authenticationFailed) return failure("MAIL_LOGIN", "IMAP 服务器拒绝了邮箱登录。");
  if (error.code === "ENOTFOUND") return failure("MAIL_DNS", "无法解析 IMAP 服务器域名。");
  if (["ETIMEDOUT", "ETIMEOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "SocketTimeout"].includes(error.code))
    return failure("MAIL_TIMEOUT", "等待 IMAP 服务器响应超时。");
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(error.code))
    return failure("MAIL_TLS", "IMAP 服务器的 TLS 证书验证失败。");
  // Upstream error text can echo commands, mailbox content or login data.
  const status = String(error.responseStatus || error.code || "").toUpperCase();
  const suffix = /^[A-Z][A-Z0-9_]{0,40}$/.test(status) ? "（" + status + "）" : "";
  return failure("MAIL_" + phase[0], phase[1] + suffix + "。");
}

async function withInbox(settings, perform, folder = "INBOX", writable = false) {
  if (!folder || folder.length > 256 || /[\x00-\x1f\x7f]/.test(folder)) throw failure("MAIL_FOLDER", "邮件文件夹名称无效。");
  const client = new ImapFlow({ host: settings.host, port: settings.port, auth: { user: settings.user, pass: settings.pass },
    secure: true, tls: { minVersion: "TLSv1.2", rejectUnauthorized: true }, logger: false, emitLogs: false,
    disableAutoIdle: true, disableCompression: true, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000,
    maxLiteralSize: 256 * 1024, maxResponseSize: 512 * 1024, maxLineLength: 256 * 1024,
    clientInfo: { name: "OpenBot Mailbox", version: "0.2.0" } });
  // Socket errors are also surfaced by the outstanding IMAP operation.
  client.on("error", () => {});
  let phase = ["CONNECT", "连接 IMAP 服务器失败"];
  try {
    await client.connect();
    phase = ["OPEN", "打开邮件文件夹失败"];
    const mailbox = await client.mailboxOpen(folder, { readOnly: !writable });
    if (writable && mailbox.readOnly) throw failure("MAIL_READONLY", "邮件服务器以只读方式打开了文件夹。");
    if (!validUid(Number(mailbox.uidValidity)) || !validUid(mailbox.uidNext))
      throw failure("MAIL_IDENTITY", "IMAP 服务器未返回有效的收件箱编号。");
    const parts = [settings.accountKey, String(mailbox.uidValidity)];
    if (folder.toUpperCase() !== "INBOX") parts.push(folder);
    const box = { client, mailbox, folder, namespace: hash(parts) };
    phase = writable ? ["CHANGE", "更新邮件失败"] : ["FETCH", "读取邮件文件夹失败"];
    return await perform(box);
  } catch (error) {
    throw imapError(error, phase);
  } finally {
    // Each operation owns its TLS connection. No IDLE session survives cancellation.
    client.close();
  }
}

function metadata(box, item) {
  const envelope = item.envelope || {};
  const sender = envelope.from?.[0] || {};
  return { id: box.namespace + "." + item.uid, folder: box.folder, subject: clip(envelope.subject, 240),
    ...(item.flags ? { unread: !item.flags.has("\\Seen"), starred: item.flags.has("\\Flagged") } : {}),
    from: clip(sender.name, 100), address: clip(sender.address, 254),
    ...(envelope.messageId ? { messageId: clip(envelope.messageId, 250) } : {}),
    ...(envelope.inReplyTo ? { inReplyTo: clip(envelope.inReplyTo, 250) } : {}),
    receivedAt: item.internalDate instanceof Date ? item.internalDate.toISOString() : null };
}

async function search(box, input) {
  const criteria = filters(input);
  if (input.unread != null) criteria.seen = !input.unread;
  if (input.starred != null) criteria.flagged = input.starred;
  const queryKey = hash([box.namespace, criteria]);
  let top = box.mailbox.exists, before = box.mailbox.uidNext - 1;
  if (input.cursor) {
    const [namespace, seq, uid, extra] = input.cursor.split(".");
    if (extra !== undefined || namespace !== queryKey || !validUid(Number(seq)) || !validUid(Number(uid)))
      throw failure("MAIL_CURSOR", "查询条件或收件箱已变化，请重新查询邮件。");
    top = Math.min(Number(seq), top);
    before = Math.min(Number(uid), before);
  }
  if (!top || !before) return { messages: [], nextCursor: null };
  const low = Math.max(1, top - SEARCH_WINDOW + 1);
  const ids = await matchingUids(box, { ...criteria, seq: low + ":" + top, uid: "1:" + before });
  const limit = input.limit || PAGE;
  const selected = ids.sort((a, b) => b - a).slice(0, limit);
  const rows = selected.length ? await box.client.fetchAll(selected.join(","), { envelope: true, internalDate: true, flags: true }, { uid: true }) : [];
  const more = ids.length > limit, nextTop = more ? top : low - 1;
  const nextUid = more ? selected.at(-1) - 1 : before;
  return { messages: rows.sort((a, b) => b.uid - a.uid).map(item => metadata(box, item)),
    nextCursor: nextTop && nextUid ? [queryKey, nextTop, nextUid].join(".") : null };
}

async function matchingUids(box, query) {
  const ids = await box.client.search(query, { uid: true });
  if (!Array.isArray(ids) || !ids.every(validUid)) throw failure("MAIL_SEARCH", "IMAP 服务器未返回有效的邮件查询结果。");
  return ids;
}

function textPart(node) {
  if (!node || node.disposition?.toLowerCase() === "attachment" || node.dispositionParameters?.filename || node.parameters?.name) return null;
  const type = node.type.toLowerCase();
  if (type === "text/plain" || type === "text/html") return node;
  if (!type.startsWith("multipart/")) return null;
  const parts = (node.childNodes || []).map(textPart).filter(Boolean);
  return parts.find(child => child.type.toLowerCase() === "text/plain") || parts[0] || null;
}

function uidOf(box, id) {
  const [namespace, number, extra] = (id || "").split("."), uid = Number(number);
  if (extra !== undefined || !validUid(uid) || String(uid) !== number) throw failure("MAIL_ID_INVALID", "邮件编号无效。");
  if (namespace !== box.namespace) throw failure("MAIL_ID_STALE", "这封邮件的编号已不属于当前收件箱，请重新查询。");
  return uid;
}
function attachments(node, out = []) {
  if (!node) return out;
  const name = node.dispositionParameters?.filename || node.parameters?.name;
  if (name || node.disposition?.toLowerCase() === "attachment" || (!node.childNodes && !node.type.startsWith("text/"))) {
    out.push({ part: node.part || "1", filename: clip(name || "attachment", 180), mimeType: node.type, encodedBytes: node.size });
  } else for (const child of node.childNodes || []) attachments(child, out);
  return out;
}
async function read(box, id, limit = BODY_CHARS) {
  const uid = uidOf(box, id);
  const item = await box.client.fetchOne(uid, { envelope: true, internalDate: true, flags: true, bodyStructure: true }, { uid: true });
  if (!item) throw failure("MAIL_GONE", "这封邮件已不在收件箱中。");
  const info = metadata(box, item), part = textPart(item.bodyStructure);
  if (limit === BODY_CHARS) info.files = attachments(item.bodyStructure);
  if (!part) return { ...info, text: "", hasTextPart: false, truncated: false };
  const { content } = await box.client.download(uid, part.part || "1", { uid: true, chunkSize: 8192, maxBytes: BODY_BYTES + 1 });
  if (!content) {
    if (!await box.client.fetchOne(uid, { uid: true }, { uid: true })) throw failure("MAIL_GONE", "这封邮件已不在收件箱中。");
    throw failure("MAIL_BODY_GONE", "服务器未返回这封邮件的正文部分。");
  }
  const chunks = [];
  for await (const chunk of content) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  let text = bytes.subarray(0, BODY_BYTES).toString("utf8");
  if (part.type.toLowerCase() === "text/html") text = convert(text, { wordwrap: false,
    selectors: [{ selector: "img", format: "skip" }] });
  text = text.trim();
  return { ...info, text: clip(text, limit), hasTextPart: true, truncated: bytes.length > BODY_BYTES || text.length > limit };
}

async function changes(box, watch) {
  if (watch.namespace !== box.namespace) return { reset: true };
  const high = Math.min(watch.after + UID_WINDOW, box.mailbox.uidNext - 1);
  if (high <= watch.after) return { after: watch.after, messages: [] };
  const ids = await matchingUids(box, { ...watch.criteria, uid: (watch.after + 1) + ":" + high });
  ids.sort((a, b) => a - b);
  const batch = ids.slice(0, NOTICE_BATCH), messages = [];
  for (const uid of batch) {
    try { messages.push(await read(box, box.namespace + "." + uid, 480)); }
    catch (error) {
      if (error.code === "MAIL_GONE") continue;
      if (error.code !== "MAIL_BODY_GONE") throw error;
      const item = await box.client.fetchOne(uid, { envelope: true, internalDate: true }, { uid: true });
      if (item) messages.push({ ...metadata(box, item), bodyError: { code: error.code, message: error.message } });
    }
  }
  return { after: ids.length > batch.length ? batch.at(-1) : high, messages };
}

module.exports = { connection, withInbox, search, read, changes, filters, failure, hash, uidOf, endpoint, attachments };
