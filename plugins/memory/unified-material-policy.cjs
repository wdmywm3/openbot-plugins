"use strict";
// Interpretation belongs to Plus; the host source stream preserves all events.
function admit(item) {
  if (item.deleted || item.routeBlocked || item.memoryExcluded || !item.content?.trim()) return false;
  if (item.source && item.source !== "chat" || item.event?.type && item.event.type !== "message") return false;
  return item.direction !== "out" || !item.networkStatus || ["sent", "success", "delivered", "completed"].includes(item.networkStatus);
}
function factsAllowed(refs, materials) {
  return refs.every(ref => {
    const source = materials.find(item => item.id === ref.id);
    return source && admit(source) && source.direction === "in" && !source.sender?.isBot;
  });
}
module.exports = { admit, factsAllowed };
