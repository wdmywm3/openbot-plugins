"use strict";
const api = window.openbotPlugin, $ = id => document.getElementById(id);
const statusNames = { running: "整理中", completed: "已完成", interrupted: "已中断", paused: "已暂停", failed: "失败", rolled_back: "已回滚", rollback_pending: "回滚待处理" };
let snapshot, runId, preview, nextOffset = null, before = 0, refreshing = null, generation = 0;
const call = (action, input = {}) => api.callAction(action, { chatId: $("chat").value, ...input });
function error(cause, id = "error") { $(id).textContent = cause?.message || String(cause || ""); $(id).hidden = !cause; }
async function task(work, id = "error") { error("", id); try { await work(); } catch (cause) { error(cause, id); } }
function button(text, handler) { const element = document.createElement("button"); element.type = "button"; element.textContent = text; element.onclick = () => task(handler); return element; }
function option(value, text) { const element = document.createElement("option"); element.value = value; element.textContent = text; return element; }
async function refresh(append = false) {
  if (refreshing) return refreshing;
  const current = generation, selected = $("chat").value;
  refreshing = (async () => {
    const result = await call("list", { offset: append ? nextOffset : 0 }); if (current !== generation || selected !== $("chat").value) return;
    snapshot = result;
    $("chat").replaceChildren(option("", "默认设置"), ...(snapshot.chats || []).map(item => option(item.chatId, item.name || item.chatId))); $("chat").value = selected;
    $("status").textContent = snapshot.error || (snapshot.paused ? "自动整理已暂停" : snapshot.busy ? "正在整理…" : snapshot.pending ? "有未完成的整理" : "");
    if (!append) $("items").replaceChildren();
    for (const run of snapshot.runs?.items || []) {
      const row = document.createElement("div"); row.className = "item";
      row.append(button(new Date(run.createdAt).toLocaleString() + " · " + (statusNames[run.status] || run.status) + "\n" + (run.summary || ""), () => openRun(run.id)));
      $("items").append(row);
    }
    nextOffset = snapshot.runs?.nextOffset ?? null; $("more").hidden = nextOffset === null;
    $("followups").hidden = !snapshot.followups?.length; $("followup-items").replaceChildren();
    for (const followup of snapshot.followups || []) {
      const row = document.createElement("p"); row.textContent = followup.completed ? followup.notified ? "复查完成，已提交待通知内容" : "复查完成，无需通知" : followup.paused ? "复查已暂停" : "等待复查";
      if (followup.paused && !followup.canceled && !followup.completed && followup.recordRevision) row.append(button(followup.recoveryRequired ? "已核对，恢复复查" : "恢复复查", async () => { await call("manage", { action: "resumeFollowup", id: followup.memoryId, revision: followup.recordRevision, reconciled: !!followup.recoveryRequired }); await refresh(); }));
      $("followup-items").append(row);
    }
    $("maintenance").hidden = !snapshot.maintenance?.length; $("maintenance-items").replaceChildren();
    for (const proposal of snapshot.maintenance || []) {
      const row = document.createElement("div"), reason = document.createElement("p"); reason.textContent = proposal.reason;
      row.append(reason, button(proposal.target === "long_term" ? "长期保留" : "归档", async () => { await call("manage", { action: "applyMaintenance", id: proposal.proposalId }); await refresh(); }),
        button("忽略", async () => { await call("manage", { action: "dismissMaintenance", id: proposal.proposalId }); await refresh(); }));
      $("maintenance-items").append(row);
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}
async function runEvents(older = false) {
  const details = await call("manage", { action: "readRun", runId, ...(older ? { before } : {}) });
  const pre = document.createElement("pre"); pre.textContent = (details.events || []).map(event => event.text || event.kind).join("\n\n");
  if (older) $("details-body").prepend(pre); else $("details-body").replaceChildren(pre);
  before = details.nextBefore || 0; $("older").hidden = !details.hasMore;
}
async function openRun(id) { runId = id; preview = null; $("rollback-confirm").hidden = true; error("", "details-error"); await runEvents(); $("details").showModal(); }
$("older").onclick = () => task(() => runEvents(true), "details-error");
$("rollback-preview").onclick = () => task(async () => {
  preview = await call("manage", { action: "rollbackPreview", runId }); const pre = document.createElement("pre");
  pre.textContent = [...(preview.conflicts || []), ...(preview.changes || []).map(change => change.beforeRevision ? "恢复版本 " + change.beforeRevision : "撤销本轮新增记忆")].join("\n");
  $("details-body").replaceChildren(pre); $("rollback-confirm").hidden = !preview.token;
}, "details-error");
$("rollback-confirm").onclick = () => task(async () => { await call("manage", { action: "rollback", runId, token: preview.token }); $("details").close(); await refresh(); }, "details-error");
$("settings").onclick = () => task(async () => {
  await refresh(); const config = snapshot.settings;
  $("inherit-label").hidden = !$("chat").value; $("inherit").checked = !!snapshot.inherited;
  $("schedule").value = config.enabled ? config.schedule : "off"; $("daily-time").value = config.dailyTime; $("idle").value = String(config.idleMinutes);
  $("style").hidden = !$("chat").value.includes(":private:"); $("style-lock").checked = !!snapshot.styleLocked;
  const fields = { length: ["长度", { brief: "简短", balanced: "按问题安排", detailed: "适当展开" }], tone: ["语气", { calm: "平和", warm: "亲切", lively: "活泼" }],
    formality: ["表达方式", { casual: "随意", neutral: "自然", formal: "正式" }], humor: ["幽默", { little: "少开玩笑", moderate: "适度幽默" }] };
  $("style-fields").replaceChildren();
  for (const [key, [name, choices]] of Object.entries(fields)) {
    const label = document.createElement("label"), select = document.createElement("select"); label.append(name); select.dataset.key = key;
    select.append(option("", "未指定"), ...Object.entries(choices).map(([value, title]) => option(value, title))); select.value = snapshot.style?.[key] || "";
    label.append(select); $("style-fields").append(label);
  }
  $("run").disabled = !$("chat").value; $("stop").hidden = !!snapshot.paused;
  $("start-now").hidden = !$("chat").value;
  $("scan-start").hidden = !snapshot.checkpoint?.start;
  $("scan-start").textContent = snapshot.checkpoint?.start ? "整理起点更新于 " + new Date(snapshot.checkpoint.start.at).toLocaleString() : "";
  $("stop").disabled = !$("chat").value || !snapshot.settings.enabled && !snapshot.busy && !snapshot.pending;
  $("resume").hidden = !snapshot.paused; error("", "settings-error"); $("preferences").showModal();
});
$("settings-form").onsubmit = event => { event.preventDefault(); task(async () => {
  await call("manage", { action: "settings", inherit: $("inherit").checked, settings: { enabled: $("schedule").value !== "off",
    schedule: $("schedule").value === "hourly" ? "hourly" : "daily", dailyTime: $("daily-time").value, idleMinutes: Number($("idle").value) } });
  if (!$("style").hidden) await call("manage", { action: "style", locked: $("style-lock").checked,
    values: Object.fromEntries([...$("style-fields").querySelectorAll("select")].filter(select => select.value).map(select => [select.dataset.key, select.value])) });
  $("preferences").close(); await refresh();
}, "settings-error"); };
$("run").onclick = () => task(async () => { await call("manage", { action: "run" }); $("preferences").close(); await refresh(); }, "settings-error");
$("stop").onclick = () => task(async () => { await call("manage", { action: "stop" }); $("preferences").close(); await refresh(); }, "settings-error");
$("resume").onclick = () => task(async () => { await call("manage", { action: "resume" }); $("preferences").close(); await refresh(); }, "settings-error");
$("start-now").onclick = () => task(async () => {
  $("start-now").disabled = true;
  try { await call("manage", { action: "startFromNow", requestKey: "checkpoint:" + Date.now() + ":" + Math.random().toString(36).slice(2) });
    $("preferences").close(); await refresh(); }
  finally { $("start-now").disabled = false; }
}, "settings-error");
$("style-reset").onclick = () => task(async () => { await call("manage", { action: "style", values: {}, locked: true }); $("preferences").close(); await refresh(); }, "settings-error");
$("import").onclick = () => task(async () => { const picked = await api.selectFiles({ extensions: ["json"] }); if (picked.files?.length) await call("import", { refs: picked.files.map(file => file.ref) }); await refresh(); });
$("more").onclick = () => task(() => refresh(true));
$("chat").onchange = () => { generation++; void task(async () => { await refreshing; await refresh(); }); };
for (const element of document.querySelectorAll("[data-close]")) element.onclick = () => $(element.dataset.close).close();
void task(refresh); setInterval(() => { if (!document.hidden && !document.querySelector("dialog[open]")) void task(refresh); }, 5000);
