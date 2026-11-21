"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const nodemailer = require("nodemailer");
const MimeNode = require("nodemailer/lib/mime-node");
const iconv = require("iconv-lite");
const parseAddresses = require("nodemailer/lib/addressparser");
const { hash, failure } = require("./imap.cjs");

const MAX_BYTES = 6 * 1024 * 1024;
const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows", disableFileAccess: true, disableUrlAccess: true });
const cleanName = name => {
  const safe = path.win32.basename(String(name || "")).normalize().replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").slice(0, 120).replace(/[. ]+$/, "");
  return !safe || /^(?:\.{1,2}|con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(safe) ? "attachment.bin" : safe;
};
function address(value, me) {
  if (value === "me") value = me;
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@,<>"():;\\\[\]\x00-\x1f\x7f]+@[a-z0-9.-]+$/i.test(value))
    throw failure("MAIL_ADDRESS", "收件地址无效，请每项填写一个完整邮箱地址。");
  return value;
}
function recipients(list, me) {
  if (!Array.isArray(list) || list.length > 50) throw failure("MAIL_RECIPIENTS", "每个收件人列表最多可填写 50 个邮箱地址。");
  return [...new Set(list.map(item => address(item, me)))];
}
function header(value) {
  if (typeof value !== "string" || /[\r\n\0]/.test(value) || value.length > 998)
    throw failure("MAIL_HEADER", "邮件标题或邮件头格式无效。");
  return value;
}
function addresses(value) {
  return parseAddresses(String(value || ""), { flatten: true }).map(item => item.address).filter(Boolean);
}
async function chatFiles(ctx, entries = []) {
  if (!Array.isArray(entries) || entries.length > 8) throw failure("MAIL_FILES", "每封邮件最多可添加 8 个聊天附件。");
  let size = 0;
  const files = [];
  for (const ref of entries) {
    if (ref.savedFile) {
      if (ref.messageId) throw failure("MAIL_FILE_SOURCE", "每个附件只可选择一个来源。");
      const parent = path.join(ctx.dataRoot, "downloads", ctx.fileScope);
      const rel = path.relative(parent, path.resolve(ref.savedFile));
      if (!/^mail-[a-zA-Z0-9]+[\\/][^\\/]+$/.test(rel)) throw failure("MAIL_FILE_SCOPE", "请选择本聊天已保存的邮箱附件。");
      const file = path.join(parent, rel);
      let handle;
      try {
        const actual = await fs.realpath(file);
        if (actual !== path.join(await fs.realpath(parent), rel)) throw failure("MAIL_FILE_SCOPE", "附件的保存位置已更改。");
        handle = await fs.open(actual, "r");
        const stat = await handle.stat();
        if (!stat.isFile()) throw failure("MAIL_FILE_SOURCE", "所选附件不是文件。");
        size += stat.size;
        if (size > MAX_BYTES) throw failure("MAIL_FILE_LIMIT", "附件共 " + size + " 字节，本次上限 " + MAX_BYTES + " 字节。");
        const content = Buffer.alloc(stat.size);
        let done = 0;
        while (done < content.length) {
          const read = await handle.read(content, done, content.length - done, done);
          if (!read.bytesRead) throw failure("MAIL_FILE_INCOMPLETE", "保存的附件读取不完整。");
          done += read.bytesRead;
        }
        files.push({ filename: cleanName(ref.name || path.basename(file)), content, contentType: "application/octet-stream" });
      } catch (e) {
        if (e.code === "ENOENT") throw failure("MAIL_FILE_GONE", "已保存的邮箱附件不存在。");
        throw e;
      } finally { await handle?.close(); }
      continue;
    }
    if (!ref.messageId || !ref.name) throw failure("MAIL_FILE_SOURCE", "聊天附件需要消息编号和文件名。");
    const item = await ctx.api.readMessageAttachment({ messageId: ref.messageId, index: ref.index || 0, kind: ref.kind || "file", maxBytes: MAX_BYTES });
    if (item.available === false) throw failure("MAIL_FILE_GONE", "这条聊天消息的附件原件已缺失。");
    const content = Buffer.from(item.data, "base64");
    if (content.length !== item.size) throw failure("MAIL_FILE_INCOMPLETE", "聊天附件的读取长度与原件大小不一致。");
    size += content.length;
    if (size > MAX_BYTES) throw failure("MAIL_FILE_LIMIT", "附件共 " + size + " 字节，本次上限 " + MAX_BYTES + " 字节。");
    files.push({ filename: cleanName(ref.name || item.name), content, contentType: item.mimeType || "application/octet-stream" });
  }
  return files;
}
async function saveFile(ctx, name, bytes, mimeType) {
  if (bytes.length > MAX_BYTES) throw failure("MAIL_FILE_LIMIT", "附件有 " + bytes.length + " 字节，本次上限 " + MAX_BYTES + " 字节。");
  const parent = path.join(ctx.dataRoot, "downloads", ctx.fileScope);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.join(parent, "mail-")), filename = cleanName(name), file = path.join(dir, filename);
  await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  const result = { filename, path: file, fileUri: pathToFileURL(file).href, bytes: bytes.length, mimeType };
  if (mimeType?.startsWith("text/")) Object.assign(result, { preview: bytes.subarray(0, 2048).toString("utf8"), truncated: bytes.length > 2048 });
  if (["image/png","image/jpeg","image/webp","image/gif"].includes(mimeType)) {
    try {
      const asset = await ctx.api.assets({ action: "put", mimeType, name: filename, data: bytes.toString("base64") });
      await ctx.api.assets({ action: "preview", ref: asset.ref, maxEdge: 64 });
      result.attachments = [{ assetRef: asset.ref, caption: filename }];
    } catch (error) { result.previewError = { code: error.code || "MAIL_IMAGE_PREVIEW", message: "图片预览未生成。" }; }
  }
  return result;
}
function headers(input, me) {
  const out = { from: address(input.fromAddress || me, me) };
  if (input.replyTo) out.replyTo = address(input.replyTo, me);
  for (const name of ["to", "cc", "bcc"]) if (input[name] != null) out[name] = recipients(input[name], me);
  if (input.subject != null) out.subject = header(input.subject);
  return out;
}
function targetList(options) {
  const targets = [...new Set(["to", "cc", "bcc"].flatMap(name => options[name] || []))];
  if (!targets.length) throw failure("MAIL_TO_MISSING", "请填写至少一位收件人。");
  return targets;
}
function mimeTree(payload, files) {
  let count = 0, size = 0;
  function visit(part, parent, depth) {
    if (!part || ++count > 64 || depth > 8) throw failure("MAIL_MIME_DEPTH", "邮件 MIME 结构最多允许 64 个部件和 8 层嵌套。");
    const type = part.mime_type;
    if (typeof type !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(type))
      throw failure("MAIL_MIME_TYPE", "邮件 MIME 类型无效。");
    const charset = part.charset || "utf-8", text = type.startsWith("text/");
    if (part.charset && (!text || !/^[a-z0-9._-]{1,40}$/i.test(charset) || !iconv.encodingExists(charset)))
      throw failure("MAIL_CHARSET", "邮件文本字符集无效。");
    const contentType = text ? type + "; charset=" + charset : type, opts = part.filename ? { filename: cleanName(part.filename) } : {};
    const node = parent ? parent.createChild(contentType, opts) : new MimeNode(contentType, opts);
    if (type.startsWith("multipart/")) {
      if (!Array.isArray(part.parts) || !part.parts.length || part.body || part.filename || part.content_id || part.content_disposition)
        throw failure("MAIL_MIME_MULTIPART", "多部分邮件需要子部件，容器只能包含 MIME 类型和部件列表。");
      for (const child of part.parts) visit(child, node, depth + 1);
    } else {
      if (part.parts || part.body?.content != null && part.body?.base64_url_content != null) throw failure("MAIL_MIME_BODY", "邮件部件只能指定一种正文。");
      const value = part.body?.content ?? "", binary = part.body?.base64_url_content;
      if (typeof value !== "string" || !text && part.body?.content != null) throw failure("MAIL_MIME_TEXT", "非文本部件请使用 base64url 编码的内容。");
      if (binary != null && (typeof binary !== "string" || !/^[\w-]*={0,2}$/.test(binary) || binary.replace(/=+$/, "").length % 4 === 1))
        throw failure("MAIL_MIME_ENCODING", "邮件部件的 base64url 格式无效。");
      const bytes = binary == null ? iconv.encode(value, charset) : Buffer.from(binary, "base64url");
      size += bytes.length;
      if (size > MAX_BYTES) throw failure("MAIL_FILE_LIMIT", "邮件部件共 " + size + " 字节，本次上限 " + MAX_BYTES + " 字节。");
      if (part.content_id) {
        if (!/^[^\s<>\x00-\x1f\x7f]{1,240}$/.test(part.content_id)) throw failure("MAIL_MIME_CID", "内嵌邮件部件的 Content-ID 无效。");
        node.setHeader("Content-ID", "<" + part.content_id + ">");
      }
      const disposition = part.content_disposition || (part.filename && (part.content_id ? "inline" : "attachment"));
      if (disposition) {
        if (!["inline","attachment"].includes(disposition)) throw failure("MAIL_MIME_DISPOSITION", "邮件部件的显示方式无效。");
        node.setHeader("Content-Disposition", disposition);
      }
      node.setHeader("Content-Transfer-Encoding", "base64");
      node.setContent(bytes);
    }
    return node;
  }
  if (!files.length) return visit(payload, null, 1);
  const mixed = new MimeNode("multipart/mixed");
  visit(payload, mixed, 1);
  for (const f of files) mixed.createChild(f.contentType, { filename: f.filename })
    .setHeader("Content-Disposition", "attachment").setHeader("Content-Transfer-Encoding", "base64").setContent(f.content);
  return mixed;
}
async function compose(ctx, input, me, extra = {}) {
  const options = { ...headers(input, me), text: String(input.text || ""), ...(input.html != null ? { html: input.html } : {}),
    attachments: [...await chatFiles(ctx, input.attachments), ...(extra.attachments || [])],
    messageId: "<" + randomUUID() + "@" + me.split("@").at(-1) + ">", ...extra.headers };
  const result = await composer.sendMail({ ...options, keepBcc: true });
  if (!input.payload) return { raw: result.message, options };
  if (input.text != null || input.html != null) throw failure("MAIL_MIME_BODY", "已指定 MIME 正文，请移除单独的 text 和 html 字段。");
  const tree = splitRaw(await mimeTree(input.payload, options.attachments).build());
  const fields = splitRaw(result.message).lines.filter(line => !/^(?:Content-[^:]+|MIME-Version):/i.test(line));
  fields.push(...tree.lines.filter(line => /^(?:Content-[^:]+|MIME-Version):/i.test(line)));
  const raw = Buffer.concat([Buffer.from(fields.join("\r\n") + "\r\n\r\n", "latin1"), tree.body]);
  return { raw, options: { ...options, raw } };
}
function splitRaw(raw) {
  const match = /\r?\n\r?\n/.exec(raw.toString("latin1"));
  if (!match) throw failure("MAIL_MIME", "草稿缺少邮件头结束标记。");
  return { lines: raw.subarray(0, match.index).toString("latin1").split(/\r?\n(?![ \t])/),
    body: raw.subarray(match.index + match[0].length) };
}
async function patchDraft(ctx, raw, input, me) {
  const replacement = await compose(ctx, input, me);
  const before = splitRaw(raw), after = splitRaw(replacement.raw);
  const bodyChanged = ["text", "html", "attachments", "payload"].some(k => input[k] != null);
  const keys = new Set(["to", "cc", "bcc", "subject"].filter(k => input[k] != null));
  if (input.fromAddress != null) keys.add("from");
  if (input.replyTo != null) keys.add("reply-to");
  const replace = line => {
    const key = line.split(":", 1)[0].toLowerCase();
    return keys.has(key) || bodyChanged && (key.startsWith("content-") || key === "mime-version");
  };
  const lines = before.lines.filter(line => !replace(line)).concat(after.lines.filter(replace));
  return Buffer.concat([Buffer.from(lines.join("\r\n") + "\r\n\r\n", "latin1"), bodyChanged ? after.body : before.body]);
}
const db = (ctx, collection, input) => ctx.api.database({ name: "mailbox", collection, scope: "chat", ...input });
function scopeKey(ctx, caps, account) {
  return hash([ctx.principal.channelId, ctx.principal.chatId, caps.conversationBinding.account, caps.dataRestoreId || "", account.toLowerCase()]);
}
async function submit(ctx, scope, intent, operation) {
  const key = hash([scope, intent]);
  const { record } = await db(ctx, "submissions", { action: "get", key });
  if (record?.value.state === "accepted") return record.value.result;
  if (record && record.value.state !== "rejected") throw failure("MAIL_SEND_UNKNOWN", "上次提交尚无确定回执，请先在已发送邮件中核对。");
  const reserved = await db(ctx, "submissions", { action: "put", key, expectedRevision: record?.revision || 0, value: { state: "submitting" } });
  const finish = value => db(ctx, "submissions", { action: "put", key, expectedRevision: reserved.record.revision, value });
  let result;
  try { result = await operation(); }
  catch (error) {
    if (error.definitelyRejected === true) { await finish({ state: "rejected" }); throw error; }
    throw failure("MAIL_SEND_UNKNOWN", "发送请求未取得确定回执，请先在已发送邮件中核对。");
  }
  await finish({ state: "accepted", result });
  return result;
}
function sendKey(ctx, input) {
  const p = ctx.principal;
  const origin = p.primaryMessageId || p.messageId || ctx.message?.id;
  if (!origin || p.interactionOrigin?.autonomous || p.interactionOrigin?.requesterIds && !p.interactionOrigin.requesterIds.includes(p.senderId))
    throw failure("MAIL_SEND_ORIGIN", "请在主人私聊中提出发信要求。");
  return [origin, hash(input)];
}
module.exports = { address, addresses, recipients, header, headers, cleanName, chatFiles, saveFile, MAX_BYTES, compose, patchDraft, splitRaw, targetList, db, scopeKey, submit, sendKey };
