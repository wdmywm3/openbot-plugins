"use strict";
const KEYS = ["nextReviewAt", "reviewIntervalMinutes", "reviewOnChange", "watchActivityId"];
const terminal = progress => ["completed", "canceled", "closed"].includes(progress);
const changed = input => KEYS.some(key => Object.hasOwn(input, key));
function attributes(input, previous = {}) {
  const value = { ...previous };
  for (const key of KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const next = input[key];
    if (key === "nextReviewAt" && next != null && (!Number.isSafeInteger(next) || next < 0 || !Number.isFinite(new Date(next).getTime()))) throw Error("复查时间无效");
    if (key === "reviewIntervalMinutes" && next != null && next !== 0 && (!Number.isInteger(next) || next < 5 || next > 43200)) throw Error("重复复查须为 5 到 43200 分钟");
    if (key === "reviewOnChange" && typeof next !== "boolean") throw Error("按新资料复查需要布尔值");
    if (key === "watchActivityId" && next != null && (typeof next !== "string" || next.length > 200 || next && !next.trim())) throw Error("订阅事项编号无效");
    if (next === null || next === 0 || next === "" || next === false) delete value[key]; else value[key] = next;
  }
  if (terminal(input.progress) || Object.hasOwn(input, "nextReviewAt") && !input.nextReviewAt) for (const key of KEYS) delete value[key];
  return value;
}
function peerEvidence(refs, materials, scope) {
  const peerId = scope?.chatId?.split(":private:")[1];
  return refs.length > 0 && refs.every(ref => {
    const item = materials.find(value => value.id === ref.id && (!ref.version || value.version === ref.version));
    return item && item.direction === "in" && !item.sender?.isBot && item.source !== "task_report"
      && (!item.event?.type || item.event.type === "message")
      && (!peerId || (item.sender?.id || item.senderId) === peerId);
  });
}
module.exports = { KEYS, changed, attributes, terminal, peerEvidence };
