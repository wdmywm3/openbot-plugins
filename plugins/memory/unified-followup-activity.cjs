"use strict";
const { get, put } = require("./unified-state.cjs");
async function ensure(ctx, storage, scope, record) {
  if (!ctx.api.avatars || !ctx.api.activities) throw Error("持续复查需要新版宿主的分身和事项接口");
  const key = `plus:followup-link:${record.id}`;
  let link = get(storage, key);
  if (!link?.activityId) {
    link ||= put(storage, key, { chatId: scope.chatId, memoryId: record.id, title: String(record.content).slice(0, 100), goal: String(record.content).slice(0, 12000) });
    const { avatar } = await ctx.api.avatars({ action: "declare", chatId: scope.chatId, key: "memory-review", name: "事项复查", purpose: "按明确约定复查事项，只读资料，有值得通知的新进展时提交结果。" });
    const { activity } = await ctx.api.activities({ action: "create", chatId: scope.chatId, requestKey: `memory-review:${record.id}`, avatarId: avatar.id,
      title: link.title, goal: link.goal });
    link = put(storage, key, { avatarId: avatar.id, activityId: activity.id, chatId: scope.chatId, memoryId: record.id });
  }
  const { activity } = await ctx.api.activities({ action: "read", chatId: scope.chatId, id: link.activityId });
  if (activity.status === "canceled" || activity.recoveryRequired) return { ...link, paused: true, recoveryRequired: !!activity.recoveryRequired };
  const watched = record.attributes?.watchActivityId;
  if (watched === link.activityId) throw Error("复查事项不能订阅自身");
  const { subscriptions } = await ctx.api.activities({ action: "subscriptions", chatId: scope.chatId, id: link.activityId });
  for (const previous of subscriptions) if (previous.enabled && previous.kind === "activity" && previous.sourceId !== watched)
    await ctx.api.activities({ action: "unsubscribe", chatId: scope.chatId, id: link.activityId, subscriptionId: previous.id, expectedRevision: previous.revision });
  if (watched && typeof watched === "string" && watched !== link.activityId) {
    await ctx.api.activities({ action: "read", chatId: scope.chatId, id: watched });
    const existing = subscriptions.find(s => s.kind === "activity" && s.sourceId === watched);
    if (!existing?.enabled) await ctx.api.activities({ action: "subscribe", chatId: scope.chatId, id: link.activityId, kind: "activity", sourceId: watched,
      ...(existing ? { expectedRevision: existing.revision } : {}) });
  }
  await ctx.api.activities({ action: "append", chatId: scope.chatId, id: link.activityId, requestKey: `memory-version:${record.id}:${record.revision}`, contextOnly: true,
    text: JSON.stringify({ memory: { id: record.id, revision: record.revision }, currentGoal: record.content.slice(0, 12000) }) });
  return link;
}
async function changed(ctx, scope, record, saved) {
  const head = record.attributes?.reviewOnChange === true ? await ctx.api.sources({ action: "head", chatId: scope.chatId, direction: "in", eventType: "message" }) : null;
  let events = [], cursor = saved.activityCursor || 0;
  if (typeof record.attributes?.watchActivityId === "string") for (let page = 0; page < 4; page++) {
    const next = (await ctx.api.activities({ action: "history", chatId: scope.chatId, id: record.attributes.watchActivityId, after: cursor })).events || [];
    events.push(...next); cursor = next.at(-1)?.seq || cursor; if (next.length < 100) break;
  }
  const relevant = events.filter(event => ["execution_ended", "workflow_result", "canceled", "execution_interrupted", "reconciled", "recovery_required"].includes(event.kind));
  return { changed: !!(head?.latestSeq > (saved.sourceCursor || 0) && head.observedAt + 300000 <= Date.now()) || relevant.length > 0,
    sourceCursor: head?.latestSeq || saved.sourceCursor || 0, activityCursor: cursor,
    events: relevant.map(item => ({ seq: item.seq, kind: item.kind, at: item.at, status: item.status })) };
}
module.exports = { ensure, changed };
