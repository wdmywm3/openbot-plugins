"use strict";

const { convert } = require("html-to-text");
const { randomUUID } = require("node:crypto");
const { failure, hash, filters } = require("./imap.cjs");
const { MAX_BYTES, saveFile } = require("./compose.cjs");

const ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_RESPONSE = 16 * 1024 * 1024;
let cachedToken;
const idPath = id => {
  if (typeof id !== "string" || !id || id.length > 5000 || !/^[A-Za-z0-9_=-]+$/.test(id)) throw failure("MAIL_ID_INVALID", "Gmail 对象编号无效。");
  return encodeURIComponent(id);
};
function httpError(operation, status, body) {
  const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || body?.error;
  const upstreamCode = typeof reason === "string" && /^[a-z][a-z0-9_]{0,79}$/i.test(reason) ? reason : undefined;
  const suffix = upstreamCode ? "，错误码 " + upstreamCode : "";
  return Object.assign(failure("MAIL_GOOGLE_" + status, operation + "失败（HTTP " + status + suffix + "）。"),
    { status, definitelyRejected: status >= 400 && status < 500 && status !== 408, ...(upstreamCode ? { details: { upstreamCode } } : {}) });
}
async function connect(ctx) {
  const secret = await ctx.api.getSecret("gmailOAuth");
  if (!secret) throw failure("MAIL_GOOGLE_AUTH", "请在实例设置中填写 Gmail 授权凭据。");
  let auth;
  try { auth = JSON.parse(secret); } catch { throw failure("MAIL_GOOGLE_AUTH", "Gmail 授权凭据不是有效的 JSON。"); }
  if (!auth?.client_id || !auth.client_secret || !auth.refresh_token)
    throw failure("MAIL_GOOGLE_AUTH", "Gmail 授权凭据缺少客户端编号、客户端密钥或刷新令牌。");
  const credentialKey = hash(secret);
  if (cachedToken?.key !== credentialKey || cachedToken.expires <= Date.now()) cachedToken = null;
  if (!cachedToken) {
    const token = await ctx.api.request("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" }, responseType: "text",
    body: new URLSearchParams({ client_id: auth.client_id, client_secret: auth.client_secret, refresh_token: auth.refresh_token, grant_type: "refresh_token" }).toString() });
    let payload;
    try { payload = JSON.parse(token.body); } catch { /* HTTP status remains authoritative. */ }
    if (!token.ok) throw httpError("刷新 Google 登录", token.status, payload);
    if (!payload?.access_token) throw failure("MAIL_GOOGLE_TOKEN", "Google 登录响应缺少访问令牌。");
    cachedToken = { key: credentialKey, token: payload.access_token, expires: Date.now() + Math.max(0, Math.min(3600, Number(payload.expires_in) || 0) - 60) * 1000 };
  }
  const authorization = "Bearer " + cachedToken.token;
  function urlFor(resource, query = {}) {
    const url = new URL(ROOT + "/" + resource);
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === "") continue;
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
    }
    return url;
  }
  async function call(resource, query = {}, method = "GET", data, operation = "Gmail 请求") {
    const url = urlFor(resource, query);
    const options = { method, redirect: "error", timeoutMs: 20000,
      headers: { authorization, ...(data !== undefined ? { "content-type": "application/json" } : {}) },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}) };
    if (method !== "GET") {
      const response = await ctx.api.request(url.href, { ...options, responseType: "text" });
      if (response.status === 401) cachedToken = null;
      let parsed;
      try { parsed = response.body ? JSON.parse(response.body) : {}; }
      catch { if (response.ok) throw failure("MAIL_GOOGLE_RESPONSE", "Gmail 返回的内容不是有效的 JSON。"); }
      if (!response.ok) throw httpError(operation, response.status, parsed);
      return parsed;
    }
    const response = await ctx.api.openStream(url.href, { ...options, encoding: "base64" });
    if (response.status === 401) cachedToken = null;
    const raw = await streamText(response);
    let result;
    try { result = raw ? JSON.parse(raw) : {}; }
    catch { if (response.ok) throw failure("MAIL_GOOGLE_RESPONSE", "Gmail 返回的内容不是有效的 JSON。"); }
    if (!response.ok) throw httpError(operation, response.status, result);
    return result;
  }
  async function streamText(response) {
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const part = await ctx.api.readStream({ id: response.id, maxBytes: 256 * 1024 });
        if (part.data) {
          const bytes = Buffer.from(part.data, "base64");
          size += bytes.length;
          if (size > MAX_RESPONSE) throw failure("MAIL_RESPONSE_LIMIT", "Gmail 响应已超过 " + MAX_RESPONSE + " 字节。");
          chunks.push(bytes);
        }
        if (part.done) break;
      }
    } finally { await ctx.api.closeStream({ id: response.id }).catch(() => {}); }
    return Buffer.concat(chunks).toString("utf8");
  }
  async function batchGet(requests, project = x => x) {
    const result = [];
    for (let start = 0; start < requests.length; start += 20) {
      const group = requests.slice(start, start + 20);
      if (group.length === 1) { result.push(project(await call(...group[0]))); bounded(result); continue; }
      const boundary = "openbot_" + randomUUID();
      const parts = group.map(([resource, query], i) => {
        const url = urlFor(resource, query);
        return "--" + boundary + "\r\nContent-Type: application/http\r\nContent-ID: <item" + i + ">\r\n\r\nGET " + url.pathname + url.search + " HTTP/1.1\r\n\r\n";
      });
      const response = await ctx.api.openStream("https://gmail.googleapis.com/batch/gmail/v1", { method: "POST", redirect: "error",
        encoding: "base64", timeoutMs: 30000, headers: { authorization,
          "content-type": "multipart/mixed; boundary=" + boundary }, body: parts.join("\r\n") + "\r\n--" + boundary + "--\r\n" });
      const raw = await streamText(response);
      if (!response.ok) throw httpError("批量读取 Gmail", response.status);
      const separator = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(response.headers["content-type"] || "");
      if (!separator) throw failure("MAIL_BATCH_RESPONSE", "Gmail 批量回执缺少 MIME 边界。");
      const entries = new Map();
      for (const part of raw.split("--" + (separator[1] || separator[2])).slice(1, -1)) {
        const match = /^\r?\n([\s\S]*?)\r?\n\r?\nHTTP\/1\.[01] (\d{3})[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*)$/.exec(part);
        const index = match && /(?:^|\n)Content-ID:\s*<(?:response-)?item(\d+)>/i.exec(match[1]);
        if (!index || +index[1] >= group.length || entries.has(+index[1])) throw failure("MAIL_BATCH_RESPONSE", "Gmail 的批量回执编号无效。");
        const item = JSON.parse(match[3].trim() || "{}");
        if (+match[2] >= 300) throw httpError("读取 Gmail 批次中的项目", +match[2], item);
        entries.set(+index[1], project(item));
      }
      if (entries.size !== group.length) throw failure("MAIL_BATCH_RESPONSE", "Gmail 的批量回执缺少请求的项目。");
      result.push(...group.map((_, i) => entries.get(i)));
      bounded(result);
    }
    return result;
  }
  const profile = await call("profile", {}, "GET", undefined, "读取 Gmail 账号");
  if (!profile.emailAddress || !/^\d+$/.test(profile.historyId)) throw failure("MAIL_GOOGLE_PROFILE", "Google 未返回有效的邮箱身份。");
  if (!ctx.config.username?.trim()) throw failure("MAIL_ACCOUNT_MISSING", "请在本实例的邮箱设置中填写邮箱账号。");
  if (profile.emailAddress.toLowerCase() !== ctx.config.username.trim().toLowerCase())
    throw failure("MAIL_GOOGLE_ACCOUNT", "Google 授权账号与实例设置的邮箱账号不一致。");
  return { call, batchGet, profile, accountKey: hash(["gmail", profile.emailAddress.toLowerCase()]) };
}

