"use strict";

const { randomUUID } = require("node:crypto");
const nodemailer = require("nodemailer");
const gmail = require("./gmail.cjs");
const imap = require("./imap.cjs");
const imapActions = require("./imap-actions.cjs");
const mail = require("./compose.cjs");

const editable = ["to", "cc", "bcc", "subject", "text", "html", "attachments", "payload", "fromAddress", "replyTo"];
const pick = input => Object.fromEntries(editable.filter(k => input[k] != null).map(k => [k, input[k]]));
async function sender(a, input) {
  if (input.classificationLabelValues && !a.gmail) throw imap.failure("MAIL_CLASSIFICATION", "分类标签需要 Google Workspace 邮箱。");
  if (!input.fromAddress || mail.address(input.fromAddress, a.email).toLowerCase() === a.email.toLowerCase()) return;
  if (a.gmail) {
    const aliases = await a.gmail.call("settings/sendAs");
    if (aliases.sendAs?.some(x => x.sendAsEmail.toLowerCase() === input.fromAddress.toLowerCase() && (x.isPrimary || x.verificationStatus === "accepted"))) return;
  }
  throw imap.failure("MAIL_FROM", "这个邮箱没有获准使用指定的发件地址。");
}
async function smtp(ctx, settings) {
  const preset = { "imap.qq.com": "smtp.qq.com", "imap.163.com": "smtp.163.com", "imap.gmail.com": "smtp.gmail.com" };
  const server = (await ctx.api.getSecret("smtpServer") || preset[settings.host] || "").trim();
  if (!server) throw imap.failure("MAIL_SMTP_MISSING", "请在实例的邮箱设置中填写 SMTP 服务器。");
  const starttls = server.startsWith("starttls://");
  const { host, port } = imap.endpoint(server.replace(/^starttls:\/\//, ""), "SMTP", starttls ? 587 : 465);
  const transport = nodemailer.createTransport({ host, port, secure: !starttls && port !== 587, requireTLS: true,
    auth: { user: settings.user, pass: await ctx.api.getSecret("smtpPassword") || settings.pass },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" }, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true });
  return async options => {
    try {
      if (options.raw) {
        const { lines, body } = mail.splitRaw(options.raw);
        options = { messageId: options.messageId, envelope: { from: options.from, to: mail.targetList(options) },
          raw: Buffer.concat([Buffer.from(lines.filter(line => !/^bcc:/i.test(line)).join("\r\n") + "\r\n\r\n", "latin1"), body]) };
      }
      const result = await transport.sendMail(options);
      return { state: result.rejected?.length ? "partial" : "accepted", messageId: result.messageId, accepted: result.accepted, rejected: result.rejected || [] };
    } catch (e) {
      // Nodemailer may label a lost final DATA reply "CONN", even after the server stored the mail.
      const refused = e.responseCode >= 400 && /^(?:AUTH|MAIL|RCPT|DATA)\b/i.test(e.command || "");
      if (refused || e.code === "EDNS") {
        const code = e.responseCode || e.code;
        throw Object.assign(imap.failure("MAIL_SMTP_REJECTED", "SMTP 发信失败（" + code + "）。"), { definitelyRejected: true });
      }
      throw e;
    } finally { transport.close(); }
  };
}
async function original(account, input, id, fullRaw = false) {
  if (account.gmail) {
    if (!fullRaw) return gmail.message(account.gmail, id, "metadata");
    const m = await gmail.message(account.gmail, id, "raw");
    if (!m.raw) throw imap.failure("MAIL_RAW", "Gmail 未返回原始邮件。");
    const raw = Buffer.from(m.raw, "base64url");
    if (raw.length > mail.MAX_BYTES) throw imap.failure("MAIL_FILE_LIMIT", "原邮件有 " + raw.length + " 字节，本次上限 " + mail.MAX_BYTES + " 字节。");
    return raw;
  }
  return imap.withInbox(account.settings, async box => {
    if (fullRaw) return imapActions.download(box, id, undefined);
    const { envelope: e } = await imapActions.fetchItem(box, id, { envelope: true });
    const join = items => (items || []).map(i => i.address).filter(Boolean).join(", ");
    return { subject: e.subject, from: join(e.from), replyTo: join(e.replyTo), to: join(e.to), cc: join(e.cc), messageId: e.messageId, inReplyTo: e.inReplyTo };
  }, input.folder);
}
async function build(ctx, account, input, sourceId) {
  const changes = pick(input), extra = {};
  let threadId;
  if (["reply", "replyAll", "forward"].includes(input.mode)) {
    if (!sourceId) throw imap.failure("MAIL_SOURCE", "回复或转发需要指定原邮件。");
    const source = await original(account, input, sourceId);
    if (input.mode === "forward") {
      changes.subject ??= /^fw[d]?:/i.test(source.subject || "") ? source.subject : "Fwd: " + (source.subject || "");
      extra.attachments = [{ filename: "original.eml", contentType: "message/rfc822", content: await original(account, input, sourceId, true) }];
    } else {
      threadId = source.threadId;
      changes.subject ??= /^re:/i.test(source.subject || "") ? source.subject : "Re: " + (source.subject || "");
      const targets = mail.addresses(source.replyTo || source.from);
      changes.to ??= targets.length && targets.every(s => s.toLowerCase() === account.email.toLowerCase())
        ? mail.addresses(source.to) : targets;
      if (input.mode === "replyAll" && !changes.cc) {
        const skip = new Set([account.email, ...changes.to, ...(changes.bcc || [])].map(s => s.toLowerCase()));
        changes.cc = mail.addresses([source.to, source.cc].filter(Boolean).join(",")).filter(a => !skip.has(a.toLowerCase()));
      }
      // Copy only valid Message-ID tokens from untrusted source headers.
      const token = s => (String(s || "").match(/<[^<>\s\x00-\x1f\x7f]+>/g) || []).slice(-20);
      extra.headers = { inReplyTo: token(source.messageId).at(-1), references: [...new Set([...token(source.references || source.inReplyTo), ...token(source.messageId)])] };
    }
  }
  return { ...await mail.compose(ctx, changes, account.email, extra), threadId };
}
async function localDraft(ctx, scope, id) {
  const key = imap.hash([scope, id]);
  const row = (await mail.db(ctx, "drafts", { action: "get", key })).record;
  if (!row) throw imap.failure("MAIL_DRAFT_GONE", "这个聊天中没有指定的邮箱草稿。");
  return row;
}
async function drafts(ctx, a, input) {
  const { action } = input;
  if (a.gmail) {
    const api = a.gmail;
    if (action === "list") {
      const page = await api.call("drafts", { pageToken: input.cursor, maxResults: input.limit || 12 });
      return { drafts: await gmail.mapItems(page.drafts || [], async d => ({ id: d.id, message: await gmail.message(api, d.message.id, "metadata") })), nextCursor: page.nextPageToken || null };
    }
    const path = action === "create" ? "drafts" : "drafts/" + gmail.idPath(input.id);
    if (action === "get") {
      const d = await api.call(path, { format: "full" });
      return { id: d.id, message: gmail.contentOf(d.message) };
    }
    if (action === "discard") { await api.call(path, {}, "DELETE", undefined, "丢弃 Gmail 草稿"); return { discarded: true }; }
    await sender(a, input);
    let raw, threadId, classificationLabelValues = input.classificationLabelValues;
    if (action === "update") {
      const previous = await api.call(path, { format: "raw" });
      if (!previous.message?.raw) throw imap.failure("MAIL_RAW", "Gmail 未返回草稿原件。");
      raw = await mail.patchDraft(ctx, Buffer.from(previous.message.raw, "base64url"), input, a.email);
      threadId = previous.message.threadId;
      classificationLabelValues ??= previous.message.classificationLabelValues;
    } else ({ raw, threadId } = await build(ctx, a, input, input.sourceId));
    return api.call(path, { fields: "id,message(id,threadId)" }, action === "update" ? "PUT" : "POST",
      { message: { raw: raw.toString("base64url"), threadId, classificationLabelValues } }, "保存 Gmail 草稿");
  }
  if (action === "list") {
    const page = await mail.db(ctx, "drafts", { action: "query", where: { scope: a.scope }, limit: input.limit || 12, cursor: input.cursor });
    return { drafts: page.records.map(r => ({ id: r.value.id, subject: r.value.content.subject || "", to: r.value.content.to || [] })), nextCursor: page.nextCursor };
  }
  const id = action === "create" ? randomUUID() : input.id, row = action === "create" ? null : await localDraft(ctx, a.scope, id);
  if (action === "get") return { id, message: row.value.content };
  if (action === "update") {
    const receipt = (await mail.db(ctx, "submissions", { action: "get", key: imap.hash([a.scope, ["draft", id]]) })).record;
    if (receipt?.value.state === "accepted") throw imap.failure("MAIL_DRAFT_SENT", "这份草稿已提交发送。");
    if (receipt?.value.state === "submitting") throw imap.failure("MAIL_SEND_UNKNOWN", "上次提交尚无确定回执，请先在已发送邮件中核对。");
  }
  if (action === "discard") { await mail.db(ctx, "drafts", { action: "delete", key: row.key, expectedRevision: row.revision }); return { discarded: true }; }
  await sender(a, input);
  const content = { ...row?.value.content, ...pick(input), ...(action === "create" ? { mode: input.mode, sourceId: input.sourceId, folder: input.folder } : {}) };
  mail.headers(content, a.email);
  if (Buffer.byteLength(JSON.stringify(content)) > 100 * 1024) throw imap.failure("MAIL_DRAFT_LIMIT", "草稿超过本次保存上限 100 KiB。");
  await mail.db(ctx, "drafts", { action: "put", key: imap.hash([a.scope, id]), expectedRevision: row?.revision || 0, value: { scope: a.scope, id, content } });
  return { id, message: content };
}
async function send(ctx, a, input) {
  const origin = mail.sendKey(ctx, input);
  if (input.draftId && Object.keys(input).some(k => k !== "draftId"))
    throw imap.failure("MAIL_DRAFT_FIELDS", "发送已有草稿时只需草稿编号。要改变内容，请先更新草稿。");
  if (input.draftId && a.gmail) {
    const id = gmail.idPath(input.draftId);
    return mail.submit(ctx, a.scope, ["draft", id], async () => {
      const m = await a.gmail.call("drafts/send", { fields: "id,threadId" }, "POST", { id }, "发送 Gmail 草稿");
      if (!m.id) throw imap.failure("MAIL_SEND_RECEIPT", "Gmail 的发送回执缺少邮件编号。");
      return { state: "accepted", ...m };
    });
  }
  let row;
  if (input.draftId) {
    // A retained receipt makes a repeat send safe after the local draft has been removed.
    const key = imap.hash([a.scope, ["draft", input.draftId]]);
    const prior = (await mail.db(ctx, "submissions", { action: "get", key })).record;
    if (prior?.value.state === "accepted") {
      const key = imap.hash([a.scope, input.draftId]);
      const lingering = (await mail.db(ctx, "drafts", { action: "get", key })).record;
      if (lingering) await mail.db(ctx, "drafts", { action: "delete", key, expectedRevision: lingering.revision });
      return prior.value.result;
    }
    row = await localDraft(ctx, a.scope, input.draftId);
    input = row.value.content;
  }
  const ids = input.mode === "forward" ? [...new Set(input.sourceIds?.length ? input.sourceIds : [input.sourceId])] : [input.sourceId];
  await sender(a, input);
  if (row && ids.length !== 1) throw imap.failure("MAIL_DRAFT_FORWARD", "一个转发草稿只能对应一封原邮件。");
  const submitSmtp = a.gmail ? null : await smtp(ctx, a.settings);
  const results = [];
  for (const sourceId of ids) {
    try {
      const { options, raw, threadId } = await build(ctx, a, input, sourceId);
      mail.targetList(options);
      const intent = row ? ["draft", row.value.id] : [origin, sourceId || ""];
      const sent = await mail.submit(ctx, a.scope, intent, async () => {
        if (submitSmtp) return submitSmtp(options);
        const m = await a.gmail.call("messages/send", { fields: "id,threadId" }, "POST",
          { threadId, raw: raw.toString("base64url"), classificationLabelValues: input.classificationLabelValues }, "发送 Gmail 邮件");
        if (!m.id) throw imap.failure("MAIL_SEND_RECEIPT", "Gmail 的发送回执缺少邮件编号。");
        return { state: "accepted", ...m };
      });
      results.push({ sourceId, ...sent });
      if (row) await mail.db(ctx, "drafts", { action: "delete", key: row.key, expectedRevision: row.revision });
    } catch (e) {
      if (ids.length === 1) throw e;
      results.push({ sourceId, error: { code: e.code, message: e.message } });
    }
  }
  return ids.length === 1 ? results[0] : { results };
}
module.exports = { drafts, send };
