"use strict";

const { createInterface } = require("node:readline");
const handlers = require("./mailbox.cjs").handlers();
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const pending = new Map();
let serial = 0;

createInterface({ input: process.stdin }).on("line", async line => {
  const message = JSON.parse(line);
  if (message.type === "api-result") {
    const call = pending.get(message.id);
    if (!call || call.runId !== message.runId) return;
    pending.delete(message.id);
    if (message.ok) call.resolve(message.result);
    else call.reject(Object.assign(new Error(message.error.message), message.error));
    return;
  }
  if (message.type !== "run") return;
  const { runId } = message;
  const api = Object.fromEntries(message.apiMethods.map(method => [method, (...args) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { runId, resolve, reject });
    send({ type: "api", runId, id, method, args });
  })]));
  try {
    if (!Object.hasOwn(handlers, message.exportName)) throw new Error("邮箱操作不存在。");
    const result = await handlers[message.exportName]({ ...message.context, dataRoot: message.dataRoot, api });
    send({ type: "result", runId, result: result ?? null });
  } catch (error) {
    const { code, status, retryAfter, retryable, runtimeIncidentId, details } = error;
    send({ type: "error", runId, error: { message: error.message, code, status, retryAfter, retryable, runtimeIncidentId,
      ...(details ? { details: { upstreamCode: details.upstreamCode, upstreamParam: details.upstreamParam } } : {}) } });
  }
});
