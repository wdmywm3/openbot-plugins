"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const plugin = require("../plugins/android-roamer");
const { createDriver } = require("../plugins/android-roamer/device-driver.cjs");

async function fixture(root) {
  const adb = path.join(root, process.platform === "win32" ? "adb.exe" : "adb");
  await fs.writeFile(adb, "fixture");
  const states = new Map(), ops = [], calls = [], photos = new Map(), identities = new Map();
  const foregroundReplies = [], dumpReplies = [], actionTokens = [];
  let screenText = "Hello";
  const host = "127.0.0.1";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAHCAIAAACgB3uHAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQCV0FRwxU5QAAmiwf1RK0WHYAAAAASUVORK5CYII=", "base64");
  const run = async (file, args, options) => {
    if (file === "fixture-mobilecli") {
      ops.push(args);
      if (args.includes("foreground") && foregroundReplies.length) return { stdout: foregroundReplies.shift() };
      if (args.includes("dump") && dumpReplies.length) {
        const reply = dumpReplies.shift();
        const elements = typeof reply === "function" ? await reply(options.signal) : reply;
        return { stdout: JSON.stringify({ status: "ok", data: { elements } }) };
      }
      if (args.includes("tap") && screenText === "打开示例") screenText = "下一页";
      else if (args.includes("tap") && screenText === "下一页") screenText = "已到达";
      if (args.includes("screenshot")) return { stdout: png };
      const data = args.includes("list") ? {apps:[{packageName:"fixture.app",appName:"Fixture"}]} : args.includes("foreground") ? { packageName: "fixture.app" } : args.includes("dump") ? { elements: [{ text: screenText, identifier:"fixture:id/next", ref:"@e" + ops.length, coordinates:{x:1,y:2} }] } : {};
      return { stdout: JSON.stringify({ status: "ok", data }) };
    }
    assert.equal(file, adb);
    if (args[0] === "devices") return { stdout: [5557, 7555, 16384].map(port => host + ":" + port + " device").join("\n") };
    if (args[0] === "connect") return { stdout: "connected to " + args[1] };
    if (args.includes("get-state")) return { stdout: "device" };
    if (args.includes("screencap")) return { stdout: args[1].endsWith(":7555") ? Buffer.alloc(0) : png };
    if (args.includes("shell")) return { stdout: identities.get(args[1]) || args[1] };
    throw Error("Unexpected ADB invocation");
  };
  const dispatch = createDriver(root, { binary: "fixture-mobilecli", run, setupOptions: { ports: async () => [], probe: async () => false } });
  const ctx = { plugin:{id:"android-roamer",namespace:"instance-a"}, config: { useEnabled: true, allApps: true, maxSteps: 4 }, principal: { role:"owner", messageType:"private" },
    message:{ id:"owner-1", chatId:"owner" }, command:{ name:"phone" }, api: {
    callTool: async ({ arguments: args }, signal) => {
      calls.push(args.op);
      if (args.op === "step") actionTokens.push(args.observationId);
      const value = await dispatch(args, signal);
      const content = [];
      if (value.image) { content.push({ type:"image", mimeType:value.mimeType, data:value.image }); delete value.image; }
      return { content: [...content,{ type:"text",text:JSON.stringify(value) }] };
    },
    getState: async (key,scope) => structuredClone(states.get(scope + "/" + key)),
    getStateVersion: async (key,scope) => ({ value:structuredClone(states.get(scope + "/" + key)), version:JSON.stringify(states.get(scope + "/" + key)) }),
    compareAndSetState: async (key,revision,value,scope) => {
      if (JSON.stringify(states.get(scope + "/" + key)) !== revision) return { applied:false };
      states.set(scope + "/" + key, structuredClone(value)); return { applied:true };
    },
    setState: async (key,value,scope) => states.set(scope + "/" + key, structuredClone(value)),
    assets: async input => { const ref = "img-" + photos.size; photos.set(ref,"data:image/png;base64," + input.data); return {ref}; },
    listAgentResources: () => { throw Error("访问了宿主设备列表"); },
    generate: () => { throw Error("插件调用了模型"); },
    runAgent: () => { throw Error("插件启动了 Agent"); },
  } };
  const manage = input => plugin.deviceSettings({ ...ctx, principal:{source:"desktop",channelId:"test-instance"}, input });
  return { ctx, manage, ops, calls, photos, identities, adb, host, dispatch, foregroundReplies, dumpReplies, actionTokens, setScreen: value => { screenText = value; } };
}
async function verifyWait(f, deviceId) {
  const { setTimeout: delay } = require("node:timers/promises");
  const identifier = "fixture:id/next", app = "fixture.app", target = { app, identifier };
  const noDelay = async () => {};
  const watch = (options, sleep = noDelay, signal) => plugin.agentTool({ ...f.ctx, tool: "use", signal,
    api: { ...f.ctx.api, sleep, callTool: request => f.ctx.api.callTool(request, signal) },
    input: { deviceId, operation: "wait", waitFor: { ...target, ...options } } });
  const reads = () => f.calls.filter(op => op === "probe").length;
  const deviceInputs = () => f.ops.filter(args => args.includes("io")).length;
  const start = deviceInputs(), probes = reads();
  for (let i = 0; i < 11; i++) f.dumpReplies.push([{identifier: "clock", text: String(i)},
    {children: [{identifier, text: i === 10 ? "下载完成" : "下载中"}]}]);
  const matched = await watch({values: ["下载完成", "下载失败"]});
  assert.deepEqual([matched.status, matched.value, matched.checks, reads() - probes], ["matched", "下载完成", 11, 11]);
  assert(!("elements" in matched || "observationId" in matched));
  f.dumpReplies.push([{identifier, label:"下载中"}], [{identifier, label:"下载失败"}]);
  const changed = await watch({field:"label"});
  assert.deepEqual([changed.status, changed.value, changed.checks], ["changed", "下载失败", 2]);
  f.setScreen("下载失败");
  assert.equal((await watch({values:["下载失败"]})).checks, 1, "an already reached state completes on the first read");
  const label = {label:"报告.pdf"};
  f.dumpReplies.push([label, {identifier,text:"下载中"}], [{label:"另一份.pdf"}, {identifier,text:"下载完成"}]);
  await assert.rejects(watch({values:["下载完成"],anchorText:label.label}),
    e => e.code === "PHONE_WAIT_ANCHOR_MISSING" && e.message === "当前页面找不到指定的定位文字");
  for (const [elements, code, message] of [
    [[], "PHONE_CONTROL_MISSING", "当前页面找不到等待的控件"],
    [[{identifier, children:[{identifier}]}], "PHONE_CONTROL_AMBIGUOUS", "当前页面有多个同名控件"],
    [[{identifier}], "PHONE_CONTROL_FIELD_MISSING", "控件未返回指定文字字段"],
    [[{identifier, text:"x".repeat(1025)}], "PHONE_CONTROL_TOO_LONG", "控件文字超过 1024 个字符（1025 个字符）"],
  ]) {
    f.dumpReplies.push(elements);
    await assert.rejects(watch({}), e => e.code === code && e.message === message);
  }
  f.foregroundReplies.push(JSON.stringify({status:"ok",data:{packageName:"other.app"}}));
  await assert.rejects(watch({}), e => e.code === "PHONE_WAIT_APP_CHANGED" && e.message === "手机已离开指定应用");
  const expired = await watch({values:["未出现"],timeoutSeconds:1}, ms => delay(ms));
  assert.deepEqual([expired.status, expired.checks], ["timeout", 1]);
  const canceled = new AbortController(), beforeCancel = reads();
  await assert.rejects(watch({}, async () => canceled.abort(Error("用户已停止等待")), canceled.signal), /用户已停止等待/);
  assert.equal(reads(), beforeCancel + 1);
  const reading = new AbortController();
  f.dumpReplies.push(async signal => { reading.abort(Error("取消正在进行的读屏")); await delay(5000, null, {signal}); return []; });
  await assert.rejects(watch({}, noDelay, reading.signal), /取消正在进行的读屏/);
  await assert.rejects(watch({}, async () => { f.ctx.config.prohibitions = "更新规则"; }), e => e.code === "PHONE_WAIT_SCOPE_CHANGED");
  delete f.ctx.config.prohibitions;
  assert.equal(deviceInputs(), start);

  // A deadline inside a device read releases the lease. Read-only probes also leave an existing action token alone.
  const observe = () => plugin.agentTool({...f.ctx,tool:"use",input:{deviceId}});
  const view = await observe();
  f.dumpReplies.push(async signal => { await delay(5000, null, {signal}); return []; });
  const inFlight = await watch({values:["未出现"],timeoutSeconds:1});
  assert.deepEqual([inFlight.status, inFlight.checks], ["timeout", 0]);
  const stillThere = await watch({values:["下载失败"]});
  assert.equal(stillThere.status, "matched");
  const device = (await f.ctx.api.getState("bphone-devices-v1", "global")).find(row => row.deviceId === deviceId);
  const {lease} = await f.dispatch({op:"begin",binding:device,mode:"private",scope:"other-task",allApps:true});
  try {
    const afterBusy = await watch({values:["下载失败"]}, () => f.dispatch({op:"end",lease}));
    assert.equal(afterBusy.checks, 1, "only the one successful read counts after the other caller releases the device");
  } finally { await f.dispatch({op:"end",lease}).catch(() => {}); }
  const act = await plugin.agentTool({...f.ctx,tool:"act",input:{deviceId,action:"tap",x:1,y:2,observationId:view.observationId}});
  assert.equal(act.completed, true);
}
async function verifyScript(f, deviceId, evaluate) {
  const invoke = (code, options = {}, runScript = evaluate) => plugin.agentTool({
    ...f.ctx, tool:"script", input:{deviceId,code,...options},
    api:{ ...f.ctx.api, runScript: async request => {
      assert.deepEqual(request.capabilities, []);
      assert.ok(!Object.hasOwn(request.input.screen, "observationId"));
      return runScript(request);
    } }
  });
  const taps = () => f.ops.filter(args => args.includes("tap")).length;
  const code = `
    if (step === 0) return {tap:{text:"打开示例"},state:"opened"};
    if (step === 1 && state === "opened") return {tap:{text:"下一页",identifier:"fixture:id/next"}};
    return {done:screen.elements.some(el => el.text === "已到达")};
  `;
  const start = taps(), firstToken = f.actionTokens.length;
  for (let run=0; run<2; run++) {
    f.setScreen("打开示例");
    const result = await invoke(code);
    assert.equal(result.result, true);
    assert.equal(result.completedActions, 2);
    assert.ok(!JSON.stringify(result).includes("elements"));
  }
  const tokens = f.actionTokens.slice(firstToken);
  assert.equal(new Set(tokens).size, 4);
  assert.equal(taps(), start + 4);
  await assert.rejects(invoke(code), /已确认 0 次操作.*没有匹配的控件/);
  f.setScreen("打开示例");
  await assert.rejects(invoke(code, {maxActions:1}), /已确认 1 次操作.*1 次操作上限/);
  assert.equal(taps(), start + 5);
  f.setScreen("打开示例");
  await assert.rejects(invoke(code, {}, async req => {
    const result = await evaluate(req);
    if (req.input.step === 1) f.setScreen("意外页面");
    return result;
  }), /已确认 1 次操作.*画面已变化/);
  assert.equal(taps(), start + 6);
  await assert.rejects(invoke('return {act:{action:"home",observationId:"old"}}'), /无效的手机动作/);
  const read = await invoke('return {done:screen.elements[0].text}', {maxActions:0});
  assert.equal(read.result, "意外页面");
  assert.equal(read.completedActions, 0);
  const stopped = await invoke('return {stop:"预期页面未出现"}');
  assert.equal(stopped.reason, "预期页面未出现");
  assert.equal(stopped.status, "stopped");
}
module.exports = { fixture, verifyScript };
if (require.main === module) (async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-bphone-test-"));
  try {
    const f = await fixture(root);
    for (const [id, port] of [["first",5557],["second",16384]]) {
      const base = { deviceId:id, host:f.host, port, adbPath:f.adb };
      const scan = await f.manage({ ...base, op:"scan" });assert.deepEqual(scan.devices.map(row=>row.port),[5557,7555,16384]);
      const previews = [];
      for (const item of scan.devices) {
        const read = f.manage({ ...base, ...item, op:"preview" });
        if (item.port===7555) { await assert.rejects(read,/设备返回的截图为空/); continue; }
        previews.push([item.port,await read]);
      }
      const selected = previews.find(([p])=>p===port)[1];
      assert.match(selected.thumbnail,/^data:image\/jpeg;base64,/); assert.equal(f.photos.size,0);
      await assert.rejects(f.manage({op:"save",deviceId:"other",revision:0,token:selected.token}),/已失效/);
      await f.manage({op:"save",deviceId:id,revision:0,name:id,token:selected.token});
    }
    const {devices} = await f.manage({op:"list"});assert.equal(devices[0].isDefault,true);
    assert.ok(!JSON.stringify(devices).includes("base64"));
    assert.deepEqual((await plugin.agentTool({...f.ctx,tool:"status",input:{listDevices:true}})).devices.map(x=>x.deviceId),["first","second"]);
    const invoke = (tool, input, ctx = f.ctx) => plugin.agentTool({ ...ctx, tool, input:{ deviceId:"second", ...input } });
    const acquired = Promise.withResolvers(), release = Promise.withResolvers(), waiting = Promise.withResolvers();
    const withDriver = before => ({ ...f.ctx, api: { ...f.ctx.api, callTool: async request => {
      await before(request.arguments.op);
      return f.ctx.api.callTool(request);
    } } });
    const listApps = deviceId => ({ operation: "apps", deviceId });
    const held = invoke("use", listApps("first"), withDriver(async op => {
      if (op === "apps") { acquired.resolve(); await release.promise; }
    }));
    await acquired.promise;
    let usedSameDevice = false;
    const same = invoke("use", listApps("first"), withDriver(op => {
      if (op === "begin") waiting.resolve();
      if (op === "apps") usedSameDevice = true;
    }));
    try {
      await waiting.promise;
      assert.equal((await invoke("use", listApps("second"))).deviceId, "second");
      assert.equal(usedSameDevice, false);
    } finally { release.resolve(); await Promise.all([held, same]); }
    assert.equal(usedSameDevice, true);
    assert.deepEqual(new Set(f.ops.map(args => args[1])), new Set(["127.0.0.1:5557", "127.0.0.1:16384"]));
    const singleDeviceStart = f.ops.length;
    const observe = () => invoke("use", {goal:"读屏后滑动一次"});
    const swipe = { action:"swipe", x:1, y:2, toX:1, toY:6 };
    const firstView = await observe();
    assert.equal(firstView.elements[0].text,"Hello");
    assert.ok(!f.ops.some(args => args.includes("io")));
    assert.deepEqual(f.calls.slice(-3), ["begin","observe","end"]);
    const otherChat = { ...f.ctx, message:{ ...f.ctx.message, chatId:"other" } };
    await assert.rejects(invoke("act", {...swipe, observationId:firstView.observationId}, otherChat), /观察编号已失效/);
    const action = await invoke("act", { ...swipe, observationId:firstView.observationId });
    assert.equal(action.completed, true);
    await assert.rejects(invoke("act", {...swipe, observationId:firstView.observationId}), /观察编号已失效/);
    const stale = await observe(); f.setScreen("Changed");
    await assert.rejects(invoke("act", {...swipe, observationId:stale.observationId}), /画面已变化/);
    const beforePolicyChange = await observe();
    f.ctx.config.allApps = false; f.ctx.config.playApps = ["allowed.app"];
    await assert.rejects(invoke("act", {...swipe, observationId:beforePolicyChange.observationId}), /观察编号已失效/);
    const outside = await observe();
    assert.equal(outside.outside,true);
    assert.equal(outside.elements,undefined);
    await assert.rejects(invoke("act", {action:"launch", app:"other.app", observationId:outside.observationId}), /未获准使用/);
    f.ctx.config.allApps = true;
    const screenshot = await invoke("use",{operation:"screenshot"});
    assert.equal(screenshot.attachments[0].assetRef, "img-0");
    assert.ok(!JSON.stringify(screenshot).includes("base64"));
    assert.deepEqual((await invoke("use",{operation:"apps"})).apps,[["Fixture","fixture.app"]]);
    assert.equal((await invoke("resume",{})).elements[0].text,"Changed");
    assert.equal(f.ops.filter(args=>args.includes("io")).length,1);
    assert.ok(f.ops.slice(singleDeviceStart).every(args=>args[0]==="--device" && args[1]==="127.0.0.1:16384"));
    for (const [reply, message] of [[" ", "没有返回内容"], ["sensitive-content", "返回的内容不是有效 JSON"], ["{}", "未返回状态"],
      ['{"status":"ok","data":{}}'.padEnd(55) + "trailing", "返回的 JSON 后还有内容（第 1 行第 56 列）"]]) {
      f.foregroundReplies.push(reply);
      const start = f.ops.length;
      await assert.rejects(observe(), error => error.message === "设备命令 apps foreground " + message);
      assert.equal(f.ops.length, start + 1);
    }
    await verifyScript(f, "second", async request => {
      // Only the fixed test programs below run in this test VM.
      const sandbox = {module:{exports:{}}, input:request.input};
      return require("node:vm").runInNewContext(request.code + "\nmodule.exports.run({input})",sandbox,{timeout:1000});
    });
    await verifyWait(f, "second");
    f.setScreen("很长的标签".repeat(800));
    const large = await observe();
    assert.equal(large.truncated,true);
    assert.ok(large.elements[0].text.length <= 1024);
    f.identities.set("127.0.0.1:16384","replacement");const before=f.ops.length;
    await assert.rejects(observe(),/端口对应的手机已更换/);
    assert.equal(f.ops.length,before);
    await f.manage({op:"remove",deviceId:"second",revision:1});
    await assert.rejects(observe(),/没有找到该手机/);
    assert.equal(f.ops.length,before);
    const other = input => plugin.deviceSettings({ ...f.ctx,plugin:{id:"android-roamer",namespace:"instance-b"},principal:{source:"desktop",channelId:"beta"},input });
    await other({op:"list"});
    await f.manage({op:"transfer",deviceId:"first",revision:1,target:"instance-b"});
    assert.deepEqual((await f.manage({op:"list"})).devices,[]);
    assert.equal((await other({op:"detail",deviceId:"first"})).device.connection.port,5557);
    await assert.rejects(f.manage({op:"detail",deviceId:"first"}),/设备已移除/);
    await other({op:"update",deviceId:"first",revision:2,paused:true});
    await assert.rejects(plugin.agentTool({...f.ctx,plugin:{id:"android-roamer",namespace:"instance-b"},tool:"use",input:{deviceId:"first"}}),/设备已暂停/);
    await assert.rejects(other({op:"remove",deviceId:"first",revision:2}),/设备设置已变化/);
    await assert.rejects(plugin.deviceSettings({...f.ctx,input:{op:"list"}}),/设备页面/);
    console.log("bPhone: device setup, observation, single action, screenshot, transfer, pause, and read-only waits including cancellation, timeout and contention passed");
  } finally { await fs.rm(root,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1});
