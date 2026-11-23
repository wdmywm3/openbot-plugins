"use strict";

const { randomUUID } = require("node:crypto");
const gmail = require("./gmail.cjs");
const { db, scopeKey } = require("./compose.cjs");
const { failure, hash } = require("./imap.cjs");
const validName = value => {
  if (typeof value !== "string" || !value.trim() || value.length > 225 || /[\r\n\0]/.test(value))
    throw failure("MAIL_LABEL_NAME", "请填写有效的标签名称。");
  return value.trim();
};
async function label(api, name, labels, create) {
  const requested = validName(name);
  const find = items => items.find(l => l.name === requested || l.id === requested);
  const existing = find(labels);
  if (existing) return existing;
  if (!create) throw failure("MAIL_LABEL_GONE", "邮箱中没有指定的标签。");
  try {
    const created = await api.call("labels", {}, "POST", { name: requested }, "创建标签");
    labels.push(created);
    return created;
  } catch (e) {
    if (e.status === 409) {
      const concurrent = find((await api.call("labels")).labels);
      if (concurrent) return concurrent;
    }
    throw e;
  }
}
async function folders(api, input) {
  const labels = (await api.call("labels")).labels || [];
  if (input.action === "create") return label(api, input.name, labels, true);
  const selected = input.name ? [await label(api, input.name, labels, false)] : labels;
  const offset = Number(input.cursor || 0), limit = input.limit || 20;
  if (!Number.isSafeInteger(offset) || offset < 0) throw failure("MAIL_CURSOR", "标签列表游标无效。");
  const rows = selected.slice(offset, offset + limit);
  return { labels: await api.batchGet(rows.map(l => ["labels/" + gmail.idPath(l.id)])),
    nextCursor: offset + limit < selected.length ? String(offset + limit) : null };
}
async function labelChanges(api, input) {
  const labels = (await api.call("labels")).labels || [];
  const resolve = async (names, create) => {
    const ids = [];
    for (const name of new Set(names || [])) ids.push((await label(api, name, labels, create)).id);
    return ids;
  };
  const addLabelIds = await resolve(input.add, input.createMissing === true), removeLabelIds = await resolve(input.remove, false);
  if (!addLabelIds.length && !removeLabelIds.length) throw failure("MAIL_LABEL_REQUIRED", "请指定要添加或移除的标签。");
  if (addLabelIds.some(id => removeLabelIds.includes(id))) throw failure("MAIL_LABEL_CONFLICT", "同一标签同时出现在添加和移除列表中。");
  return { addLabelIds, removeLabelIds };
}
async function bulk(ctx, api, caps, input) {
  const scope = scopeKey(ctx, caps, api.profile.emailAddress);
  const id = input.operationId || randomUUID(), location = { key: hash([scope, id]) };
  let row = (await db(ctx, "labelRuns", { ...location, action: "get" })).record;
  if (!row) {
    if (input.operationId) throw failure("MAIL_OPERATION_GONE", "本聊天没有这次标签操作。");
    if (!input.query?.trim()) throw failure("MAIL_QUERY_REQUIRED", "请填写要批量整理的 Gmail 搜索条件。");
    const change = await labelChanges(api, input);
    row = (await db(ctx, "labelRuns", { ...location, action: "put", expectedRevision: 0,
      value: { query: input.query, change, pages: 0, next: 0, total: 0, processed: 0, phase: "search" } })).record;
  }
  const v = row.value;
  // Finish enumerating before mutation, as adding a label may remove a message from the search.
  if (v.phase === "search") {
    const page = await api.call("messages", { q: v.query, pageToken: v.cursor, maxResults: 500 });
    const ids = (page.messages || []).map(m => m.id);
    const updated = { ...v, pages: v.pages + 1, total: v.total + ids.length, cursor: page.nextPageToken || null,
      phase: page.nextPageToken ? "search" : "apply" };
    await db(ctx, "labelRuns", { action: "batch", operations: [
      { collection: "labelPages", key: hash([scope, id, v.pages]), action: "put", expectedRevision: 0, value: { ids } },
      { collection: "labelRuns", ...location, action: "put", expectedRevision: row.revision, value: updated }
    ] });
    if (updated.phase === "search") return { operationId: id, phase: "search", matched: updated.total, more: true };
    row = (await db(ctx, "labelRuns", { ...location, action: "get" })).record;
  }
  const work = row.value;
  if (work.next < work.pages) {
    const page = (await db(ctx, "labelPages", { action: "get", key: hash([scope, id, work.next]) })).record;
    if (page.value.ids.length) await api.call("messages/batchModify", {}, "POST", { ids: page.value.ids, ...work.change }, "批量修改标签");
    work.processed += page.value.ids.length; work.next++;
    await db(ctx, "labelRuns", { ...location, action: "put", expectedRevision: row.revision, value: work });
  }
  return { operationId: id, processed: work.processed, matched: work.total, more: work.next < work.pages };
}
async function modify(ctx, api, caps, input) {
  if (input.action === "bulkLabels") {
    const scope = scopeKey(ctx, caps, api.profile.emailAddress);
    let progress;
    if (input.operationId) {
      const key = hash([scope, input.operationId]);
      const row = (await db(ctx, "labelRuns", { key, action: "get" })).record;
      if (!row) throw failure("MAIL_OPERATION_GONE", "本聊天没有这次标签操作。");
      progress = { operationId: input.operationId, matched: row.value.total, processed: row.value.processed,
        more: row.value.phase === "search" || row.value.next < row.value.pages };
    } else progress = await bulk(ctx, api, caps, input);
    if (!progress.more) return progress;
    const job = await ctx.api.jobs({ action: "start", actionId: "apply-gmail-labels", requestKey: "labels:" + progress.operationId,
      input: { operationId: progress.operationId, scope } });
    if (["failed","paused","interrupted"].includes(job.status)) await ctx.api.jobs({ action: "resume", id: job.id });
    return { ...progress, jobId: job.id, status: job.status };
  }
  const ids = [...new Set(input.ids || [])];
  ids.forEach(gmail.idPath);
  if (input.action === "archive") {
    const threads = [...new Set([...(input.threadIds || []), ...(await gmail.mapItems(ids, id => gmail.message(api, id, "minimal"))).map(m => m.threadId)])];
    if (!threads.length) throw failure("MAIL_THREAD", "请指定要归档的邮件或会话。");
    for (const id of threads) await api.call("threads/" + gmail.idPath(id) + "/modify", { fields: "id" }, "POST", { removeLabelIds: ["INBOX"] }, "归档邮件会话");
    return { archivedThreadIds: threads };
  }
  if (!ids.length) throw failure("MAIL_ID_REQUIRED", "请指定要整理的邮件。");
  if (["trash", "restore"].includes(input.action)) {
    for (const id of ids) await api.call("messages/" + gmail.idPath(id) + (input.action === "trash" ? "/trash" : "/untrash"), { fields: "id" }, "POST", {}, "更新邮件垃圾箱状态");
  } else {
    const flags = { read: { removeLabelIds: ["UNREAD"] }, unread: { addLabelIds: ["UNREAD"] },
      star: { addLabelIds: ["STARRED"] }, unstar: { removeLabelIds: ["STARRED"] } };
    const change = input.action === "labels" ? await labelChanges(api, input) : flags[input.action];
    if (!change) throw failure("MAIL_GMAIL_MOVE", "Gmail 请使用添加或移除标签来整理邮件。");
    await api.call("messages/batchModify", {}, "POST", { ids, ...change }, "更新邮件标签");
  }
  return { modifiedIds: ids };
}
async function runBulk(ctx, api, caps) {
  if (!caps.conversationBinding?.privateOwner || ctx.input.scope !== scopeKey(ctx, caps, api.profile.emailAddress))
    throw failure("MAIL_ACCOUNT_CHANGED", "邮箱或原私聊绑定已更改。");
  let progress;
  for (let slice = 0; slice < 3; slice++) {
    progress = await bulk(ctx, api, caps, ctx.input);
    if (!progress.more) return progress;
  }
  await ctx.api.jobs({ action: "yield", checkpoint: { operationId: ctx.input.operationId }, progress });
  return progress;
}
module.exports = { folders, modify, runBulk };
