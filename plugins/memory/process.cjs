"use strict";
const readline = require("node:readline"), fs = require("node:fs"), path = require("node:path");
const handlers = require("./unified-runtime.cjs");
const runs = new Map(); let serial = 0;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
readline.createInterface({ input: process.stdin }).on("line", async line => {
  let message;
  try { message = JSON.parse(line); } catch { process.exitCode = 1; return; }
  if (message.type === "cancel") {
    const job = runs.get(message.runId); if (!job) return;
    const error = Object.assign(new Error(message.error?.message || "调用已取消"), message.error);
    job.controller.abort(error);
    for (const call of job.pending.values()) call.reject(error);
    job.pending.clear(); return;
  }
  if (message.type === "api-result") {
    const job = runs.get(message.runId), call = job?.pending.get(message.id); if (!call) return;
    job.pending.delete(message.id); message.ok ? call.resolve(message.result) : call.reject(Object.assign(new Error(message.error?.message || String(message.error)), message.error)); return;
  }
  if (message.type !== "run") return;
  const job = { pending: new Map(), controller: new AbortController() }; runs.set(message.runId, job);
  try {
    if (!path.isAbsolute(message.dataRoot)) throw Error("缺少插件数据目录");
    fs.mkdirSync(message.dataRoot, { recursive: true });
    const api = Object.fromEntries(message.apiMethods.map(method => [method, (...args) => new Promise((resolve, reject) => {
      if (job.controller.signal.aborted) return reject(job.controller.signal.reason);
      if (!runs.has(message.runId)) return reject(Error("调用已结束"));
      const id = ++serial; job.pending.set(id, { resolve, reject }); send({ type: "api", runId: message.runId, id, method, args });
    })]));
    const ctx = { ...message.context, api, dataRoot: message.dataRoot, signal: job.controller.signal };
    if (typeof handlers[message.exportName] !== "function") throw Error("插件入口不存在");
    if (message.exportName !== "stopping") await handlers.initialize(ctx);
    ctx.signal.throwIfAborted();
    const result = await handlers[message.exportName](ctx);
    send({ type: "result", runId: message.runId, result });
  } catch (error) { send({ type: "error", runId: message.runId, error: { message: String(error.message || error), code: error.code } }); }
  finally { runs.delete(message.runId); for (const call of job.pending.values()) call.reject(Error("调用已结束")); }
});
