"use strict";

const assert = require("node:assert/strict");
const enc = s => Buffer.from(s).toString("base64url");
const response = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });

function googleFixture() {
  const labels = [{ id: "INBOX", name: "INBOX" }, { id: "UNREAD", name: "UNREAD" }, { id: "STARRED", name: "STARRED" }];
  const messages = new Map(), drafts = new Map(), sent = [], changes = [];
  let seq = 0, history = 20;
  const add = (id, threadId, subject, text) => {
    const headers = Object.entries({ From: "School <office@example.test>", "Reply-To": "admissions@example.test",
      To: "owner@example.test", Cc: "team@example.test", Subject: subject, "Message-ID": "<" + id + "@example.test>" }).map(([name, value]) => ({ name, value }));
    messages.set(id, { id, threadId, internalDate: "1700000000000", snippet: text, labelIds: ["INBOX", "UNREAD"], payload: {
      mimeType: "multipart/mixed", headers, parts: [
        { mimeType: "text/plain", partId: "0", body: { data: enc(text), size: Buffer.byteLength(text) } },
        { mimeType: "text/plain", partId: "1", filename: "材料.txt", body: { attachmentId: "file-" + id, size: 4 } }
      ] }, raw: enc("From: office@example.test\r\nSubject: Original\r\n\r\n" + text) });
    changes.push({ id: String(++history), messagesAdded: [{ message: { id } }] });
  };
  add("a1", "c1", "School", "第一封"); add("a2", "c1", "School", "第二封");
  const copy = (id, format) => {
    const m = messages.get(id);
    if (!m) return;
    if (format === "raw") return { id, threadId: m.threadId, raw: m.raw };
    if (format === "minimal") return { id, threadId: m.threadId, labelIds: m.labelIds };
    return { id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, snippet: m.snippet,
      payload: format === "metadata" ? { headers: m.payload.headers } : m.payload };
  };
  const api = { labels, messages, drafts, sent, add, calls: [], loseReceipt: false, onePerPage: false, rejectSend: false, expired: false };
  api.fetch = async (target, options) => {
    const url = new URL(target);
    if (url.hostname === "oauth2.googleapis.com") {
      assert.equal(url.pathname, "/token");
      assert.equal(new URLSearchParams(options.body).get("refresh_token"), "test-refresh");
      return response({ access_token: "test-access" });
    }
    assert.equal(url.hostname, "gmail.googleapis.com");
    assert.equal(options.headers.authorization, "Bearer test-access");
    if (url.pathname === "/batch/gmail/v1") {
      const matches = [...options.body.matchAll(/Content-ID: <item(\d+)>\r\n\r\nGET (\S+) HTTP\/1.1/g)];
      assert(matches.length > 1);
      const parts = await Promise.all(matches.reverse().map(async ([, i, resource]) => {
        const r = await api.fetch(new URL(resource, url), { method: "GET", headers: options.headers });
        return "--batch_fixture\r\nContent-Type: application/http\r\nContent-ID: <response-item" + i + ">\r\n\r\nHTTP/1.1 " +
          r.status + " Test\r\nContent-Type: application/json\r\n\r\n" + await r.text() + "\r\n";
      }));
      return new Response(parts.join("") + "--batch_fixture--\r\n", { headers: { "content-type": "multipart/mixed; boundary=batch_fixture" } });
    }
    const resource = url.pathname.replace(/^\/gmail\/v1\/users\/me\//, ""), [kind, id, verb] = resource.split("/");
    const q = url.searchParams, data = options.body ? JSON.parse(options.body) : {}, method = options.method;
    api.calls.push({ resource, method, q: Object.fromEntries(q) });
    if (resource === "profile") return response({ emailAddress: "owner@example.test", messagesTotal: messages.size, threadsTotal: 1, historyId: String(history) });
    if (resource === "history") return api.expired ? response({}, 404) : response({ historyId: String(history), history: changes.filter(c => +c.id > +q.get("startHistoryId")) });
    if (kind === "labels") {
      if (method === "POST") { const label = { id: "Label_" + ++seq, name: data.name }; labels.push(label); return response(label); }
      return response(id ? { ...labels.find(l => l.id === id), messagesTotal: 2, messagesUnread: 1 } : { labels });
    }
    if (kind === "threads") {
      const items = [...messages.values()].filter(m => m.threadId === id);
      if (verb === "modify") { items.forEach(m => m.labelIds = m.labelIds.filter(l => !data.removeLabelIds.includes(l))); return response({ id }); }
      return response({ id, messages: items.map(m => copy(m.id, q.get("format"))) });
    }
    if (resource === "messages/batchModify") {
      for (const key of data.ids) {
        const m = messages.get(key);
        m.labelIds = [...new Set([...m.labelIds, ...(data.addLabelIds || [])])].filter(l => !data.removeLabelIds?.includes(l));
      }
      return response(null, 204);
    }
    if (resource === "messages/send" || resource === "drafts/send") {
      if (api.rejectSend) return response({ error: { status: "PERMISSION_DENIED" } }, 403);
      const raw = data.raw || drafts.get(data.id)?.message.raw;
      assert(raw);
      const item = { id: "s" + ++seq, threadId: data.threadId || "sent-thread", raw };
      sent.push(item); if (data.id) drafts.delete(data.id);
      if (api.loseReceipt) { api.loseReceipt = false; throw Error("fixture disconnected after acceptance"); }
      return response({ id: item.id, threadId: item.threadId });
    }
    if (kind === "messages") {
      if (!id) {
        const offset = Number(q.get("pageToken") || 0), count = api.onePerPage ? 1 : Number(q.get("maxResults") || 12);
        const all = [...messages.values()], items = all.slice(offset, offset + count);
        return response({ messages: items.map(m => ({ id: m.id, threadId: m.threadId })), nextPageToken: offset + count < all.length ? String(offset + count) : undefined });
      }
      if (verb === "attachments") return response({ data: enc("file"), size: 4 });
      const m = messages.get(id);
      if (!m) return response({}, 404);
      if (verb === "trash") m.labelIds = ["TRASH"];
      if (verb === "untrash") m.labelIds = ["INBOX"];
      return response(copy(id, q.get("format")));
    }
    if (kind === "drafts") {
      if (method === "DELETE") { messages.delete(drafts.get(id)?.message.id); drafts.delete(id); return response(null, 204); }
      if (["POST", "PUT"].includes(method)) {
        const key = id || "r-" + ++seq, msg = "d" + ++seq;
        const d = { id: key, message: { id: msg, threadId: data.message.threadId || "draft-thread", raw: data.message.raw } };
        messages.set(msg, { ...d.message, payload: { headers: [], mimeType: "text/plain", body: { data: enc("draft") } }, labelIds: ["DRAFT"] });
        drafts.set(key, d); return response({ id: key, message: { id: msg, threadId: d.message.threadId } });
      }
      if (!id) return response({ drafts: [...drafts.values()] });
      const d = drafts.get(id);
      return d ? response(q.get("format") === "raw" ? d : { id, message: copy(d.message.id, "full") }) : response({}, 404);
    }
    throw Error("Unexpected mock Google request " + method + " " + resource);
  };
  return api;
}
module.exports = { googleFixture };
