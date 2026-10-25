"use strict";
// Explicit host checkout argument; production plugins still use only ctx.api.
// node tests/video-ledger-storage.cjs D:/Desktop/openbot
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixture } = require("./butler.cjs");
const host = process.argv[2];
if (!host) throw new Error("Pass the OpenBot host checkout path");
const { createContextPaths } = require(path.resolve(host, "electron/lib/context/context-paths.cjs"));
const { createChannelStorageRepository } = require(path.resolve(host, "electron/lib/context/channel-storage-repository.cjs"));
const root = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "openbot-video-ledger-"));
const resume = process.argv[4] === "resume";
(async () => {
  const repository = createChannelStorageRepository({ fs, paths: createContextPaths({ root }) });
  try {
    const f = fixture();
    let channelId = "ledger-test";
    const location = (key, scope) => ({ channelId, pluginId: "bilibili-explorer", scope,
      scopeId: scope === "chat" ? f.ctx.message.chatId : channelId, key });
    f.ctx.api.getState = async (key, scope) => repository.getPluginState(location(key, scope));
    f.ctx.api.setState = async (key, value, scope) => repository.setPluginState({ ...location(key, scope), value });
    if (resume) {
      f.memberships.get("10").delete("100"); f.memberships.get("20").add("100");
      f.ctx.config.scanFolders = ["20"];
    }
    assert.match(await f.invoke("biliscan", "new"), /扫描完成/);
    assert.match(await f.invoke("biliplan"), /方案已生成/);
    assert.equal(f.agents.length, resume ? 0 : 1);
    const rows = repository.listAllPluginStates().filter(row => row.key === "bili:1:video:BV1234567890");
    assert.equal(rows.length, 1); assert.equal(rows[0].value.classification.status, "classified");
    if (resume) {
      channelId = "another-instance";
      assert.equal(await f.ctx.api.getState("bili:1:video:BV1234567890", "channel"), undefined);
      await f.invoke("biliscan", "new"); await f.invoke("biliplan");
      assert.equal(f.agents.length, 1, "another instance has its own records");
    }
  } finally { repository.close(); }
  if (!resume) {
    const child = spawnSync(process.execPath, [__filename, path.resolve(host), root, "resume"], { encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    console.log(JSON.stringify({ result: "passed", database: createContextPaths({ root }).contextDbFile,
      checks: ["real host SQLite rows", "new process after move: zero model calls", "instance isolation"] }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
