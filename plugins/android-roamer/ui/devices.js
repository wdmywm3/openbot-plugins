"use strict";
const api = window.openbotPlugin, $ = id => document.getElementById(id);
const call = (op, args) => api.callAction("devices", { op, ...args });
let dirty = false;
const markDirty = value => { dirty=value; api.ui.setDirty?.(value); };
let instances = {}, owner, devices = [], id, token = "", revision = 0, busy = false, generation = 0;
const selected = () => devices.find(item => item.deviceId === id);
function invalidate() {
  generation++; token = ""; $("results").replaceChildren(); $("status").textContent = ""; $("save").disabled = true;
}
async function show(list, selection) {
  devices = list; invalidate();
  $("device").replaceChildren(...list.map(row => new Option(row.name, row.deviceId)), new Option("新建设备", ""));
  const row = list.some(item => item.deviceId === selection) ? (await call("detail",{deviceId:selection})).device : null;
  id = row?.deviceId || "phone-" + Array.from(crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2,"0")).join("");
  revision = row?.deviceRevision || 0;
  $("device").value = row?.deviceId || "";
  $("name").value = row?.name || "";
  $("host").value = row?.connection?.host || "127.0.0.1";
  $("port").value = row?.connection?.port || 16384;
  $("adb").value = row?.connection?.adbPath || "";
  $("options").hidden = !row;
  $("default").checked = row?.isDefault === true; $("paused").checked = row?.paused === true;
  $("report").textContent = "";
  const others = Object.entries(instances).filter(([ns])=>ns !== owner);
  $("target").replaceChildren(...others.map(([ns,name])=>new Option(name,ns)));
  $("transfer-field").hidden = $("transfer").hidden = !others.length;
  drawOverrides(row?.effectiveSettings || {}); markDirty(false);
}
async function run(fn) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll("main input,main select,main button:not(li button)")];
  controls.forEach(el => el.disabled = true);
  try { await fn(); } catch (e) { api.notify(e.message || String(e)); }
  finally { busy = false; controls.forEach(el => el.disabled = false); $("save").disabled = !token; }
}
const fields = [["useEnabled","按需使用手机","boolean"],["autonomyEnabled","闲时自行活动","boolean"],["interests","兴趣与想做的事","text"],["prohibitions","不希望做的事","text"],["shareDiscoveries","分享发现","boolean"],["screenshots","分享可附截图","boolean"],["allApps","使用所有应用","boolean"],["playApps","指定应用包名","array"],["autonomyRestMinutes","休息时间（分钟）","number"],["autonomyMeanMinutes","平均等待（分钟）","number"],["autonomyDailyLimit","每天闲时活动次数","number"],["maxSteps","最多操作步数","number"]];
function drawOverrides(values) {
  $("overrides").replaceChildren();
  for (const [key, title, type] of fields) {
    const label = document.createElement("label"); label.textContent = title;
    const el = document.createElement(type === "boolean" ? "select" : "input");
    if (type === "boolean") el.replaceChildren(new Option("跟随实例",""), new Option("开启","true"), new Option("关闭","false"));
    else { el.type = type === "number" ? "number" : "text"; el.placeholder = "跟随实例"; }
    el.id = "setting-" + key; el.value = values[key] == null ? "" : Array.isArray(values[key]) ? values[key].join(", ") : String(values[key]);
    label.append(el); $("overrides").append(label);
  }
}
document.querySelector("main").addEventListener("input",event=>{
  if (event.target.matches("input,select") && !["device","target"].includes(event.target.id)) markDirty(true);
});
$("device").onchange = () => run(async () => {
  const target = $("device").value;
  if (dirty && !await api.ui.confirm({title:"放弃未保存的修改",message:"切换设备会放弃当前修改。",confirmLabel:"切换"})) { $("device").value=selected()?.deviceId || ""; return; }
  await show(devices,target);
});
for (const key of ["host","port","adb"]) $(key).oninput = invalidate;
$("pick").onclick = () => run(async () => {
  const ticket = (await call("pick", {})).id;
  for (;;) {
    await new Promise(resolve=>setTimeout(resolve,700));
    const result = await call("picked",{ ticket });
    if (result.done) { if (result.file) { invalidate(); $("adb").value=result.file; markDirty(true); } return; }
  }
});
$("scan").onclick = () => run(async () => {
  invalidate(); const scan = generation, base = { deviceId:id, host:$("host").value, port:Number($("port").value), adbPath:$("adb").value };
  $("status").textContent = "正在扫描…";
  const found = await call("scan", base);
  $("adb").value = found.adbPath || base.adbPath;
  if (found.adbWarning) api.notify(found.adbWarning);
  for (const device of found.devices) {
    const li = document.createElement("li"), row = document.createElement("button"), address = document.createElement("span");
    address.textContent = device.host + ":" + device.port; row.append(address); row.disabled = true; li.append(row); $("results").append(li);
    if (!found.adbPath) continue;
    $("status").textContent = "正在获取 " + address.textContent + " 的截图…";
    try {
      const preview = await call("preview", { ...base, ...device, adbPath:found.adbPath });
      if (generation !== scan) return;
      const img = document.createElement("img"); img.src = preview.thumbnail; img.alt = address.textContent + " 的设备截图"; row.append(img);
      row.disabled = false;
      row.onclick = () => { for (const other of $("results").querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === row));
        token = preview.token; $("port").value = device.port; $("host").value = device.host; $("save").disabled = busy; };
      if (found.devices.length === 1 || device.port === base.port && !token) row.click();
    } catch (e) { const reason = document.createElement("span"); reason.textContent = e.message || String(e); row.append(reason); }
  }
  $("status").textContent = found.devices.length ? "" : "未找到设备";
});
$("save").onclick = () => run(async () => {
  const result = await call("save", { deviceId:id, token, revision, name:$("name").value });
  await show(result.devices,id); api.notify("设备连接已保存","success");
});
$("update").onclick = () => run(async () => {
  const settings = {};
  for (const [key,,type] of fields) {
    const raw = $("setting-" + key).value.trim(); if (!raw) continue;
    settings[key] = type === "boolean" ? raw === "true" : type === "array" ? raw.split(/[,，\s]+/).filter(Boolean) : type === "number" ? Number(raw) : raw;
  }
  const result = await call("update",{deviceId:id,revision,name:$("name").value,isDefault:$("default").checked,paused:$("paused").checked,settings});
  await show(result.devices,id); api.notify("设备设置已保存","success");
});
$("history").onclick = () => run(async () => {
  const result = await call("history",{deviceId:id});
  $("report").textContent = result.items.map(item=>new Date(item.at).toLocaleString()+"  "+item.summary).join("\n") || "还没有操作记录。";
});
$("activity").onclick = () => run(async () => {
  const res = await call("activity",{deviceId:id}); $("report").textContent = res.report || "还没有活动记录。";
});
$("transfer").onclick = () => run(async () => {
  const target = $("target").value;
  if (!await api.ui.confirm({title:"转移设备",message:"将「" + selected().name + "」转移到「" + instances[target] + "」？",confirmLabel:"转移"})) return;
  const result = await call("transfer",{deviceId:id,revision,target}); await show(result.devices,result.devices[0]?.deviceId);
});
$("remove").onclick = () => run(async () => {
  if (!await api.ui.confirm({ title:"移除设备", message:"移除「" + selected().name + "」的连接？" })) return;
  const result = await call("remove",{deviceId:id,revision}); await show(result.devices,result.devices[0]?.deviceId);
});
run(async () => { const state = await call("list",{}); instances=state.instances; owner=state.owner; const list=state.devices; await show(list,(list.find(row => row.isDefault) || list[0])?.deviceId); });
