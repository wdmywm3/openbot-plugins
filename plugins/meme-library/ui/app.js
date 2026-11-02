"use strict";
const api = window.openbotPlugin, $ = id => document.getElementById(id);
let snapshot, editing, offset = 0, loading = false, prefRevision = 0;
let exportJob = "";
const call = (action, input = {}) => api.callAction(action, input);
function showError(error, id = "error") { $(id).textContent = ""; $(id).hidden = true; if (error) window.openbotPlugin.notify(error?.message || String(error)); }
function button(label, handler) { const el = document.createElement("button"); el.type = "button"; el.textContent = label; el.onclick = () => task(handler); return el; }
async function task(work, errorId = "error") { showError("", errorId); try { await work(); } catch (error) { showError(error, errorId); } }
function options(select, rows, selected = []) {
  select.replaceChildren(...rows.map(row => { const option = document.createElement("option"); option.value = row.id; option.textContent = row.name; option.selected = selected.includes(row.id); return option; }));
}
function renderJobs(jobs) {
  const active = jobs.find(job => job.status === "running") || jobs.find(job => job.status === "queued")
    || (["failed", "interrupted", "paused"].includes(jobs[0]?.status) ? jobs[0] : null);
  $("progress").replaceChildren(); $("progress").hidden = !active;
  if (!active) return;
  const state = active.progress || {}, label = document.createElement("span");
  label.textContent = active.status === "failed" ? active.error || "更新失败" : state.phase === "model" ? `正在准备检索模型${state.total ? ` · ${Math.round(state.received / state.total * 100)}%` : ""}`
    : `${active.status === "queued" ? "等待更新" : active.status === "running" ? state.phase === "sync" ? "同步收藏" : "更新表情" : "更新已中断"}${state.total ? ` ${state.completed || 0}/${state.total}` : ""}${state.failed ? `，${state.failed} 张失败` : ""}`;
  $("progress").append(label, button(["running", "queued"].includes(active.status) ? "停止" : "继续", async () => {
    if (["running", "queued"].includes(active.status)) await call("stop"); else await call("job", { action: "resume", id: active.id });
    await refresh();
  }));
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    snapshot = await call("list", { query: $("query").value, offset });
    $("sync").hidden = snapshot.capabilities.platform !== "napcat";
    $("summary").textContent = `${snapshot.counts.total} 张 · ${snapshot.counts.searchable} 张可用${snapshot.retrievalStatus?.mode === "bm25" ? " · 当前使用关键词检索" : ""}${snapshot.counts.failed ? ` · ${snapshot.counts.failed} 张需重试` : ""}`;
    const tiles = snapshot.items.map(item => {
      const tile = button("", () => openEditor(item)); tile.className = "tile" + (item.enabled === false ? " off" : "");
      const image = document.createElement("img"); image.loading = "lazy"; image.alt = item.caption || "表情"; image.src = api.assetUrl(item.assetRef);
      const caption = document.createElement("span"); caption.textContent = item.caption || item.name || "待识别";
      tile.append(image, caption);
      if (item.error || !["ready", "fallback"].includes(item.indexStatus)) { const status = document.createElement("span"); status.className = item.error ? "status" : ""; status.textContent = item.error ? "更新失败" : "待更新"; tile.append(status); }
      return tile;
    });
    $("grid").replaceChildren(...tiles);
    if (!tiles.length) $("grid").textContent = snapshot.total ? "当前页没有表情" : "还没有表情，可以导入图片或同步 QQ 收藏。";
    $("previous").disabled = offset === 0; $("next").disabled = snapshot.nextOffset == null;
    $("page").textContent = `${Math.floor(offset / 48) + 1} / ${Math.max(1, Math.ceil(snapshot.total / 48))}`;
    $("paging").hidden = snapshot.total <= 48; renderJobs(snapshot.jobs);
    if (exportJob) {
      const job = await call("job", { action: "status", id: exportJob });
      if (job.status === "completed") {
        $("progress").hidden = false;
        $("progress").append(button("保存导出文件", async () => { const result = await api.saveFiles(job.result.files.map(file => file.ref)); if (!result.canceled) exportJob = ""; await refresh(); }));
      }
    }
  } finally { loading = false; }
}
async function openEditor(item) {
  item = await call("detail", { id: item.id });
  editing = item; showError("", "edit-error");
  $("original").src = api.assetUrl(item.assetRef, { preview: false });
  for (const field of ["caption", "meaning", "ocrText"]) $(field).value = item[field] || "";
  $("tags").value = (item.tags || []).join("，"); $("enabled").checked = item.enabled !== false;
  $("descriptors").replaceChildren(...Object.entries(descriptors).map(([key, name]) => {
    const label = document.createElement("label"), input = document.createElement("textarea");
    label.textContent = name; input.dataset.field = key; input.rows = 2; input.maxLength = 3000;
    input.value = Array.isArray(item[key]) ? item[key].join("\n") : item[key] || "";
    label.append(input); return label;
  }));
  options($("profiles"), snapshot.contexts.profiles, item.profileIds);
  options($("chats"), snapshot.contexts.chats, item.chatIds);
  $("chat-mode").value = item.chatMode || "all"; $("chats").hidden = $("chat-mode").value === "all";
  $("editor").showModal();
}
$("edit-form").onsubmit = event => { event.preventDefault(); task(async () => {
  const extra = Object.fromEntries([...$("descriptors").querySelectorAll("textarea")].map(input => [input.dataset.field,
    input.dataset.field === "literalDescription" ? input.value : input.value.split(/\n/).map(v => v.trim()).filter(Boolean)]));
  await call("save", { id: editing.id, revision: editing.revision, caption: $("caption").value, meaning: $("meaning").value,
    ...extra,
    ocrText: $("ocrText").value, tags: $("tags").value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean), enabled: $("enabled").checked,
    profileIds: [...$("profiles").selectedOptions].map(o => o.value), chatMode: $("chat-mode").value, chatIds: [...$("chats").selectedOptions].map(o => o.value) });
  $("editor").close(); await refresh();
}, "edit-error"); };
const descriptors = { literalDescription: "画面细节", emotions: "情绪", useCases: "适用情境（每行一项）", communicativeIntent: "表达意图", tone: "语气", targetRole: "表达对象", usageExamples: "使用示例", avoidContexts: "不适合的情境", aliases: "别名", style: "画风" };
let historyId = "", historyCursor;
const statusNames = { running: "识别中或已中断", completed: "完成", superseded: "已保留人工修改", failed: "失败", pending: "候选已返回", no_match: "未采用", sent: "已发送", positive: "合适", negative: "不合适", wrong: "含义不符", replaced: "已替换" };
async function loadHistory(more = false) {
  const page = await call("history", { ...(historyId ? { id: historyId } : {}), ...(more && historyCursor ? { cursor: historyCursor } : {}) });
  if (!more) $("history-items").replaceChildren();
  for (const row of page.records) {
    const section = document.createElement("details"), heading = document.createElement("summary");
    heading.textContent = `${new Date(row.value.at).toLocaleString()} · ${statusNames[row.value.status] || row.value.status} · ${row.value.summary}`;
    section.append(heading);
    section.ontoggle = () => { if (section.open && !section.dataset.loaded) task(async () => {
      const { record } = await call("history", { key: row.key }), data = record.value.data || {}, body = document.createElement("pre");
      body.textContent = historyId ? [data.modelId, data.output, data.error].filter(Boolean).join("\n\n")
        : [data.candidates?.length ? `候选 ${data.candidates.length} 张` : "没有匹配候选", data.selectedId ? "已采用候选图片" : "", data.note, data.warning].filter(Boolean).join("\n");
      section.append(body); section.dataset.loaded = "true";
    }, "history-error"); };
    $("history-items").append(section);
  }
  if (!page.records.length && !more) $("history-items").textContent = "暂无记录";
  historyCursor = page.nextCursor; $("history-more").hidden = !historyCursor;
}
async function openHistory(id) { historyId = id; showError("", "history-error"); $("history-title").textContent = id ? "识图记录" : "检索记录"; await loadHistory(); $("history").showModal(); }
$("recognition-history").onclick = () => task(() => openHistory(editing.id), "edit-error");
$("search-history").onclick = () => task(() => openHistory(""));
$("history-more").onclick = () => task(() => loadHistory(true), "history-error");
$("remove").onclick = () => task(async () => { await call("remove", { id: editing.id, revision: editing.revision }); $("editor").close(); await refresh(); }, "edit-error");
$("chat-mode").onchange = () => { $("chats").hidden = $("chat-mode").value === "all"; };
for (const el of document.querySelectorAll("[data-close]")) el.onclick = () => $(el.dataset.close).close();
$("import").onclick = () => task(async () => {
  const chosen = await api.selectFiles({ extensions: ["png", "jpg", "jpeg", "gif", "webp", "json"] });
  if (!chosen.files?.length) return;
  const bundles = chosen.files.filter(file => file.mimeType === "application/json"), images = chosen.files.filter(file => file.mimeType !== "application/json");
  if (images.length) await call("import", { refs: images.map(file => file.ref) });
  if (bundles.length) await call("importBundle", { refs: bundles.map(file => file.ref) });
  await refresh();
});
$("sync").onclick = () => task(async () => { await call("sync"); await refresh(); });
$("update").onclick = () => task(async () => { await call("update", { requestKey: String(Date.now()) }); await refresh(); });
$("export").onclick = () => task(async () => { exportJob = (await call("exportBundle")).id; await refresh(); });
$("previous").onclick = () => { offset = Math.max(0, offset - 48); task(refresh); };
$("next").onclick = () => { offset = snapshot.nextOffset; task(refresh); };
let debounce; $("query").oninput = () => { clearTimeout(debounce); debounce = setTimeout(() => { offset = 0; task(refresh); }, 250); };
function renderPreferences(p) {
  prefRevision = p.revision; $("frequency").value = p.frequency; $("frequency-value").textContent = p.frequency === 0 ? "关闭" : `${p.frequency}%`;
  $("cooldown").value = p.cooldownSeconds; $("auto-collect").checked = p.autoCollect; $("vision").value = p.visionModelId || "";
  $("vision-label").hidden = !!$("setting-chat").value;
  $("retrieval").value = p.retrievalModelId || "";
  $("model-status").hidden = !snapshot.retrievalStatus?.warning;
  $("model-status").textContent = snapshot.retrievalStatus?.warning || "";
}
$("settings").onclick = () => task(async () => {
  options($("setting-chat"), [{ id: "", name: "默认设置" }, ...snapshot.contexts.chats], [""]);
  options($("vision"), [{ id: "", name: "跟随实例模型" }, ...snapshot.models.filter(m => m.imageEnabled)]);
  options($("retrieval"), [{ id: "", name: "自动选择" }, ...snapshot.retrievalModels.filter(m => m.modalities.includes("image"))
    .map(m => ({ id: m.id, name: m.name + (m.modalities.includes("joint") ? "" : "（按画面检索）") }))]);
  renderPreferences(snapshot.preferences); showError("", "settings-error"); $("preferences").showModal();
});
$("setting-chat").onchange = () => task(async () => { renderPreferences((await call("list", { chatId: $("setting-chat").value })).preferences); }, "settings-error");
$("frequency").oninput = () => { $("frequency-value").textContent = Number($("frequency").value) ? $("frequency").value + "%" : "关闭"; };
$("settings-form").onsubmit = event => { event.preventDefault(); task(async () => {
  await call("settings", { revision: prefRevision, chatId: $("setting-chat").value, frequency: Number($("frequency").value), cooldownSeconds: Number($("cooldown").value),
    autoCollect: $("auto-collect").checked, visionModelId: $("vision").value, retrievalModelId: $("retrieval").value }); $("preferences").close(); await refresh();
}, "settings-error"); };
task(refresh); setInterval(() => { if (!document.hidden && !$("editor").open && !$("preferences").open) task(refresh); }, 5000);
