"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const host = path.resolve(process.env.OPENBOT_HOST_ROOT || path.join(__dirname, "../../openbot"));
const fromHost = require("node:module").createRequire(path.join(host, "package.json"));
const { createAuditFixture } = fromHost("./scripts/audit-prompt-cache.cjs");
const { createUnifiedMemoryRepository } = fromHost("./electron/lib/context/unified-memory-repository.cjs");
const { createPluginMaterialResolver } = fromHost("./electron/lib/plugins/plugin-material-resolver.cjs");
const { applyPluginPrompt } = fromHost("./electron/lib/plugins/plugin-prompt.cjs");
const plus = require("../plugins/memory/unified-runtime.cjs"), { close } = require("../plugins/memory/storage.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-plus-context-")), db = new DatabaseSync(path.join(root, "host.sqlite"));
const scope = { channelId: "bot", chatId: "onebot:group:1" };
(async () => {
  const info = console.info; console.info = () => {};
  try {
    const repo = createUnifiedMemoryRepository(db), actor = { ...scope, id: "plugin:memory", explicitForget: true,
      permissions: ["memory:read", "memory:write", "memory:manage", "memory:forget"] };
    let a = repo.memory(actor, { action: "create", requestKey: "a", record: { content: "咖啡偏好 ORIGINAL_ESPRESSO", status: "active" } });
    repo.memory(actor, { action: "create", requestKey: "b", record: { content: "茶叶偏好 ORIGINAL_TEA", status: "active" } });
    const plugin = { id: "memory", permissions: [...actor.permissions, "hook:beforeModel", "prompt:system"] };
    const resolve = createPluginMaterialResolver({ resolveChannel: () => ({ id: "bot" }), botPluginsFor: () => [plugin], permitted: () => true, memories: repo });
    let query = "咖啡";
    const ctx = { dataRoot: path.join(root, "plugin"), principal: { channelId: "bot", senderId: "123" }, plugin: { namespace: "bot" },
      config: {}, signal: new AbortController().signal, input: { chatId: scope.chatId },
      api: { memory: async ({ chatId, ...input }) => repo.memory({ ...actor, chatId: chatId || scope.chatId }, input) } };
    const fixture = createAuditFixture(root, { channel: true, contextUpdates: true, extraCommands: {
      _resolveChannelContextResource: resolve,
      runChannelModelHook: async args => {
        if (args.type !== "beforeModel") return args.payload;
        const result = await plus.beforeModel({ ...ctx, hook: args.payload, message: { id: args.payload.requestId, chatId: scope.chatId, content: query } });
        assert.equal(result.requestContext, undefined, "Plus no longer sends a transient copy of recalled bodies");
        return applyPluginPrompt({ ...args.payload }, result, plugin, { scope, resolveResource: item => resolve(item, { channelPrincipal: scope }) });
      },
    } });
    const turn = async text => { query = text; await fixture.turn(text); };
    const body = () => JSON.stringify(fixture.bodies.at(-1).messages);
    const records = () => fixture.store.data.messages.audit.filter(row => row.contextUpdates?.some(item => item.kind === "plugin_material"));
    await turn("咖啡"); assert.match(body(), /ORIGINAL_ESPRESSO/);
    const initial = fixture.bodies.at(-1).messages;
    await turn("咖啡"); await turn("咖啡");
    assert.deepEqual(fixture.bodies[1].messages.slice(0, initial.length), initial);
    assert.deepEqual(fixture.bodies[2].messages.slice(0, fixture.bodies[1].messages.length), fixture.bodies[1].messages);
    assert.equal(records().length, 1);
    await turn("茶叶"); assert.match(body(), /ORIGINAL_TEA/); assert.match(body(), /ORIGINAL_ESPRESSO/); assert.equal(records().length, 2);
    await turn("咖啡"); assert.equal(records().length, 2, "switching topics back does not duplicate an already visible version");
    a = repo.memory(actor, { action: "revise", id: a.id, expectedRevision: 1, requestKey: "a2", changeType: "edit", patch: { content: "咖啡偏好 UPDATED_ESPRESSO" } });
    const previous = fixture.bodies.at(-1).messages;
    await turn("咖啡"); assert.deepEqual(fixture.bodies.at(-1).messages.slice(0, previous.length), previous);
    assert.match(body(), /ORIGINAL_ESPRESSO/); assert.match(body(), /UPDATED_ESPRESSO/);
    repo.memory(actor, { action: "forget", id: a.id, expectedRevision: a.revision, requestKey: "forget", reason: "用户遗忘" });
    await turn("咖啡"); assert.doesNotMatch(body(), /ORIGINAL_ESPRESSO|UPDATED_ESPRESSO/);
    assert.doesNotMatch(JSON.stringify(records()), /ORIGINAL_ESPRESSO|UPDATED_ESPRESSO|ORIGINAL_TEA/, "session stores references rather than duplicate memory bodies");
    console.log("Memory Plus context: actual recall and serialized model requests preserve prefixes, deduplicate across turns/topic changes, append revisions and remove forgotten references passed (controlled provider responses).");
  } finally { console.info = info; close(); db.close(); assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith("openbot-plus-context-")); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
