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
        if (mode === "idle" || clock() >= deadline) throw Error("设备正在执行其他任务");
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
    const result = JSON.parse(String(output));
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
  async function call(input) {
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
    if (op === "preview") return setup.test("local", deviceId, input);
    if (op === "confirm") return setup.verifiedBinding("local", deviceId, input.token);
    if (op === "begin") {
      if (!binding?.key || !binding.connection) throw Error("请先确认这台手机的截图");
      const c = await connectAdb(binding.connection, run);
      if ((await identify(c, run)).key !== binding.key) throw Error("端口对应的手机已更换，请重新确认设备");
      const sdk = await sdkHome(root, c.adbPath);
      const mutex = await reserve(binding.key, input.mode);
      const lease = randomUUID();
      sessions.set(lease, { ...c, sdk, mutex, key: binding.key, apps: input.allApps ? null : (input.apps || []).filter(x => packageName.test(x)),
        expires: clock() + 90000, observed: "" });
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
        const items = await command(s, ["apps", "list"]);
        return { apps: items.filter(item => !s.apps || s.apps.includes(item.packageName)).slice(0, 250).map(item => [item.appName, item.packageName]) };
      }
      if (op === "observe") {
        s.observed = "";
        if (!allowed) return { app: "", allowedApps: s.apps || [], outside: true };
        const data = await command(s, ["dump", "ui"]);
        if (await foreground() !== app) throw Error("读屏期间前台应用已改变");
        if (!Array.isArray(data?.elements)) throw Error("设备未返回控件列表");
        s.observed = app;
        const screen = JSON.stringify(data.elements);
        s.fingerprint = createHash("sha256").update(screen).digest("hex");
        return { app, screen: screen.slice(0, 16000) };
      }
      if (op === "screenshot") {
        if (!allowed || s.observed !== app) throw Error("请重新查看当前应用");
        const buffer = await command(s, ["screenshot", "--format", "jpeg", "--max-size", "960", "--output", "-"], true);
        if (await foreground() !== app) throw Error("截图期间前台应用已改变");
        return { image: Buffer.from(buffer).toString("base64"), mimeType: "image/jpeg" };
      }
      if (op !== "step") throw Error("未知设备任务");
      const step = input.step || {};
      if (step.action === "terminate" && (step.app !== app || !allowed)) throw Error("只能关闭当前获准应用");
      if (step.action === "launch") {
        if (s.apps && !s.apps.includes(step.app)) throw Error("该应用未获准使用");
      } else if (!allowed || s.observed !== app) throw Error("请重新查看当前应用");
      if (["tap","longpress","fill","type"].includes(step.action)) {
        const latest = await command(s, ["dump","ui"]);
        if (!Array.isArray(latest?.elements) || createHash("sha256").update(JSON.stringify(latest.elements)).digest("hex") !== s.fingerprint || await foreground() !== app)
          throw Object.assign(Error("当前画面已变化，请重新观察"), {code:"SCREEN_CHANGED"});
      }
      s.observed = "";
      const args = inputArgs(step);
      dispatched = true;
      await command(s, args);
      return { completed: true };
    } catch (error) {
      if (op === "step" && !dispatched) error.beforeDispatch = true;
      throw error;
    } finally { s.busy = false; renew(input.lease,s); }
  }
  return (input, signal) => requests.run(signal || AbortSignal.timeout(55000), () => call(input));
}
module.exports = { createDriver };