async function mapItems(items, fn) {
  const result = [];
  for (let i = 0; i < items.length; i += 3) result.push(...await Promise.all(items.slice(i, i + 3).map(fn)));
  return result;
}
const fields = ["From", "Reply-To", "To", "Cc", "Bcc", "Subject", "Date", "Message-ID", "References", "In-Reply-To"];
const h = (headers, name) => (headers || []).filter(item => item.name.toLowerCase() === name.toLowerCase()).map(item => item.value).join(", ");
function summary(message) {
  const headers = message.payload?.headers;
  return { id: message.id, threadId: message.threadId, labelIds: message.labelIds || [], subject: h(headers, "Subject"),
    from: h(headers, "From"), to: h(headers, "To"), cc: h(headers, "Cc"), bcc: h(headers, "Bcc"),
    replyTo: h(headers, "Reply-To"), messageId: h(headers, "Message-ID"), references: h(headers, "References"),
    inReplyTo: h(headers, "In-Reply-To"), receivedAt: Number(message.internalDate) ? new Date(Number(message.internalDate)).toISOString() : null,
    snippet: message.snippet || "", historyId: message.historyId, sizeEstimate: message.sizeEstimate, classificationLabelValues: message.classificationLabelValues };
}
function contentOf(message) {
  const attachments = [], plain = [], html = [];
  let remaining = 32000, truncated = false;
  function part(node) {
    const body = node.body || {}, mimeType = node.mimeType || "", partId = node.partId ?? "";
    const out = { partId, mimeType, bytes: body.size || 0,
      ...(h(node.headers, "Content-ID") ? { contentId: h(node.headers, "Content-ID") } : {}),
      ...(h(node.headers, "Content-Disposition") ? { disposition: h(node.headers, "Content-Disposition") } : {}) };
    if (node.filename || body.attachmentId || (!mimeType.startsWith("text/") && !mimeType.startsWith("multipart/"))) {
      const file = { ...out, filename: node.filename || "attachment", ...(body.attachmentId ? { attachmentId: body.attachmentId } : {}) };
      attachments.push(file);
      return !body.attachmentId && typeof body.data === "string" && body.data.length <= 8192 ? { ...file, base64UrlContent: body.data } : file;
    }
    if (Array.isArray(node.parts)) out.parts = node.parts.map(part);
    if (typeof body.data === "string") {
      const bytes = Buffer.from(body.data, "base64url");
      const charset = /charset\s*=\s*["']?([a-z0-9._-]+)/i.exec(h(node.headers, "Content-Type"))?.[1] || "utf-8";
      let text;
      try { text = new TextDecoder(charset).decode(bytes); } catch { text = bytes.toString("utf8"); }
      if (text.length > remaining) truncated = true;
      out.content = text.slice(0, remaining);
      remaining -= out.content.length;
      if (mimeType === "text/plain") plain.push(out.content);
      if (mimeType === "text/html") html.push(out.content);
    }
    return out;
  }
  const mime = part(message.payload || {});
  return { ...summary(message), headers: message.payload?.headers || [], mime, files: attachments,
    text: (plain.length ? plain : html.map(x => convert(x, { wordwrap: false }))).join("\n"), truncated };
}
async function message(api, id, format = "full") {
  const raw = await api.call("messages/" + idPath(id), { format, ...(format === "metadata" ? { metadataHeaders: fields } : {}) });
  if (format === "metadata") return summary(raw);
  if (format === "full") return contentOf(raw);
  return raw;
}
const messages = (api, ids, format = "full") => api.batchGet(ids.map(id => ["messages/" + idPath(id),
  { format, ...(format === "metadata" ? { metadataHeaders: fields } : {}) }]), format === "metadata" ? summary : format === "full" ? contentOf : x => x);
function bounded(result) {
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
    throw failure("MAIL_RESULT_LIMIT", "本批结果超过 1 MiB，请减少一次读取的邮件数量或选择 metadata 格式。");
  return result;
}
function listQuery(input) {
  const criteria = filters(input);
  const quoted = s => '"' + s.replace(/["\\]/g, " ").trim() + '"';
  return { q: [input.query, criteria.from && "from:" + quoted(criteria.from), criteria.subject && "subject:" + quoted(criteria.subject),
    input.unread != null && (input.unread ? "is:unread" : "is:read"), input.starred != null && (input.starred ? "is:starred" : "-is:starred")]
    .filter(Boolean).join(" "), labelIds: input.labelIds, includeSpamTrash: input.includeSpamTrash, pageToken: input.cursor, maxResults: input.limit || 12 };
}
async function search(api, input) {
  const page = await api.call("messages", listQuery(input)), ids = page.messages || [];
  return bounded({ messages: input.idsOnly ? ids : await messages(api, ids.map(m => m.id), "metadata"), nextCursor: page.nextPageToken || null });
}
async function threads(api, input) {
  const sources = input.messageIds?.length ? await messages(api, input.messageIds, "minimal") : null;
  const ids = [...new Set(sources ? sources.map(m => m.threadId) : input.threadIds || [])];
  if (!ids.length) throw failure("MAIL_THREAD", "请提供邮件编号或会话编号。");
  return { threads: await api.batchGet(ids.map(id => ["threads/" + idPath(id), { format: input.format || "full" }]), thread => {
    const list = thread.messages || [];
    return { threadId: thread.id, total: list.length, messages: list.slice(-(input.maxMessages || 20)).map(input.format === "metadata" ? summary : contentOf) };
  }) };
}
async function file(ctx, api, input) {
  const raw = await api.call("messages/" + idPath(input.id), { format: "full" });
  const matches = [];
  function walk(node) {
    if (!node) return;
    if (input.attachmentId ? node.body?.attachmentId === input.attachmentId : input.part != null ? String(node.partId ?? "") === input.part : !!input.filename && node.filename === input.filename) matches.push(node);
    for (const child of node.parts || []) walk(child);
  }
  walk(raw.payload);
  if (!matches.length) throw failure("MAIL_FILE_GONE", "这封邮件中没有指定的附件。");
  if (matches.length > 1) throw failure("MAIL_FILE_AMBIGUOUS", "邮件中有多个同名附件，请指定部件编号。");
  const node = matches[0];
  if (node.body.size > MAX_BYTES) throw failure("MAIL_FILE_LIMIT", "附件有 " + node.body.size + " 字节，本次上限 " + MAX_BYTES + " 字节。");
  const body = node.body.attachmentId ? await api.call("messages/" + idPath(input.id) + "/attachments/" + idPath(node.body.attachmentId)) : node.body;
  if (typeof body.data !== "string") throw failure("MAIL_FILE_GONE", "Gmail 未返回附件原件。");
  const bytes = Buffer.from(body.data, "base64url");
  if (Number.isSafeInteger(body.size) && bytes.length !== body.size) throw failure("MAIL_FILE_INCOMPLETE", "附件读取到 " + bytes.length + " 字节，Gmail 回执为 " + body.size + " 字节。");
  return saveFile(ctx, node.filename, bytes, node.mimeType);
}
async function changes(api, watch) {
  const base = watch.after;
  let list;
  try { list = await api.call("history", { startHistoryId: base.historyId, historyTypes: "messageAdded", maxResults: 8 }); }
  catch (e) { if (e.status === 404) return { reset: true }; throw e; }
  const found = [];
  let inspected = 0, after = base;
  for (const record of list.history || []) {
    const adds = record.messagesAdded || [];
    for (let i = record.id === base.recordId ? base.index : 0; i < adds.length; i++) {
      if (found.length >= 3 || inspected >= 12) return { after: { historyId: after.historyId, recordId: record.id, index: i }, messages: found };
      inspected++;
      let m;
      try { m = summary(await api.call("messages/" + idPath(adds[i].message.id), { format: "full", fields: "id,threadId,labelIds,internalDate,snippet,payload(headers)" })); }
      catch (e) { if (e.status === 404) continue; throw e; }
      if (m.labelIds.includes("INBOX") && Object.entries(watch.criteria).every(([k, v]) => m[k].toLowerCase().includes(v.toLowerCase())))
        found.push({ id: m.id, threadId: m.threadId, subject: m.subject.slice(0, 240), from: m.from.slice(0, 254), receivedAt: m.receivedAt, text: m.snippet.slice(0, 480) });
    }
    after = { historyId: record.id };
  }
  return { after: list.nextPageToken ? after : { historyId: list.historyId || after.historyId }, messages: found };
}
module.exports = { connect, idPath, mapItems, summary, contentOf, message, messages, search, threads, file, changes, bounded };
