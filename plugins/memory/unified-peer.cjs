"use strict";
const { get, put } = require("./unified-state.cjs");
const { isPrivateDreamScope } = require("./lib/features/channels/channel-dream-settings.cjs");
function observe(ctx, storage, scope) {
  const principal = ctx.principal || {};
  // A desktop operator or lifecycle job's authority says nothing about the peer.
  if (!isPrivateDreamScope(scope) || principal.source !== "channel" || principal.chatId !== scope.chatId
    || !principal.senderId || !["owner", "member"].includes(principal.role)) return;
  put(storage, `plus:peer:${scope.chatId}`, { id: String(principal.senderId), relationship: principal.role, observedAt: Date.now() });
}
function context(ctx, storage, scope) {
  observe(ctx, storage, scope);
  if (!isPrivateDreamScope(scope)) return { chatType: "group" };
  const peer = get(storage, `plus:peer:${scope.chatId}`);
  return { chatType: "private", peerId: peer?.id || scope.chatId.split(":private:").at(-1),
    relationship: peer?.relationship || "unknown", relationshipObservedAt: peer?.observedAt || null };
}
module.exports = { observe, context };
