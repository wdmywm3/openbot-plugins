"use strict";
const path = require("node:path");
const fs = require("node:fs/promises");
const { randomUUID, createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createDeviceSetup, connectAdb, identify } = require("./device-setup.cjs");
const execute = promisify(execFile);
const net = require("node:net");
const { AsyncLocalStorage } = require("node:async_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const packageName = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/;
const point = n => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 16384) throw Error("屏幕坐标无效");
  return n;
};
function inputArgs(step) {
  switch (step.action) {
    case "tap": return ["io", "tap", point(step.x) + "," + point(step.y)];
    case "longpress": return ["io", "longpress", point(step.x) + "," + point(step.y)];
    case "swipe": return ["io", "swipe", [step.x, step.y, step.toX, step.toY].map(point).join(",")];
    case "back": return ["io", "button", "BACK"];
    case "home": return ["io", "button", "HOME"];
    case "rotate":
      if (!["portrait","landscape"].includes(step.orientation)) throw Error("屏幕方向无效");
      return ["device","orientation","set",step.orientation];
    case "type":
    case "fill":
      if (typeof step.text !== "string" || step.text.length > 2000) throw Error("输入文字限 2000 字");
      return ["io", step.action === "fill" ? "fill" : "text", "--", step.text];
    case "terminate":
    case "launch":
      if (!packageName.test(step.app || "")) throw Error("应用包名无效");
      return ["apps", step.action, step.app];
    default: throw Error("未知手机操作");
  }
}
function screenFingerprint(nodes) {
  // mobilecli's snapshot refs are transient. Identity, order, bounds and UI state
  // still participate in the check immediately before dispatching a device input.
  const contents = JSON.stringify(nodes, (key, value) => key === "ref" ? undefined : value);
  return createHash("sha256").update(contents).digest("hex");
}
function screenSnapshot(nodes) {
  const elements = [], pending = [nodes.values()];
  let size = 2, truncated = false;
  while (pending.length) {
    const item = pending.at(-1).next();
    if (item.done) { pending.pop(); continue; }
    if (!item.value || typeof item.value !== "object") continue;
    const { children, ...element } = item.value;
    for (const [key, value] of Object.entries(element)) {
      if (typeof value === "string" && value.length > 1024) { element[key] = value.slice(0, 1024); truncated = true; }
    }
    size += JSON.stringify(element).length + 1;
    if (size > 16000 || elements.length === 256) { truncated = true; break; }
    elements.push(element);
    if (Array.isArray(children) && children.length) pending.push(children.values());
  }
  return { elements, truncated };
}
function controlValue(nodes, { identifier, field, anchorText }) {
  const pending = [nodes.values()];
  let match, foundAnchor = anchorText === undefined;
  while (pending.length) {
    const { done, value: node } = pending.at(-1).next();
    if (done) { pending.pop(); continue; }
    if (node?.text === anchorText || node?.label === anchorText) foundAnchor = true;
    if (node?.identifier === identifier) {
      if (match) throw Object.assign(Error("当前页面有多个同名控件"), { code: "PHONE_CONTROL_AMBIGUOUS" });
      match = node;
    }
    if (Array.isArray(node?.children)) pending.push(node.children.values());
  }
  if (!foundAnchor) throw Object.assign(Error("当前页面找不到指定的定位文字"), { code: "PHONE_WAIT_ANCHOR_MISSING" });
  if (!match) throw Object.assign(Error("当前页面找不到等待的控件"), { code: "PHONE_CONTROL_MISSING" });
  const value = match[field];
  if (typeof value !== "string") throw Object.assign(Error("控件未返回指定文字字段"), { code: "PHONE_CONTROL_FIELD_MISSING" });
  if (value.length > 1024) throw Object.assign(Error(`控件文字超过 1024 个字符（${value.length} 个字符）`), { code: "PHONE_CONTROL_TOO_LONG" });
  return value;
}
async function sdkHome(root, adbPath) {
  const dir = await fs.realpath(path.dirname(adbPath));
  if (path.basename(dir).toLowerCase() === "platform-tools") return path.dirname(dir);
  const sdk = path.join(root, "sdk", createHash("sha256").update(dir).digest("hex"));
  await fs.mkdir(sdk, { recursive: true });
  const link = path.join(sdk, "platform-tools");
  try { await fs.symlink(dir, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (path.relative(dir, await fs.realpath(link))) throw Error("设备工具路径已变化");
  return sdk;
}
function createDriver(root, { run = execute, clock = Date.now, setupOptions = {}, binary } = {}) {
  const requests = new AsyncLocalStorage(), sessions = new Map(), waiters = [];
  // Only the latest observation of a physical device can authorize an input.
  // Keep it across short leases, never across driver restarts.
  const observations = new Map();
  function rememberScreen(s, app, fingerprint) {
    observations.delete(s.key);
    if (observations.size >= 128) observations.delete(observations.keys().next().value);
    const token = randomUUID();
    observations.set(s.key, { token, app, fingerprint, scope: s.scope, expires: clock() + 120000 });
    return token;
  }
  const executeFile = run;
  run = (file, args, options) => executeFile(file, args, { ...options, signal: requests.getStore() });
  const release = id => {
    const s = sessions.get(id);
    if (s) { clearTimeout(s.timer); s.mutex?.close(); sessions.delete(id); }
  };
  const renew = (id, s) => {
    clearTimeout(s.timer); s.expires = clock() + 90000;
    s.timer = setTimeout(() => { if (!s.busy) release(id); }, 90000); s.timer.unref();
  };
  async function reserve(key, mode) {
    const ticket = { key, priority: mode === "private" };
    if (waiters.length >= 8) throw Error("设备等待队列已满");
    waiters.push(ticket);
    const deadline = clock() + 25000;
    try {
      for (;;) {
        requests.getStore()?.throwIfAborted();
        const next = waiters.find(item => item.key === key && item.priority) || waiters.find(item => item.key === key);
        if (next === ticket && ![...sessions.values()].some(s => s.key === key)) {
          const mutex = net.createServer(socket => socket.destroy());
          // An OS-owned pipe releases automatically if this plugin process exits.
          const name = process.platform === "win32" ? "\\\\.\\pipe\\openbot-bphone-" + key : path.join(require("node:os").tmpdir(), key + ".sock");
          try {
            await new Promise((resolve,reject) => { mutex.once("error",reject); mutex.listen(name,resolve); });
            mutex.unref(); return mutex;
          } catch (e) { if (e.code !== "EADDRINUSE") throw e; }
        }
        if (mode === "idle" || clock() >= deadline) throw Object.assign(Error("设备正在执行其他任务"), { code: "PHONE_DEVICE_BUSY" });
        await delay(150, undefined, { signal: requests.getStore() });
      }
    } finally { waiters.splice(waiters.indexOf(ticket), 1); }
  }
  const expire = () => {
    for (const [id, s] of sessions) if (!s.busy && s.expires <= clock()) release(id);
  };
  const setup = createDeviceSetup({ ...setupOptions, run, assertIdle(value) {
    expire();
    if ([...sessions.values()].some(s => s.key === value.key || s.host === value.host && s.port === value.port)) throw Error("这台手机正在执行任务");
  } });
  async function command(s, args, image = false) {
    const bin = binary || path.join(path.dirname(require.resolve("@mobilenext/mobilecli-windows-amd64/package.json")), "mobilecli-windows-amd64.exe");
    let output;
    try { output = (await run(bin, ["--device", s.serial, ...args], { windowsHide: true, timeout: 15000,
      env: { ...process.env, ANDROID_HOME: s.sdk, ANDROID_SDK_ROOT: s.sdk, PATH: path.dirname(s.adbPath) + path.delimiter + (process.env.PATH || "") },
      encoding: image ? "buffer" : "utf8", maxBuffer: 4 * 1024 * 1024 })).stdout; }
    catch (e) { throw Error(e.killed ? "手机操作超时" : `手机操作失败（${e.code ?? "未知状态"}）`); }
    if (image) return output;
    const operation = args.slice(0, 2).join(" ");
    const reply = String(output ?? "").trim();
    if (!reply) throw Object.assign(Error(`设备命令 ${operation} 没有返回内容`), { code: "EMPTY_DEVICE_RESPONSE" });
    let result;
    try { result = JSON.parse(reply); }
    catch (error) {
      const trailing = /^Unexpected non-whitespace character after JSON at position \d+ \(line (\d+) column (\d+)\)/.exec(error.message);
      if (trailing) throw Object.assign(Error(`设备命令 ${operation} 返回的 JSON 后还有内容（第 ${trailing[1]} 行第 ${trailing[2]} 列）`), { code: "TRAILING_DEVICE_JSON_CONTENT" });
      throw Object.assign(Error(`设备命令 ${operation} 返回的内容不是有效 JSON`), { code: "INVALID_DEVICE_JSON" });
    }
    if (typeof result?.status !== "string") throw Object.assign(Error(`设备命令 ${operation} 未返回状态`), { code: "MISSING_DEVICE_STATUS" });
    if (result.status !== "ok") throw Error("手机操作返回状态 " + String(result.status).slice(0, 60));
    return result.data;
  }
  let picker;
  async function pickFile() {
    if (!picker) {
      const selection = picker = { id: randomUUID() };
      const script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.OpenFileDialog;$d.Filter='Android Debug Bridge (adb.exe)|adb.exe';try{if($d.ShowDialog() -eq 'OK'){$d.FileName}}finally{$d.Dispose()}";
      const powershell = path.join(process.env.SystemRoot || "C:/Windows","System32/WindowsPowerShell/v1.0/powershell.exe");
      execute(powershell, ["-NoProfile","-NonInteractive","-STA","-Command",script], {windowsHide:true,timeout:120000,maxBuffer:8192})
        .then(result => { selection.file = result.stdout.trim(); }, error => { selection.error = error.killed ? "选择 ADB 已超时" : "打开文件选择窗口失败"; })
        .finally(() => { selection.done = true; setTimeout(()=>{if(picker===selection) picker=null;},30000).unref(); });
    }
    return { id: picker.id };
  }
  async function call(input, readTarget) {
    expire();
    const { op, deviceId, binding } = input;
    if (op === "pick") return pickFile();
    if (op === "picked") {
      if (!picker || picker.id !== input.ticket) throw Error("文件选择已结束");
      if (!picker.done) return { done: false };
      const result = picker; picker = null;
      if (result.error) throw Error(result.error);
      return { done: true, file: result.file };
    }
    if (op === "scan") return setup.scan("local", input);
    if (op === "preview") {
      const captured = await setup.test("local", deviceId, input);
      const png = Buffer.from(captured.screenshot.split(",")[1],"base64");
      const thumbnail = await require("sharp")(png,{limitInputPixels:40_000_000}).resize({
        width:400,height:320,fit:"inside",withoutEnlargement:true
      }).jpeg({quality:55}).toBuffer();
      if (thumbnail.length > 40 * 1024) throw Error(`设备预览图超过 40 KiB（${thumbnail.length} 字节）`);
      return { token:captured.token, model:captured.model, thumbnail:"data:image/jpeg;base64," + thumbnail.toString("base64") };
    }
    if (op === "confirm") return setup.verifiedBinding("local", deviceId, input.token);
    if (op === "probe") {
      if (typeof input.app !== "string" || !packageName.test(input.app) || typeof input.identifier !== "string" || !input.identifier.trim()
        || input.identifier.length > 512 || !["text", "label"].includes(input.field)
        || (input.anchorText !== undefined && (typeof input.anchorText !== "string" || !input.anchorText.trim() || input.anchorText.length > 512)))
        throw Object.assign(Error("等待读屏的目标无效"), { code: "PHONE_WAIT_TARGET" });
      const { lease } = await call({ ...input, op: "begin", mode: "idle" });
      try { return await call({ op: "observe", lease }, input); }
      finally { release(lease); }
    }
    if (op === "begin") {
      if (!binding?.key || !binding.connection) throw Error("请先确认这台手机的截图");
      const c = await connectAdb(binding.connection, run);
      if ((await identify(c, run)).key !== binding.key) throw Error("端口对应的手机已更换，请重新确认设备");
      const sdk = await sdkHome(root, c.adbPath);
      const mutex = await reserve(binding.key, input.mode);
      const lease = randomUUID();
      sessions.set(lease, { ...c, sdk, mutex, key: binding.key, apps: input.allApps ? null : (input.apps || []).filter(x => packageName.test(x)),
        scope: input.scope, expires: clock() + 90000, observed: "" });
      renew(lease,sessions.get(lease));
      return { lease };
    }
    const s = sessions.get(input.lease);
    if (!s) throw Error("设备任务已结束");
    if (s.busy) throw Error("设备正在执行上一项操作");
    if (op === "end") { release(input.lease); return {}; }
    s.busy = true;
    let dispatched = false;
    try {
      if ((await identify(s, run)).key !== s.key) throw Error("设备连接已改变");
      const foreground = async () => (await command(s, ["apps", "foreground"]))?.packageName;
      const app = await foreground();
      const allowed = Boolean(app) && (!s.apps || s.apps.includes(app));
      if (op === "apps") {
        const data = await command(s, ["apps", "list"]);
        const items = Array.isArray(data) ? data : data?.apps;
        if (!Array.isArray(items)) throw Error("设备未返回应用列表");
        return { apps: items.filter(item => !s.apps || s.apps.includes(item.packageName)).slice(0, 250).map(item => [item.appName, item.packageName]) };
      }
      if (op === "observe") {
        s.observed = "";
        if (readTarget) {
          if (!app) throw Object.assign(Error("设备未返回前台应用"), { code: "PHONE_FOREGROUND_UNKNOWN" });
          if (!allowed) throw Object.assign(Error("当前应用不在允许范围内"), { code: "PHONE_APP_NOT_ALLOWED" });
          if (app !== readTarget.app) throw Object.assign(Error("手机已离开指定应用"), { code: "PHONE_WAIT_APP_CHANGED" });
        }
        if (!allowed) return { app: "", allowedApps: s.apps || [], outside: true, observationId: rememberScreen(s, app, "") };
        const data = await command(s, ["dump", "ui"]);
        if (await foreground() !== app) throw Object.assign(Error("读屏期间前台应用已改变"), { code: "SCREEN_CHANGED" });
        if (!Array.isArray(data?.elements)) throw Error("设备未返回控件列表");
        if (readTarget) return { value: controlValue(data.elements, readTarget) };
        s.observed = app;
        s.fingerprint = screenFingerprint(data.elements);
        return { app, ...screenSnapshot(data.elements), observationId: rememberScreen(s, app, s.fingerprint) };
      }
      if (op === "screenshot") {
        if (!allowed || s.observed !== app) throw Error("请重新查看当前应用");
        const buffer = await command(s, ["screenshot", "--format", "jpeg", "--max-size", "960", "--output", "-"], true);
        if (await foreground() !== app) throw Error("截图期间前台应用已改变");
        return { image: Buffer.from(buffer).toString("base64"), mimeType: "image/jpeg" };
      }
      if (op !== "step") throw Error("未知设备任务");
      const step = input.step || {};
      const seen = observations.get(s.key);
      if (!seen || seen.scope !== s.scope || seen.token !== input.observationId || seen.expires <= clock()) throw Error("观察编号已失效，请重新读屏");
      observations.delete(s.key);
      if (seen.app !== app) throw Object.assign(Error("当前应用已变化，请重新读屏"), { code: "SCREEN_CHANGED" });
      if (step.action === "terminate" && (step.app !== app || !allowed)) throw Error("只能关闭当前获准应用");
      if (step.action === "launch") {
        if (s.apps && !s.apps.includes(step.app)) throw Error("该应用未获准使用");
      } else if (!allowed) throw Error("当前应用不在允许范围内");
      if (seen.fingerprint) {
        const latest = await command(s, ["dump","ui"]);
        if (!Array.isArray(latest?.elements) || screenFingerprint(latest.elements) !== seen.fingerprint || await foreground() !== app)
          throw Object.assign(Error("当前画面已变化，请重新观察"), {code:"SCREEN_CHANGED"});
      }
      s.observed = "";
      const args = inputArgs(step);
      if (input.deadline !== undefined && clock() >= input.deadline) throw Error("手机脚本已超时");
      dispatched = true;
      await command(s, args);
      return { completed: true };
    } catch (error) {
      if (op === "step" && !dispatched) error.beforeDispatch = true;
      throw error;
    } finally { s.busy = false; renew(input.lease,s); }
  }
  return (input, signal) => {
    signal ||= AbortSignal.timeout(55000);
    if (input.op === "probe") {
      const remaining = input.deadline - clock();
      if (!Number.isSafeInteger(remaining) || remaining <= 0) throw Object.assign(Error("已到手机等待时限"), { code: "PHONE_WAIT_TIMEOUT" });
      const timeout = AbortSignal.timeout(Math.min(remaining, 90000));
      return requests.run(AbortSignal.any([signal, timeout]), async () => {
        try { return await call(input); }
        catch (error) {
          signal.throwIfAborted();
          if (timeout.aborted) throw Object.assign(Error("已到手机等待时限"), { code: "PHONE_WAIT_TIMEOUT" });
          throw error;
        }
      });
    }
    return requests.run(signal, () => call(input));
  };
}
module.exports = { createDriver };
