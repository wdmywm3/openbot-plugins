"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const plugin = require("../plugins/android-roamer");
const { createDriver } = require("../plugins/android-roamer/device-driver.cjs");

async function fixture(root) {
  const adb = path.join(root, process.platform === "win32" ? "adb.exe" : "adb");
  await fs.writeFile(adb, "fixture");
  const states = new Map(), ops = [], calls = [], photos = new Map(), identities = new Map();
  const host = "127.0.0.1";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKLsAAAAASUVORK5CYII=", "base64");
  const run = async (file, args) => {
    if (file === "fixture-mobilecli") {
      ops.push(args);
      const data = args.includes("foreground") ? { packageName: "fixture.app" } : args.includes("dump") ? { elements: [{ text: "Hello" }] } : {};
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
  const model = [{ action: "tap", x: 1, y: 2 }, { report: "已确认", activity: {} }];
  const ctx = { plugin:{id:"android-roamer",namespace:"instance-a"}, config: { useEnabled: true, allApps: true, maxSteps: 4 }, principal: { role:"owner", messageType:"private" },
    message:{ id:"owner-1", chatId:"owner" }, command:{ name:"phone" }, api: {
    callTool: async ({ arguments: args }) => {
      calls.push(args.op);
      const value = await dispatch(args);
      const content = [];
      if (value.screenshot) { content.push({ type:"image", mimeType:"image/png", data:value.screenshot.split(",")[1] }); delete value.screenshot; }
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
    generate: async () => ({ text: JSON.stringify(model.shift()) }),
  } };
  const manage = input => plugin.deviceSettings({ ...ctx, principal:{source:"desktop",channelId:"test-instance"}, input });
  return { ctx, manage, ops, calls, photos, identities, adb, host, model, dispatch };
}
module.exports = { fixture };
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
      assert.ok(f.photos.has(selected.ref));
      await assert.rejects(f.manage({op:"save",deviceId:"other",revision:0,token:selected.token}),/已失效/);
      await f.manage({op:"save",deviceId:id,revision:0,name:id,token:selected.token});
    }
    const {devices} = await f.manage({op:"list"});assert.equal(devices[0].isDefault,true);
    assert.ok(!JSON.stringify(devices).includes("base64"));
    assert.deepEqual((await plugin.agentTool({...f.ctx,tool:"status",input:{listDevices:true}})).devices.map(x=>x.deviceId),["first","second"]);
    assert.match(await plugin.handle({...f.ctx,args:"--device second 测试"}),/已确认/);
    assert.ok(f.ops.some(args=>args.includes("tap")));
    assert.ok(f.ops.every(args=>args[0]==="--device" && args[1]==="127.0.0.1:16384"));
    f.identities.set("127.0.0.1:16384","replacement");const before=f.ops.length;
    assert.match(await plugin.handle({...f.ctx,args:"--device second 再测试"}),/端口对应的手机已更换/);
    assert.equal(f.ops.length,before);
    await f.manage({op:"remove",deviceId:"second",revision:1});
    await assert.rejects(plugin.handle({...f.ctx,args:"--device second 测试"}),/没有找到该手机/);
    assert.equal(f.ops.length,before);
    const other = input => plugin.deviceSettings({ ...f.ctx,plugin:{id:"android-roamer",namespace:"instance-b"},principal:{source:"desktop",channelId:"beta"},input });
    await other({op:"list"});
    await f.manage({op:"transfer",deviceId:"first",revision:1,target:"instance-b"});
    assert.deepEqual((await f.manage({op:"list"})).devices,[]);
    assert.equal((await other({op:"detail",deviceId:"first"})).device.connection.port,5557);
    await assert.rejects(f.manage({op:"detail",deviceId:"first"}),/设备已移除/);
    await other({op:"update",deviceId:"first",revision:2,paused:true});
    await assert.rejects(plugin.handle({...f.ctx,plugin:{id:"android-roamer",namespace:"instance-b"},args:"--device first 测试"}),/设备已暂停/);
    await assert.rejects(other({op:"remove",deviceId:"first",revision:2}),/设备设置已变化/);
    await assert.rejects(plugin.deviceSettings({...f.ctx,input:{op:"list"}}),/设备页面/);
    console.log("bPhone public actions and /phone: partial scan, two bindings, second-device-only UI commands, swapped and removed devices passed");
  } finally { await fs.rm(root,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1});
