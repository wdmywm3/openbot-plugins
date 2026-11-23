"use strict";
// Interpretation belongs to Plus; the host source stream preserves all events.
const message = item => !item.deleted && !item.routeBlocked && !item.memoryExcluded && !!item.content?.trim()
  && (!item.event?.type || item.event.type === "message");
const delivered = item => message(item) && item.direction === "out" && !["tool_result", "task_report"].includes(item.source)
  && ["sent", "ok", "success", "delivered", "completed"].includes(item.networkStatus);
function admit(item) {
  if (!message(item) || item.source && item.source !== "chat") return false;
  return item.direction !== "out" || !item.networkStatus || ["sent", "success", "delivered", "completed"].includes(item.networkStatus);
}
const human = item => item.direction === "in" && !item.sender?.isBot && admit(item);
function factsAllowed(refs, materials) {
  return refs.every(ref => {
    const source = materials.find(item => item.id === ref.id);
    return source && human(source);
  });
}
module.exports = { admit, factsAllowed, delivered, human };
