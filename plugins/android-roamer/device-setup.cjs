"use strict";

const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID, createHash } = require("node:crypto");
const execute = promisify(execFile);
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const COMMON_PORTS = [5555, 5557, 5559, 5561, 62001, 7555, ...Array.from({ length: 16 }, (_, i) => 16384 + i * 32)];

function normalizeConnection(value = {}) {
  let host = String(value.host || "127.0.0.1").trim().toLowerCase();
  if (["localhost", "本地", "本机"].includes(host)) host = "127.0.0.1";
  const n = host.split(".").map(Number);
  if (!net.isIPv4(host) || !(n[0] === 127 || n[0] === 10 || n[0] === 192 && n[1] === 168 || n[0] === 172 && n[1] >= 16 && n[1] <= 31)) {
    throw new Error("请填写本机或局域网 IPv4 地址，例如 127.0.0.1 或 192.168.1.20");
  }
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("设备端口须为 1 到 65535 的整数");
  if (port === 5037) throw new Error("5037 是 ADB 服务端口，请填写设备端口");
  return { host, port, adbPath: String(value.adbPath || "").trim() };
}

const adbName = process.platform === "win32" ? "adb.exe" : "adb";
async function runningAndroidPrograms(run) {
  if (process.platform !== "win32") return [];
  const command = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const names = "adb,emulator,qemu-system-x86_64,qemu-system-aarch64,MuMuNxMain,MuMuNxService,MuMuNxHeadless,MuMuPlayer,MuMuVMMHeadless,NemuPlayer,dnplayer,LdVBoxHeadless,Nox,NoxVMHandle,HD-Player";
  const { stdout } = await run(command, ["-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Process -Name " + names + " -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }; exit 0"],
    { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  return String(stdout).split(/\r?\n/).map(item => item.trim()).filter(item => path.isAbsolute(item));
}
async function findAdb(preferred = "", env = process.env, running = () => runningAndroidPrograms(execute)) {
  const exists = async file => {
    try { return (await fs.promises.stat(file)).isFile(); }
    catch (error) { if (["ENOENT","ENOTDIR"].includes(error.code)) return false; throw error; }
  };
  if (preferred) {
    if (!path.isAbsolute(preferred) || path.basename(preferred).toLowerCase() !== adbName)
      throw new Error(`请选择已安装的 ${adbName}`);
    if (!await exists(preferred)) throw Error("所选 ADB 路径没有可执行文件");
    return path.resolve(preferred);
  }
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Android", "Sdk")]
    .filter(Boolean).map(root => path.join(root, "platform-tools", adbName));
  for (const dir of String(env.PATH || env.Path || "").split(path.delimiter)) {
    if (path.isAbsolute(dir)) candidates.push(path.join(dir, adbName));
  }
  for (const file of new Set(candidates)) if (await exists(file)) return path.resolve(file);
  const programs = await running().catch(() => []);
  const nearby = new Set();
  for (const program of programs) {
    const dir = path.dirname(program);
    if (path.basename(program).toLowerCase() === adbName) nearby.add(program);
    for (const relative of [".", "shell", "../shell", "../platform-tools", "../../platform-tools", "../../../platform-tools"])
      nearby.add(path.resolve(dir, relative, adbName));
  }
  if (process.platform === "win32") {
    for (const root of [env.ProgramW6432, env.ProgramFiles]) {
      if (root && path.isAbsolute(root)) nearby.add(path.join(root, "Netease", "MuMu", "nx_main", adbName));
    }
  }
  for (const file of nearby) if (await exists(file)) return file;
  throw new Error(`没有找到 ADB，请选择已安装的 ${adbName}`);
}

async function adbRun(adbPath, args, run = execute) {
  try {
    return (await run(adbPath, args, { windowsHide: true, timeout: 12000, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" })).stdout;
  } catch (error) {
    if (error.name === "AbortError") throw Error("设备操作已取消");
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw Error("ADB 输出超过 8 MiB");
    if (error.code === "ENOENT") throw new Error("找不到 ADB，请重新选择路径");
    throw new Error(error.killed ? "ADB 操作超时" : `ADB 操作失败（${error.code ?? "未知状态"}）`);
  }
}
async function connectAdb(connection, run = execute) {
  const c = normalizeConnection(connection), adbPath = await findAdb(c.adbPath);
  let serial = `${c.host}:${c.port}`;
  const emulator = "emulator-" + (c.port - 1);
  const listed = c.host.startsWith("127.") && c.port % 2 === 1
    ? String(await adbRun(adbPath, ["devices", "-l"], run)) : "";
  if (listed.split(/\r?\n/).some(line => line.split(/\s+/)[0] === emulator && line.split(/\s+/)[1] === "device")) serial = emulator;
  else {
    const message = String(await adbRun(adbPath, ["connect", serial], run)).trim();
    if (!/^(?:already )?connected to /i.test(message)) throw new Error(message || "设备连接失败，请检查地址、端口和模拟器的 ADB 设置");
  }
  const state = String(await adbRun(adbPath, ["-s", serial, "get-state"], run)).trim();
  if (state !== "device") throw new Error(`设备未就绪（${state}），请检查模拟器是否已启动并允许调试`);
  return { ...c, adbPath, serial };
}
function probeAdbPort(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(750);
    socket.once("connect", () => {
      const body = Buffer.from("host::\0"), header = Buffer.alloc(24), command = 0x4e584e43; // CNXN
      header.writeUInt32LE(command); header.writeUInt32LE(0x01000000, 4); header.writeUInt32LE(4096, 8);
      header.writeUInt32LE(body.length, 12); header.writeUInt32LE(body.reduce((sum, byte) => sum + byte, 0), 16);
      header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
      socket.write(Buffer.concat([header, body]));
    });
    let received = Buffer.alloc(0);
    socket.on("data", data => {
      received = Buffer.concat([received, data]);
      if (received.length < 24) return;
      const command = received.readUInt32LE(0);
      finish([0x4e584e43, 0x48545541].includes(command) && received.readUInt32LE(20) === ((command ^ 0xffffffff) >>> 0));
    });
    socket.once("timeout", () => finish(false)); socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
  });
}
async function localPorts(run = execute) {
  if (process.platform !== "win32") return [];
  const { stdout } = await run("netstat.exe", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  return String(stdout).split(/\r?\n/).flatMap(line => {
    const m = /^\s*TCP\s+(?:127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::\]):(\d+)\s+\S+\s+LISTENING\b/i.exec(line);
    return m && Number(m[1]) !== 5037 ? [Number(m[1])] : [];
  });
}
async function identify(c, run = execute) {
  const read = async args => String(await adbRun(c.adbPath, ["-s", c.serial, "shell", ...args], run)).trim();
  const model = await read(["getprop", "ro.product.model"]);
  const androidId = await read(["settings", "get", "secure", "android_id"]);
  const hardware = await read(["getprop", "ro.serialno"]);
  if ((!androidId || androidId === "null") && (!hardware || hardware === "unknown")) throw Error("设备未返回稳定标识，无法确认绑定");
  const identity = androidId && androidId !== "null" ? `${androidId}:${hardware}` : hardware;
  const key = `android-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
  return { key, model };
}
function createDeviceSetup({ run = execute, resolveAdb = findAdb, probe = probeAdbPort, ports = localPorts, now = Date.now, assertIdle = () => {} } = {}) {
  const proofs = new Map(), busy = new Set(), scans = new Map();
  function invalidate(channelId, deviceId, endpoint) {
    for (const [token, proof] of proofs) {
      if (proof.expires <= now() || (proof.channelId === channelId && proof.deviceId === deviceId &&
        (!endpoint || (proof.connection.host === endpoint.host && proof.connection.port === endpoint.port)))) proofs.delete(token);
    }
  }
  async function exclusive(channelId, action) {
    if (busy.has(channelId)) throw new Error("正在检查设备，请等待当前操作结束");
    busy.add(channelId);
    try { return await action(); } finally { busy.delete(channelId); }
  }
  return {
    async scan(channelId, input) {
      return exclusive(channelId, async () => {
        const c = normalizeConnection({ ...input, port: input.port || 5555 });
        invalidate(channelId, input.deviceId);
        const scanId = JSON.stringify([channelId, input.deviceId]);
        scans.delete(scanId);
        for (const [id, scan] of scans) if (scan.expires <= now()) scans.delete(id);
        if (scans.size >= 32) throw Error("同时有效的扫描已达 32 次，请稍后重试");
        let adbPath = "", listed = "", adbWarning = "";
        try {
          adbPath = await resolveAdb(c.adbPath);
          listed = String(await adbRun(adbPath, ["devices", "-l"], run));
        } catch (error) {
          if (c.adbPath) throw error;
          adbWarning = error.message;
        }
        const known = listed.split(/\r?\n/).flatMap(line => {
          const local = /^emulator-(\d+)\s+device(?:\s|$)/.exec(line);
          if (local && c.host.startsWith("127.") && Number(local[1]) < 65535) return [Number(local[1]) + 1];
          const m = /^(\d+\.\d+\.\d+\.\d+):(\d+)\s+device(?:\s|$)/.exec(line);
          return m && m[1] === c.host ? [Number(m[2])] : [];
        });
        const candidates = [...new Set([...known, c.port, ...(c.host.startsWith("127.") ? [...COMMON_PORTS, ...await ports(run).catch(() => [])] : [])])].filter(port => port !== 5037);
        const reachable = [];
        for (let i = 0; i < candidates.length; i += 12) {
          await Promise.all(candidates.slice(i, i + 12).map(async port => { if (known.includes(port) || await probe(c.host, port)) reachable.push(port); }));
        }
        // Probe the ADB protocol; do not list unrelated web/database ports or bind a device during discovery.
        if (!reachable.length && adbWarning) throw new Error(adbWarning);
        scans.set(scanId, { host: c.host, ports: new Set(reachable), adbPath, expires: now() + 600000 });
        return { adbPath, ...(adbWarning ? { adbWarning } : {}), devices: reachable.sort((a, b) => a - b).map(port => ({ host: c.host, port, connected: known.includes(port) })) };
      });
    },
    async test(channelId, deviceId, input) {
      return exclusive(channelId, async () => {
        if (typeof deviceId !== "string" || !deviceId.trim()) throw new Error("缺少设备标识");
        const endpoint = normalizeConnection(input), scan = scans.get(JSON.stringify([channelId, deviceId]));
        if (!scan || scan.expires <= now() || scan.host !== endpoint.host || !scan.ports.has(endpoint.port) || scan.adbPath !== endpoint.adbPath) throw Error("端口不在本次扫描结果中，请重新扫描");
        invalidate(channelId, deviceId, endpoint);
        assertIdle(input);
        const c = await connectAdb(input, run);
        const { key, model } = await identify(c, run);
        assertIdle({ ...c, key });
        const screenshot = Buffer.from(await adbRun(c.adbPath, ["-s", c.serial, "exec-out", "screencap", "-p"], run));
        if (!screenshot.length) throw Error("设备返回的截图为空");
        if (screenshot.length < 24 || !screenshot.subarray(0, 8).equals(PNG)) throw Error("设备没有返回有效截图");
        const token = randomUUID();
        proofs.set(token, { channelId, deviceId, connection: { host: c.host, port: c.port, adbPath: c.adbPath }, serial: c.serial, key, model, expires: now() + 10 * 60 * 1000 });
        return { token, model, serial: c.serial, adbPath: c.adbPath, screenshot: `data:image/png;base64,${screenshot.toString("base64")}` };
      });
    },
    async verifiedBinding(channelId, deviceId, token) {
      return exclusive(channelId, async () => {
        const proof = proofs.get(token);
        if (!proof || proof.channelId !== channelId || proof.deviceId !== deviceId || proof.expires <= now()) throw new Error("设备截图已失效，请重新扫描");
        assertIdle({ ...proof.connection, key: proof.key });
        const { connection, key, model, serial } = proof;
        invalidate(channelId, deviceId);
        return { connection, key, model, serial };
      });
    },
  };
}
module.exports = { createDeviceSetup, findAdb, normalizeConnection, connectAdb, identify };
