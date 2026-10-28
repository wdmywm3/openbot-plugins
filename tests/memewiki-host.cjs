"use strict";
// Host path is supplied only to this development test, never to the package.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createRequire } = require("node:module"), { randomUUID, createHash } = require("node:crypto");
const host = process.argv[2];
if (!host) throw new Error("Usage: node tests/memewiki-host.cjs <OpenBot checkout>");
const h = createRequire(path.resolve(host, "package.json"));
const { Client } = h("@modelcontextprotocol/client"), { StdioClientTransport } = h("@modelcontextprotocol/client/stdio");
const { readPluginPackage } = h("./electron/lib/plugins/plugin-package.cjs");
const { createPluginToolService } = h("./electron/lib/plugins/plugin-tools.cjs");
const { mcpModelToolName } = h("./electron/lib/tools/mcp-tool-name.cjs");
const { createPluginDataStore } = h("./electron/lib/plugins/plugin-data-store.cjs");
const { createChannelPluginRuntimeService, shutdownPluginWorkers } = h("./electron/lib/features/channels/channel-plugin-runtime-service.cjs");
const { validateCatalog } = h("./electron/lib/plugins/plugin-catalog.cjs");
const source = path.resolve(__dirname, "../plugins/memewiki"), pkg = readPluginPackage(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memewiki-host-"));
const python = process.env.MEMEWIKI_TEST_PYTHON || path.resolve(__dirname, "../.venv-verify/Scripts/python.exe");
const client = new Client({ name: "memewiki-test", version: "1" }, { capabilities: {} });
let runtime;
async function main() {
  assert.equal(pkg.manifest.id, "memewiki");
  const files = fs.readdirSync(source, { recursive: true }).filter(f => fs.statSync(path.join(source, f)).isFile()).map(f => {
    const bytes = fs.readFileSync(path.join(source, f));
    return { path: f.replaceAll("\\", "/"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  assert.equal(validateCatalog({ schemaVersion: 1, plugins: [{ ...pkg.manifest, ref: "a".repeat(40), files }] }).length, 1);
  const server = pkg.mcpServers[0];
  await client.connect(new StdioClientTransport({ command: python, args: server.args.map(s => s.replaceAll("${PLUGIN_ROOT}", source).replaceAll("${PLUGIN_DATA}", path.join(root, "mcp"))), env: { ...process.env, ...server.env }, stderr: "pipe" }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 4);
  const plugin = { ...pkg.manifest, type: "js-plugin", enabled: true, basePath: source, scriptPath: pkg.scriptPath, config: { ...pkg.manifest.config, replyMode: "text", online: false } };
  plugin.commands = plugin.commands.map(command=>({...command,prefixes:plugin.commandPrefixes,aliases:[]}));
  const channel = { id: "bot", name: "Test", enabled: true, connected: true, config: { ownerUsers: ["owner"], toolConfig: { enabledTools: ["plugin"] } } };
  const entry = { id: "dictionary", name: "Dictionary", channelId: "bot", pluginId: "memewiki", pluginServer: "dictionary", pluginOwnerKey: "test", mcpType: "stdio", enabled: true };
  let allow = true;
  const service = createPluginToolService({ entries: () => [entry], allowedTools: async () => allow ? tools.map(t => mcpModelToolName(entry, t.name)) : [],
    request: async (_id, method, params) => method === "tools/list" ? client.listTools() : client.callTool(params) });
  const data = createPluginDataStore({ rootFor: (channelId, pluginId) => path.join(root, channelId, pluginId) });
  const states = new Map(), key = (c,p,s,id,k) => JSON.stringify([c.id,p,s,id,k]);
  const store = { root, data: { channels: [channel], plugins: [] }, save() {} };
  const replies = [], events = [];
  runtime = createChannelPluginRuntimeService({ fs, path, store, ensureStoreArray: key => store.data[key] ||= [], makeId: () => randomUUID(), safeError: String,
    resolveChannel: () => channel, botPluginsFor: () => [plugin], isNapCatOneBotChannel: () => true,
    pluginData: data, pluginTools: service,
    getPluginState: (...args) => states.get(key(...args)), setPluginState: (c,p,s,id,k,v) => states.set(key(c,p,s,id,k),v),
    pluginStateScopeId: (c,scope,message) => scope === "channel" ? c.id : message.chatId,
    publishConversationEvent: async value => { events.push(value); return { accepted: true }; },
    replyToMentionedMessageId: () => "", sendChannelSystemReply: async (_c,chat,text) => replies.push({ chat,text }), sendChannelRuleReply: async (_c,chat,segments) => replies.push({ chat,segments }) });
  const principal = { source: "channel", channelId: "bot", chatId: "onebot:group:1", senderId: "owner", role: "owner", messageType: "group" };
  async function command(content, chatId=principal.chatId, role="owner") {
    const senderId = role === "owner" ? "owner" : "member";
    const actor = { ...principal,chatId,senderId,role };
    const message = { id: randomUUID(), chatId, content, messageType: "group", sender: { id: senderId,role:"member" }, channelPrincipal: actor };
    const before = replies.length;
    assert.equal(runtime.handleBotPluginMessage(channel, message, actor, {}), true, content);
    const end = Date.now()+10000;
    while(replies.length === before && Date.now()<end) await new Promise(r=>setTimeout(r,15));
    assert.equal(replies.length,before+1, content);
    return replies.at(-1);
  }
  assert.match((await command("/梗 大水理论")).text,/长安二求/);
  assert.match((await command("/黑话 蓝鲸暗号 测试私有含义")).text,/已保存/);
  assert.match((await command("/梗 蓝鲸暗号")).text,/测试私有含义/);
  assert.match((await command("/黑话 蓝鲸蓝鲸 重复词条原名")).text,/已保存/);
  assert.match((await command("/梗 蓝鲸蓝鲸")).text,/重复词条原名/);
  assert.doesNotMatch((await command("/梗 蓝鲸暗号","onebot:group:2")).text,/测试私有含义/);
  assert.match((await command("/黑话 蓝鲸暗号 篡改",principal.chatId,"member")).text,/管理员/);
  assert.match((await command("/黑话 删除 蓝鲸暗号",principal.chatId,"member")).text,/管理员/);
  assert.match((await command("/网搜 off")).text,/off/);
  const action = id => plugin.actions.find(a=>a.id===id);
  await runtime.runPluginAction(channel,plugin,action("save_term"),{name:"实例词条",meaning:"实例共享含义",revision:0});
  const listed = await runtime.runPluginAction(channel,plugin,action("list_terms"),{});
  assert.equal(listed.records[0].key,"实例词条");
  await assert.rejects(runtime.runPluginAction(channel,plugin,action("save_term"),{name:"实例词条",meaning:"过时修改",revision:0}),/改变|版本/);
  assert.match((await command("/梗 实例词条","onebot:group:2")).text,/实例共享含义/);
  await runtime.runPluginBeforeMessage(channel,{id:"input-1",chatId:principal.chatId,content:"大水理论是什么梗",sender:{id:"owner"},messageType:"group"},principal);
  assert.equal(events.length,1); assert.match(JSON.stringify(events[0]),/长安二求/);
  await runtime.runPluginBeforeMessage(channel,{id:"input-2",chatId:principal.chatId,content:"你今天怎么样",sender:{id:"owner"},messageType:"group"},principal);
  assert.equal(events.length,1);
  allow=false;
  await runtime.runPluginBeforeMessage(channel,{id:"input-3",chatId:principal.chatId,content:"大水理论",sender:{id:"owner"},messageType:"group"},principal);
  assert.equal(events.length,1,"unavailable optional lookup preserves normal routing");
  allow=true;
  const context = { overrideAgent:{enabledTools:["plugin"]},channelPrincipal:principal };
  const job=await runtime.runPluginTool({action:"start",pluginId:"memewiki",tool:"search_meme_wiki",input:{query:"大水理论"},requestKey:"lookup-native"},context);
  let completed;
  const deadline=Date.now()+10000;
  do { completed=await runtime.runPluginTool({action:"status",pluginId:"memewiki",jobId:job.id},context); if(completed.status!=="running")break;await new Promise(r=>setTimeout(r,20)); } while(Date.now()<deadline);
  assert.equal(completed.status,"completed",completed.error); assert.match(completed.result.text,/长安二求/);
  plugin.config.replyMode="image";
  const reply = await command("/梗 大水理论");
  assert.match(reply.segments[0].data.file,/^base64:\/\/iVBOR/);
  fs.mkdirSync(path.resolve(__dirname,"../test-results/memewiki"),{recursive:true});
  fs.writeFileSync(path.resolve(__dirname,"../test-results/memewiki/card.png"),Buffer.from(reply.segments[0].data.file.slice(9),"base64"));
  const model = await runtime.runPluginModelHook(channel,principal.chatId,"beforeModel",{messages:[{role:"system",content:"Host identity"},{role:"user",content:"hi"}]});
  assert.equal(model.messages[0].content,"Host identity");assert.match(model.messages[1].content,/不编造/);
  await runtime.runPluginAction(channel,plugin,action("sync"),{});
  assert.equal((await runtime.runPluginAction(channel,plugin,action("sync_status"),{})).active,true);
  // Exercise the real page against the same host management actions.
  const { chromium } = h("@playwright/test");
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({viewport:{width:760,height:700},colorScheme:"light"});
    await page.exposeFunction("manage",(id,input)=>runtime.runPluginAction(channel,plugin,action(id),input));
    const html=fs.readFileSync(path.join(source,"ui/terms.html"),"utf8").replace("<head>","<head><script>window.openbotPlugin={callAction:(id,input)=>window.manage(id,input)}</script>");
    await page.setContent(html);
    await page.getByText("实例共享含义",{exact:true}).waitFor();
    await page.locator("#name").fill("卡片测试"); await page.locator("#meaning").fill("用于核对管理页的增删改操作。");
    await page.getByRole("button",{name:"保存",exact:true}).click();
    await page.locator("#notice").filter({hasText:"已保存"}).waitFor();
    await page.screenshot({path:path.resolve(__dirname,"../test-results/memewiki/terms.png")});
    const row=page.locator("article").filter({hasText:"卡片测试"});
    await row.getByRole("button",{name:"编辑"}).click();await page.locator("#meaning").fill("修改后的含义");
    await page.getByRole("button",{name:"保存",exact:true}).click();await page.getByText("修改后的含义",{exact:true}).waitFor();
    await page.setViewportSize({width:390,height:700});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"narrow page has no horizontal overflow");
    await row.getByRole("button",{name:"删除"}).click();await page.locator("#notice").filter({hasText:"已删除"}).waitFor();
    assert.equal(await page.locator("article").filter({hasText:"卡片测试"}).count(),0);
  } finally { await browser.close(); }
  console.log("memewiki host: 50 MiB catalog, real MCP/worker, commands, PNG, chat isolation, management revisions, prelookup, graceful failure and sync request passed");
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await runtime?.stopAllPluginPolls();shutdownPluginWorkers();await client.close().catch(()=>{});
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
