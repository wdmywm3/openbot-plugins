"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const root = path.join(__dirname, "../plugins/android-roamer");
const manifest = require(path.join(root, "plugin.json")).extensions["com.openbot"];
function load() {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "index.js"), "utf8"), sandbox);
  return sandbox.module.exports;
}
function fixture() {
  const devices = [{ owner:"namespace", deviceId:"phone-one", name:"自己的手机", key:"phone-key", isDefault:true,
    deviceRevision:1, connection:{host:"127.0.0.1",port:16384} }];
  const states = new Map([["global:bphone-devices-v1",devices]]), calls = [];
  const ctx = { plugin:{id:"android-roamer",namespace:"namespace"}, config:{useEnabled:true, allApps:true},
    principal:{role:"owner",messageType:"private",senderId:"owner"}, message:{chatId:"private-owner"}, input:{},
    api:{
      generate(){ throw Error("unexpected model call"); }, runAgent(){ throw Error("unexpected agent call"); },
      getState:async(key,scope)=>structuredClone(states.get(scope+":"+key)),
      setState:async(key,value,scope)=>states.set(scope+":"+key,structuredClone(value)),
      callTool:async({arguments:args})=>{
        calls.push(structuredClone(args));
        const result = args.op==="begin" ? {lease:"lease"} : args.op==="observe" ? {screen:"screen",observationId:"seen"} : {};
        return {content:[{type:"text",text:JSON.stringify(result)}]};
      },
    } };
  return {ctx,calls,devices,states};
}
module.exports = {fixture,load};
if (require.main === module) (async () => {
  const plugin = load(), f = fixture();
  assert.equal(manifest.background, undefined);
  assert.equal(plugin.poll, undefined);
  assert.ok(!manifest.permissions.includes("model"));
  for (const name of ["phone","roam","phoneresume"]) {
    assert.equal(manifest.commands.find(command => command.name === name).responseMode, "agent");
    const handoff = await plugin.handle({...f.ctx, command:{name}, args:"--device phone-one 观察画面"});
    assert.match(handoff.agent.content,/观察画面/);
    assert.match(handoff.agent.content,/phone-one/);
    assert.equal(handoff.agent.modelId,undefined);
    assert.equal(handoff.agent.agentId,undefined);
  }
  assert.equal(f.calls.length,0);
  assert.deepEqual(manifest.tools.map(t=>t.name), ["use","act","script","status","resume","record","learning","revise_learning"]);
  const run = (tool,input={}) => plugin.agentTool({...f.ctx,tool,input});
  assert.equal((await run("use",{goal:"读屏，操作一次"})).observationId,"seen");
  assert.deepEqual(f.calls.map(row=>row.op),["begin","observe","end"]);
  await assert.rejects(run("use",{operation:"step"}),/未知手机操作/);
  await assert.rejects(run("act",{action:"tap"}),/需要观察编号/);
  f.ctx.config.useEnabled=false;
  await assert.rejects(run("use"),/手机按需使用已关闭/);
  await run("resume",{private:true});
  f.ctx.principal.role="member";
  await assert.rejects(run("resume"),/仅限主人/);
  await assert.rejects(run("use",{private:true}),/仅限主人/);
  await assert.rejects(run("status",{private:true}),/私人手机任务/);
  f.ctx.config.useEnabled=true;
  f.devices[0].paused=true;
  await assert.rejects(run("use"),/设备已暂停/);
  assert.equal(f.calls.filter(row=>row.op==="step").length,0);
  f.devices[0].paused=false;
  f.devices[0].isDefault=false;
  f.devices.push({...f.devices[0],deviceId:"other"});
  await assert.rejects(run("use"),/请指定手机/);
  assert.equal((await run("status",{listDevices:true})).total,2);
  const context = await plugin.context({...f.ctx,hook:{enabledTools:["useSkill"]}});
  assert.ok(context.content.includes("act"));
  assert.ok(!context.content.includes("127.0.0.1"));
  console.log("bPhone atomic tool routing, legacy observation, device selection and owner-private scope passed");
})().catch(e=>{console.error(e);process.exitCode=1;});
