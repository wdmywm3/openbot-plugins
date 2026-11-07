"use strict";
const api = window.openbotPlugin;
const byId = id => document.getElementById(id);
let current = null, busy = false, statusTimer;
function errorText(error) {
  const message = String(error?.message || error);
  if (/abort|cancel|timed?\s*out|timeout|超时|取消/i.test(message)) return message;
  return /unsupported image format|invalid image|corrupt|pngload|jpegload|webpload|vips|exceeds pixel limit|bad image header|premature end/i.test(message)
    ? "无法读取这张图片，请选择有效的 PNG、JPEG 或 WebP 图片" : message;
}
function render() {
  const hasImage = !!current?.assetRef;
  byId("choose").disabled = busy || !current;
  byId("clear").disabled = busy || !current;
  byId("clear").hidden = !hasImage;
  byId("choose-label").textContent = hasImage ? "更换形象" : "上传形象";
  byId("empty").hidden = !current || hasImage;
  byId("reference").hidden = !hasImage;
  if (hasImage) byId("reference").src = api.assetUrl(current.assetRef);
  else byId("reference").removeAttribute("src");
}
function notice(text) {
  clearTimeout(statusTimer); byId("status").textContent = text;
  statusTimer = setTimeout(() => { byId("status").textContent = ""; }, 2500);
}
async function refresh() {
  current = await api.callAction("selfie_reference", { action: "get" }); render();
}
async function change(operation) {
  if (busy || !current) return;
  busy = true; byId("error").hidden = true; byId("status").textContent = ""; render();
  try { await operation(); }
  catch (error) {
    byId("error").textContent = errorText(error); byId("error").hidden = false;
    try { await refresh(); } catch { /* Retain the last confirmed reference while showing the failure. */ }
  } finally { busy = false; render(); }
}
byId("choose").addEventListener("click", () => change(async () => {
  const revision = current.revision;
  const selected = await api.selectFiles({ extensions: ["png", "jpg", "jpeg", "webp"], multiple: false });
  const file = selected?.files?.[0];
  if (!file) return;
  current = await api.callAction("selfie_reference", { action: "set", assetRef: file.ref, expectedRevision: revision });
  notice("形象已更新");
}));
byId("clear").addEventListener("click", () => change(async () => {
  const revision = current.revision;
  current = await api.callAction("selfie_reference", { action: "clear", expectedRevision: revision });
  notice("形象已清除");
}));
refresh().catch(error => { byId("error").textContent = errorText(error); byId("error").hidden = false; });
