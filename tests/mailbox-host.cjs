"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { createMailboxFixture } = require("./fixtures/mailbox-imap.cjs");
const { googleFixture } = require("./fixtures/mailbox-google.cjs");
const host = path.resolve(process.argv[2] || path.join(__dirname, "../../openbot"));
const lib = file => require(path.join(host, "electron/lib", file));
const pluginPath = path.resolve(__dirname, "../plugins/mailbox");
const { createChannelPluginRuntimeService, shutdownPluginWorkers } = lib("features/channels/channel-plugin-runtime-service.cjs");

async function until(fn, predicate, label) {
  const end = Date.now() + 15000;
  let value;
  do {
    value = await fn();
    if (predicate(value)) return value;
    await delay(50);
  } while (Date.now() < end);
  assert.fail(label + ": " + JSON.stringify(value));
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-mailbox-host-"));
  const proc = lib("plugins/plugin-process.cjs"), createProcess = proc.createPluginProcessRuntime;
  const diagnostics = lib("app/runtime-diagnostics.cjs"), incidents = [];
  diagnostics.setRuntimeDiagnostics({ record(_level, _event, details) { incidents.push(details); } });
  const pacer = lib("features/website-request-pacer.cjs").websiteRequests, pace = pacer.run;
  // The Gmail HTTP transport is an in-memory fixture. Keep the production request validation.
  pacer.run = (_url, signal, perform) => { signal.throwIfAborted(); return perform(); };
  let mail, storage, runtime, sessions, events;
  try {
    const authorize = require("../plugins/mailbox/authorize-gmail.cjs").authorize;
    const login = await authorize({ client_id: "local-client", client_secret: "local-secret" });
    const authUrl = new URL(login.url), callback = new URL(authUrl.searchParams.get("redirect_uri"));
    const realFetch = global.fetch;
    try {
      assert.equal((await realFetch(callback)).status, 403);
      callback.search = new URLSearchParams({ code: "fixture-code", state: authUrl.searchParams.get("state") }).toString();
      global.fetch = async (url, options) => {
        assert.equal(url, "https://oauth2.googleapis.com/token");
        assert.equal(options.body.get("redirect_uri"), authUrl.searchParams.get("redirect_uri"));
        assert.equal(require("node:crypto").createHash("sha256").update(options.body.get("code_verifier")).digest("base64url"), authUrl.searchParams.get("code_challenge"));
        return Response.json({ refresh_token: "fixture-refresh" });
      };
      assert.match(await (await realFetch(callback)).text(), /fixture-refresh/);
    } finally { global.fetch = realFetch; login.close(); }
    mail = await createMailboxFixture(root);
    const owner = "123456", chatId = "onebot:private:" + owner;
    const channel = { id: "mail-fixture", platform: "qq", enabled: true, connected: true, chatSessions: { [chatId]: "mail-session" },
      config: { selfId: "456789", ownerUsers: [owner], agentId: "assistant", provider: "onebot" } };
    const store = { root, data: { channels: [channel], settings: {}, sessions: [{ id: "mail-session", channelId: channel.id, channelChatId: chatId }] },
      save() {}, async flush() {} };
    const array = key => store.data[key] ||= [];
    const commands = lib("commands/extensions/plugin-commands.cjs").createPluginCommands({
      fs, path, getStore: () => store, getCommands: () => ({}), ensureStoreArray: array });
    const imported = await commands.importPluginFromPath({ pluginPath });
    assert.equal(imported.authorization.status, "pending");
    const installed = array("plugins").find(p => p.id === "mailbox");
    const { decidePluginAuthorization, pluginAuthorization } = lib("plugins/plugin-authorization.cjs");
    decidePluginAuthorization(installed, pluginAuthorization(installed).fingerprint, true);
    const binding = channel.config.botPlugins.find(p => p.id === "mailbox");
    const plugin = { ...binding, config: { username: "owner@example.test" }, authorization: pluginAuthorization(installed) };
    const environment = lib("plugins/plugin-environment.cjs");
    await environment.prepareEnvironment(root, plugin);
    // Trust the ephemeral fixture certificate only inside this test's plugin process.
    proc.createPluginProcessRuntime = options => createProcess({ ...options, resolveLaunch(spec) {
      const launch = environment.resolveLaunch(spec, root);
      return { ...launch, runtimeEnv: { ...launch.runtimeEnv, NODE_EXTRA_CA_CERTS: mail.ca } };
    } });
    const paths = lib("context/context-paths.cjs").createContextPaths({ root });
    storage = lib("context/channel-storage-repository.cjs").createChannelStorageRepository({ fs, paths });
    sessions = lib("context/session-sqlite-repository.cjs").createSessionSqliteRepository({ fs, path, paths });
    sessions.saveSessionMeta(store.data.sessions[0]);
    const registry = lib("features/channels/channel-plugin-registry-service.cjs").createChannelPluginRegistryService({
      store, ensureStoreArray: array, scheduleSave() {} });
    let seq = 0, lostAck = false;
    const makeId = prefix => prefix + "-" + ++seq, accepted = [];
    const google = googleFixture();
    const secrets = new Map([["secret:imapServer", mail.endpoint], ["secret:imapPassword", "test-pass"]]);
    events = lib("features/channels/channel-conversation-events.cjs").createChannelConversationEvents({
      getRepository: () => storage.conversationEventRepository, background: storage.runConversationEventStorage, sessionRepository: sessions,
      resolveChannel: () => channel, botPluginsFor: () => [plugin], getCommands: () => ({ sendMessage: () => ({ accepted: true }) }),
      permitted: () => true, canSendTo: (_, id) => id === chatId, makeId, acquireChannelTurn: () => ({ ok: true }),
      releaseChannelTurn() {}, isChannelTurnLeaseActive: () => true, activeChannelAgentSession: () => "mail-session", save() {} });
    const createRuntime = () => createChannelPluginRuntimeService({ fs, path, store, ensureStoreArray: array, resolveChannel: () => channel,
      channelEventByReference: (_, chat, id) => chat === chatId && id === "chat-file" ? {
        id, chatId, media: [{ type: "file", url: "https://chat-files.example.test/document", mimeType: "text/plain" }] } : null,
      guardedFetch: (url, opts) => String(url) === "https://chat-files.example.test/document" ? Promise.resolve(new Response("chat-attachment")) : google.fetch(url, opts),
      readResponseBytes: async response => Buffer.from(await response.arrayBuffer()),
      botPluginsFor: () => [plugin], makeId, safeError: error => error.message || String(error), isNapCatOneBotChannel: () => true,
      pluginStateScopeId: registry.pluginStateScopeId, setPluginState: registry.setPluginState,
      getPluginState(...args) { return secrets.has(args[4]) ? { value: secrets.get(args[4]) } : registry.getPluginState(...args); },
      secretStore: { isSecretEnvelope: e => !!e?.value, decryptSecret: e => e.value },
      getTaskRepository: () => storage.backgroundAgentRepository, pluginData: storage.pluginDataStore.background,
      conversationEpoch: (cid, id) => storage.conversationEventRepository.epoch(cid, id),
      getConversationEvent: events.get, cancelConversationEvent: events.withdraw, async publishConversationEvent(event, options) {
        const receipt = await events.publishPlugin(event, options);
        accepted.push({ event, receipt });
        if (lostAck) { lostAck = false; throw Error("fixture lost acknowledgement"); }
        return receipt;
      } });
    runtime = createRuntime();
    const principal = lib("features/channels/channel-permissions.cjs").channelPrincipalForMessage;
    async function invoke(tool, input, expected = "completed", sender = owner) {
      const row = { id: makeId("in"), chatId: "onebot:private:" + sender, messageType: "private", sender: { id: sender },
        direction: "in", content: "测试邮箱", createdAt: Date.now() };
      const context = { row, purpose: "chat", requestId: makeId("turn"), channelPrincipal: principal(channel, row) };
      const started = await runtime.runNativePluginTool("plugin__mailbox__" + tool, { action: "start", input, requestKey: makeId("tool") }, context);
      const result = started.status === "running" ? await until(() => runtime.runPluginTool({
        action: "status", pluginId: plugin.id, jobId: started.id }, context), j => j.status !== "running", tool) : started;
      assert.equal(result.status, expected, JSON.stringify(result));
      return expected === "completed" ? result.result : result.error;
    }
    const record = async () => (await storage.pluginDataStore.background.database({ channelId: channel.id, pluginId: plugin.id, chatId },
      { scope: "channel", name: "mailbox", collection: "watches", action: "query", limit: 4 })).records[0]?.value;
    const poll = () => runtime.runPluginPoll(channel, plugin, true);
    const { messages } = mail.state;
    messages.push({ uid: 7, subject: "old", text: "旧信" });
    assert.deepEqual(await invoke("watch_mail", { action: "status" }), { active: false });
    assert.match(await invoke("watch_mail", { action: "start" }, "failed"), /请指定要关注/);
    secrets.delete("secret:imapServer");
    assert.match(await invoke("search_mail", {}, "failed"), /填写 IMAP 服务器/);
    secrets.set("secret:imapServer", "localhost:65536");
    assert.match(await invoke("search_mail", {}, "failed"), /1 至 65535/);
    secrets.set("secret:imapServer", mail.endpoint);
    secrets.delete("secret:imapPassword");
    assert.match(await invoke("search_mail", {}, "failed"), /填写邮箱授权码或应用密码/);
    secrets.set("secret:imapPassword", "wrong");
    assert.match(await invoke("search_mail", {}, "failed"), /服务器拒绝了邮箱登录/);
    secrets.set("secret:imapPassword", "test-pass");
    const first = await invoke("search_mail", {});
    assert.equal(first.messages[0].subject, "old");
    assert.match(await invoke("read_mail", { id: "invalid" }, "failed"), /邮件编号无效/);
    assert.match(await invoke("read_mail", { id: first.messages[0].id.replace(/\.7$/, ".6") }, "failed"), /已不在收件箱/);
    assert.equal((await invoke("read_mail", { id: first.messages[0].id })).text, "旧信");
    await invoke("watch_mail", { action: "start", subject: "school" });
    assert.equal((await record()).after, 7);
    mail.state.online = false;
    await poll();
    await until(record, v => !!v?.lastError, "offline poll");
    assert.equal((await record()).after, 7);
    mail.state.online = true;
    messages.push({ uid: 9, subject: "newsletter", text: "skip" },
      { uid: 11, subject: "school deadline", text: "<p>补材料截止周五 17:00</p><script>hidden()</script>", html: true });
    lostAck = true;
    await poll();
    await until(record, v => !!v?.pending && accepted.length === 1, "prepared event");
    await runtime.stopAllPluginPolls();
    runtime = createRuntime();
    await poll();
    await until(record, v => v?.after === 11 && !v.pending, "retry delivery");
    assert.equal(accepted.length, 2);
    assert.equal(accepted[0].receipt.id, accepted[1].receipt.id);
    assert.equal(accepted[1].receipt.duplicate, true);
    assert.equal(accepted[0].event.chatId, chatId);
    const evidence = JSON.parse(accepted[0].event.input.text).messages;
    assert.deepEqual(evidence.map(m => m.subject), ["school deadline"]);
    assert.equal(evidence[0].text, "补材料截止周五 17:00");
    assert.equal((await invoke("read_mail", { id: evidence[0].id })).text, evidence[0].text);
    for (let n = 12; n < 27; n++) messages.push({ uid: n, subject: "news-" + n, text: "news" });
    messages.push({ uid: 27, subject: "补材料", text: "中".repeat(30000) });
    const page = await invoke("search_mail", {});
    assert.equal(page.messages.length, 12);
    const more = await invoke("search_mail", { cursor: page.nextCursor });
    assert.equal(more.nextCursor, null);
    assert.equal(new Set([...page.messages, ...more.messages].map(m => m.id)).size, messages.length);
    assert.match(await invoke("search_mail", { cursor: page.nextCursor, subject: "other" }, "failed"), /请重新查询邮件/);
    const filtered = await invoke("search_mail", { from: "office@example.test", subject: "补材料" });
    assert.deepEqual(filtered.messages.map(m => m.subject), ["补材料"]);
    assert.deepEqual((await invoke("search_mail", { from: "other@example.test", subject: "补材料" })).messages, []);
    const long = await invoke("read_mail", { id: filtered.messages[0].id });
    assert.equal(long.truncated, true);
    assert.equal(long.text.length, 8000);
    await invoke("watch_mail", { action: "stop" });
    await poll();
    assert.equal(accepted.length, 2);
    await invoke("watch_mail", { action: "start", all: true });
    mail.state.validity++;
    await poll();
    await until(record, v => v?.reason === "mailbox" && !v.active, "UIDVALIDITY reset");
    assert.match(await invoke("read_mail", { id: first.messages[0].id }, "failed"), /已不属于当前收件箱/);
    const connections = mail.state.connections;
    await assert.rejects(() => invoke("search_mail", {}, "completed", "888888"));
    assert.equal(mail.state.connections, connections);
    assert(!mail.state.commands.some(c => /BODY\[(?:TEXT|HEADER)\]/i.test(c)));
    secrets.set("secret:smtpServer", mail.smtp);
    const fresh = (await invoke("search_mail", {})).messages[0];
    await invoke("organize_mail", { action: "star", ids: [fresh.id] });
    assert((await invoke("read_mail", { id: fresh.id })).starred);
    await invoke("organize_mail", { action: "move", ids: [fresh.id], destination: "Archive" });
    const archived = (await invoke("search_mail", { folder: "Archive" })).messages;
    assert.equal(archived.length, 1);
    assert.notEqual(archived[0].id, fresh.id);
    const local = await invoke("mail_drafts", { action: "create", to: ["a@example.test"], subject: "initial", text: "keep me",
      attachments: [{ messageId: "chat-file", name: "document.txt" }] });
    await invoke("mail_drafts", { action: "update", id: local.id, subject: "updated" });
    const smtp = await invoke("send_mail", { draftId: local.id });
    assert.deepEqual(smtp.accepted, ["a@example.test"]);
    assert.match(mail.state.sent[0].raw, /Subject: updated/);
    assert.match(mail.state.sent[0].raw, /keep me/);
    assert.match(mail.state.sent[0].raw, /Y2hhdC1hdHRhY2htZW50/);
    await invoke("send_mail", { draftId: local.id });
    assert.equal(mail.state.sent.length, 1);
    const partial = await invoke("send_mail", { to: ["a@example.test"], bcc: ["secret@example.test","reject@example.test"], text: "test" });
    assert.equal(partial.state, "partial");
    assert.deepEqual(partial.rejected, ["reject@example.test"]);
    assert(!/^Bcc:/im.test(mail.state.sent.at(-1).raw));
    const ambiguous = await invoke("mail_drafts", { action: "create", to: ["a@example.test"], text: "save once" });
    mail.state.loseSmtpReply = true;
    assert.match(await invoke("send_mail", { draftId: ambiguous.id }, "failed"), /确定回执/);
    assert.match(await invoke("send_mail", { draftId: ambiguous.id }, "failed"), /确定回执/);
    assert.equal(mail.state.sent.length, 3);

    plugin.config.provider = "gmail";
    secrets.set("secret:gmailOAuth", JSON.stringify({ client_id: "fixture", client_secret: "fixture", refresh_token: "test-refresh" }));
    assert.equal((await invoke("mail_profile", {})).emailAddress, "owner@example.test");
    const gmailIds = await invoke("search_mail", { query: "has:attachment newer_than:30d", labelIds: ["INBOX","UNREAD"], idsOnly: true });
    assert.deepEqual(gmailIds.messages.map(m => m.id), ["a1","a2"]);
    assert(google.calls.some(c => c.q.q === "has:attachment newer_than:30d"));
    const mails = await invoke("read_mail", { ids: ["a2","a1"] });
    assert.deepEqual(mails.messages.map(m => m.text), ["第二封","第一封"]);
    const thread = await invoke("read_mail_threads", { messageIds: ["a1","a2"], maxMessages: 1 });
    assert.equal(thread.threads.length, 1);
    assert.equal(thread.threads[0].messages[0].id, "a2");
    const file = await invoke("read_mail_attachment", { id: "a1", filename: "材料.txt" });
    assert.equal(fs.readFileSync(file.path, "utf8"), "file");
    const sharp = require(require.resolve("sharp", { paths: [host] }));
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#405060" } }).png().toBuffer();
    google.messages.get("a1").payload.parts.push({ partId: "2", mimeType: "image/png", filename: "pixel.png",
      body: { size: png.length, data: png.toString("base64url") } });
    const savedImage = await invoke("read_mail_attachment", { id: "a1", part: "2" });
    assert.deepEqual(fs.readFileSync(savedImage.path), png);
    assert(savedImage.attachments?.[0].assetRef);
    google.messages.get("a1").payload.parts.push({ partId: "3", mimeType: "image/png", filename: "broken.png", body: { size: 2, data: "AAA" } });
    const broken = await invoke("read_mail_attachment", { id: "a1", part: "3" });
    assert.equal(fs.statSync(broken.path).size, 2);
    assert.equal(broken.previewError.message, "图片预览未生成。");
    const attached = await invoke("mail_drafts", { action: "create", to: ["me"], attachments: [{ savedFile: file.path }] });
    const attachedRaw = Buffer.from(google.drafts.get(attached.id).message.raw, "base64url").toString();
    assert.match(attachedRaw, /Content-Disposition: attachment/i);
    assert.match(attachedRaw, /ZmlsZQ==/);
    await invoke("mail_drafts", { action: "discard", id: attached.id });
    const tag = await invoke("mail_folders", { action: "create", name: "Study" });
    assert.equal((await invoke("mail_folders", { action: "create", name: "Study" })).id, tag.id);
    assert.equal((await invoke("mail_folders", { action: "list", name: "INBOX" })).labels[0].messagesUnread, 1);
    await invoke("organize_mail", { action: "labels", ids: ["a1"], add: ["Study"], remove: ["UNREAD"] });
    assert(google.messages.get("a1").labelIds.includes(tag.id));
    google.onePerPage = true;
    let run = await invoke("organize_mail", { action: "bulkLabels", query: "subject:School", add: ["Study"] });
    while (run.more) run = await invoke("organize_mail", { action: "bulkLabels", operationId: run.operationId });
    assert.equal(run.processed, 2); google.onePerPage = false;
    await invoke("organize_mail", { action: "archive", ids: ["a1"] });
    assert(!google.messages.get("a2").labelIds.includes("INBOX"));
    await invoke("organize_mail", { action: "trash", ids: ["a1"] });
    assert.deepEqual(google.messages.get("a1").labelIds, ["TRASH"]);
    await invoke("organize_mail", { action: "restore", ids: ["a1"] });
    const d = await invoke("mail_drafts", { action: "create", subject: "First", text: "plain", html: "<p>rich</p>", to: ["me"] });
    assert((await invoke("mail_drafts", { action: "list" })).drafts.some(x => x.id === d.id));
    const rawDraft = () => Buffer.from(google.drafts.get(d.id).message.raw, "base64url").toString();
    const before = rawDraft().split("\r\n\r\n").slice(1).join("\r\n\r\n");
    await invoke("mail_drafts", { action: "update", id: d.id, subject: "Patched" });
    assert.match(rawDraft(), /Subject: Patched/);
    assert.equal(rawDraft().split("\r\n\r\n").slice(1).join("\r\n\r\n"), before);
    await invoke("mail_drafts", { action: "update", id: d.id, replyTo: "reply@example.test", payload: {
      mime_type: "multipart/related", parts: [{ mime_type: "text/html", body: { content: '<img src="cid:photo">' } },
        { mime_type: "image/png", content_id: "photo", filename: "test.png", body: { base64_url_content: "AAEC" } }] } });
    assert.match(rawDraft(), /multipart\/related/i);
    assert.match(rawDraft(), /Content-ID: <photo>/i);
    assert.match(rawDraft(), /Reply-To: reply@example.test/i);
    assert.match(rawDraft(), /AAEC/);
    await invoke("send_mail", { draftId: d.id });
    await invoke("send_mail", { draftId: d.id });
    assert.equal(google.sent.length, 1);
    await invoke("send_mail", { mode: "replyAll", sourceId: "a1", text: "thank you" });
    const reply = Buffer.from(google.sent.at(-1).raw, "base64url").toString();
    assert.match(reply, /To: admissions@example.test/); assert.match(reply, /Cc: team@example.test/);
    assert.match(reply, /In-Reply-To: <a1@example.test>/); assert.equal(google.sent.at(-1).threadId, "c1");
    const forwards = await invoke("send_mail", { mode: "forward", sourceIds: ["a1","a2","a1"], to: ["me"], text: "FYI" });
    assert.equal(forwards.results.length, 2); assert.equal(google.sent.length, 4);
    assert.match(Buffer.from(google.sent.at(-1).raw, "base64url").toString(), /message\/rfc822/i);
    const uncertain = await invoke("mail_drafts", { action: "create", to: ["me"], subject: "only once" });
    google.loseReceipt = true;
    assert.match(await invoke("send_mail", { draftId: uncertain.id }, "failed"), /确定回执/);
    assert.match(await invoke("send_mail", { draftId: uncertain.id }, "failed"), /确定回执/);
    assert.equal(google.sent.length, 5);
    const rejected = await invoke("mail_drafts", { action: "create", to: ["me"], text: "retry after authorization" });
    google.rejectSend = true;
    assert.match(await invoke("send_mail", { draftId: rejected.id }, "failed"), /HTTP 403，错误码 PERMISSION_DENIED/);
    const incident = incidents.find(item => item.pluginId === "mailbox" && item.code === "MAIL_GOOGLE_403");
    assert.equal(incident?.httpStatus, 403);
    assert.equal(incident?.upstreamCode, "PERMISSION_DENIED");
    google.rejectSend = false;
    await invoke("send_mail", { draftId: rejected.id }); assert.equal(google.sent.length, 6);
    await invoke("watch_mail", { action: "start", subject: "School" });
    google.add("a3", "c1", "School update", "截止改为周一");
    await poll();
    await until(record, v => v?.after?.historyId === "23", "Gmail history advanced");
    assert.equal(JSON.parse(accepted.at(-1).event.input.text).messages[0].text, "截止改为周一");
    google.expired = true;
    await poll(); await until(record, v => !v?.active && v?.reason === "history", "expired Gmail history");
    console.log("Mailbox passed IMAP/SMTP and Gmail API host integration, including sparse draft edits, sends, reply-all, original-message forwards, attachments, labels, archives, Trash, threads, unknown submission outcomes and incremental notifications.");
  } finally {
    diagnostics.setRuntimeDiagnostics(null);
    pacer.run = pace;
    proc.createPluginProcessRuntime = createProcess;
    events?.stop();
    await runtime?.stopAllPluginPolls();
    await shutdownPluginWorkers();
    await storage?.pauseForDataSnapshot();
    storage?.close(); sessions?.close();
    await mail?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
