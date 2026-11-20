"use strict";
const readline = require("node:readline");
const { createDriver } = require("./device-driver.cjs");
const call = createDriver(process.argv[2]);
const tool = { name: "bphone_device", description: "bPhone 设备操作", inputSchema: { type: "object", required: ["op"], properties: { op: { type: "string" } }, additionalProperties: true } };
const active = new Map();
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
readline.createInterface({ input: process.stdin }).on("line", async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "notifications/cancelled") { active.get(msg.params?.requestId)?.abort(); return; }
  if (msg.id == null) return;
  if (msg.method === "initialize") return send(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "bphone", version: "3.0.0" } });
  if (msg.method === "tools/list") return send(msg.id, { tools: [tool] });
  if (msg.method === "ping") return send(msg.id, {});
  if (msg.method !== "tools/call" || msg.params?.name !== tool.name) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "未知操作" } }) + "\n"); return;
  }
  const controller = new AbortController();
  try {
    if (active.size >= 4) throw Error("设备操作正在排队，请稍后重试");
    active.set(msg.id, controller);
    const result = await call(msg.params.arguments, AbortSignal.any([controller.signal,AbortSignal.timeout(55000)]));
    const content = [];
    if (result.screenshot) { content.push({ type: "image", mimeType: "image/png", data: result.screenshot.split(",")[1] }); delete result.screenshot; }
    if (result.image) { content.push({ type: "image", mimeType: result.mimeType, data: result.image }); delete result.image; }
    content.push({ type: "text", text: JSON.stringify(result) });
    send(msg.id, { content });
  } catch (error) { send(msg.id, { isError: true, content: [{ type: "text", text: JSON.stringify({ message:String(error.message).slice(0,500), code:error.code || "DEVICE_OPERATION_FAILED", beforeDispatch:error.beforeDispatch === true }) }] }); }
  finally { active.delete(msg.id); }
});
