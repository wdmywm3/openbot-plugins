"use strict";
// Interpretation belongs to Plus; the host source stream preserves all events.
function admit(item) {
  if (item.deleted || item.routeBlocked || item.memoryExcluded || !item.content?.trim()) return false;
  return item.direction !== "out" || !item.networkStatus || ["sent", "success", "delivered", "completed"].includes(item.networkStatus);
}
function factsAllowed(refs, materials) {
  return refs.every(ref => {
    const source = materials.find(item => item.id === ref.id);
    return source && admit(source) && source.source !== "task_report" && (!source.event?.type || source.event.type === "message");
  });
}
module.exports = { admit, factsAllowed };
