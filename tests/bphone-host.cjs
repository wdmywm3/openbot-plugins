"use strict";
const { createRequire } = require("node:module");
const path = require("node:path"), fs = require("node:fs/promises"), os = require("node:os");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const { fixture } = require("./bphone-device-setup.cjs");
async function verifyHostActions(host, root, pkgDir) {
  const fs = require("node:fs"), { randomUUID } = require("node:crypto");
  const { createPluginCommands } = host("./electron/lib/commands/extensions/plugin-commands.cjs");
  const { createChannelPluginRegistryService } = host("./electron/lib/features/channels/channel-plugin-registry-service.cjs");
  const { createChannelPluginRuntimeService, shutdownPluginWorkers } = host("./electron/lib/features/channels/channel-plugin-runtime-service.cjs");
  const { createExternalMcpService } = host("./electron/lib/features/mcp-external-service.cjs");
  const { createPluginToolService } = host("./electron/lib/plugins/plugin-tools.cjs");
  const channels = ["alpha","beta"].map(id=>({ id, name:id, platform:"qq",enabled:true,config:{provider:"napcat-onebot",ownerUsers:["101"]} }));
  const store = { root,data:{channels,settings:{},sessions:[],mcps:[]},save(){},async flush(){} };
  const array = key => store.data[key] ||= [];
  const resolveChannel = id => channels.find(c=>c.id===id);
  const registry = createChannelPluginRegistryService({fs,path,store,ensureStoreArray:array,getCommands:()=>({}),getChatOverride:()=>({}),profileList:v=>v||[]});
  const installer = createPluginCommands({fs,path,getStore:()=>store,ensureStoreArray:array,getCommands:()=>({})});
  const mcp = createExternalMcpService({ getStore:()=>store,getPlugins:(id,chat,ctx)=>registry.botPluginsFor(resolveChannel(id),chat,ctx),
    secretStore:{encryptSecret:v=>v,hydrateSecretMap:v=>v} });
  const pluginTools = createPluginToolService({entries:()=>store.data.mcps,request:(...args)=>mcp.request(...args),allowedTools:async()=>[]});
  const runtime = createChannelPluginRuntimeService({fs,path,store,ensureStoreArray:array,resolveChannel,pluginTools,botPluginsFor:registry.botPluginsFor,
    getPluginState:registry.getPluginState,setPluginState:registry.setPluginState,pluginStateScopeId:registry.pluginStateScopeId,
    makeId:prefix=>prefix+"-"+randomUUID(),safeError:e=>e.message,isNapCatOneBotChannel:()=>true});
  try {
    const installed = await installer.importPluginFromPath({pluginPath:pkgDir});
    await installer.authorizePlugin({pluginId:installed.id,fingerprint:installed.authorization.fingerprint,approved:true});
    await mcp.startPlugin(installed.id);
    const invoke = (channel,input) => {
      const plugin = registry.botPluginsFor(channel).find(item=>item.id===installed.id);
      return runtime.runPluginAction(channel,plugin,plugin.actions.find(action=>action.id==="devices"),input);
    };
    const a = await invoke(channels[0],{op:"list"}), b = await invoke(channels[1],{op:"list"});
    assert.deepEqual(a.devices,[]); assert.notEqual(a.owner,b.owner);
    assert.equal(b.instances[a.owner],"alpha");
    await assert.rejects(invoke(channels[0],{op:"save",deviceId:"fake",revision:0,token:"expired"}),/设备截图已失效/);
  } finally {
    await mcp.close(); await runtime.stopAllPluginPolls(); shutdownPluginWorkers(); await installer._pausePluginPreparation();
  }
}
async function main() {
  const host = createRequire(path.resolve(process.argv[2] || process.env.OPENBOT_HOST_ROOT,"package.json"));
  const pkgDir = path.resolve(__dirname,"../plugins/android-roamer");
  const pkg = host("./electron/lib/plugins/plugin-package.cjs").readPluginPackage(pkgDir);
  const { validateInput } = host("./electron/lib/plugins/plugin-agent-bridge.cjs");
  const { chromium } = host("playwright");
  const { Client } = host("@modelcontextprotocol/client");
  const { StdioClientTransport } = host("@modelcontextprotocol/client/stdio");
  const { prepareEnvironment, resolveLaunch } = host("./electron/lib/plugins/plugin-environment.cjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"bphone-plugin-ui-"));
  const client = new Client({ name:"binding-smoke",version:"1" });
  let browser;
  try {
    const plugin = { id:pkg.manifest.id, basePath:pkgDir, dependencies:pkg.manifest.dependencies };
    await prepareEnvironment(root, plugin);
    const server = pkg.mcpServers.find(s=>s.name==="phone");
    assert.deepEqual(server.enabled_tools,[]); assert.deepEqual(server.native_tools,["bphone_device"]);
    const resolved = resolveLaunch({ id:"fixture", pluginId:plugin.id, pluginRoot:pkgDir, pluginDependencies:plugin.dependencies,
      command:server.command,args:server.args.map(arg=>arg.replace("${PLUGIN_ROOT}",pkgDir).replace("${PLUGIN_DATA}",root)) },root);
    assert.ok(resolved.command.includes("runtime"));
    assert.notEqual(resolved.pluginRoot,pkgDir);
    await fs.access(path.join(resolved.pluginRoot,"node_modules/@mobilenext/mobilecli-windows-amd64/mobilecli-windows-amd64.exe"));
    const transport = new StdioClientTransport({ command:resolved.command, args:resolved.args,
      env:{PATH:"",SystemRoot:process.env.SystemRoot} });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools[0].name,"bphone_device");
    const rejected = await client.callTool({name:"bphone_device",arguments:{op:"confirm",deviceId:"unknown",token:"stale"}});
    assert.ok(rejected.isError);assert.match(rejected.content[0].text,/设备截图已失效/);
    await verifyHostActions(host, root, pkgDir);
    const f = await fixture(root);
    browser = await chromium.launch();
    const page = await browser.newPage(), alerts = [];
    await page.exposeFunction("invokeAction",async(action,input)=>{
      assert.equal(action,"devices");
      validateInput(pkg.manifest.actions.find(a=>a.id===action).inputSchema,input);
      return f.manage(input);
    });
    await page.exposeFunction("notice",msg=>alerts.push(msg));
    await page.addInitScript(()=>{
      window.openbotPlugin={callAction:(...args)=>window.invokeAction(...args),notify:msg=>window.notice(msg),
        assetUrl:()=> "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKLsAAAAASUVORK5CYII=",ui:{confirm:async()=>true}};
    });
    await page.goto(pathToFileURL(path.join(pkgDir,pkg.manifest.ui.views[0].entry)).href);
    await page.locator("#adb").fill(f.adb); await page.locator("#scan").click();
    await page.waitForFunction(()=>document.querySelectorAll("li img").length===2 && !document.querySelector("#scan").disabled);
    const row=page.locator("li button").filter({hasText:"127.0.0.1:16384"});
    assert.ok((await row.locator("img").boundingBox()).x > (await row.locator("span").boundingBox()).x);
    assert.ok((await page.locator("#save").boundingBox()).y < (await row.boundingBox()).y);
    assert.match(await page.locator("li").filter({hasText:"127.0.0.1:7555"}).textContent(),/设备返回的截图为空/);
    await row.click(); await page.locator("#save").click();
    await page.waitForFunction(()=>!document.querySelector("#options").hidden);
    const saved = (await f.manage({op:"list"})).devices[0];
    assert.equal((await f.manage({op:"detail", deviceId:saved.deviceId})).device.connection.port,16384);
    assert.ok(alerts.includes("设备连接已保存"));
    console.log("bPhone: OpenBot package schema, bundled Node with empty PATH, real MCP handshake, Chromium scan/preview/selection/save passed");
  } finally {
    await browser?.close(); await client.close(); await fs.rm(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
