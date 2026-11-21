"use strict";

const { randomUUID } = require("node:crypto");
const imap = require("./imap.cjs");
const gmail = require("./gmail.cjs");
const organize = require("./organize.cjs");
const outbox = require("./outbox.cjs");
const imapActions = require("./imap-actions.cjs");
const { scopeKey } = require("./compose.cjs");

const store = { name: "mailbox", collection: "watches", scope: "channel" };
const reasons = {
  binding: "原私聊的发送账号或主人权限已变化。",
  restored: "应用数据已恢复，请重新关注新邮件。",
  mailbox: "收件箱已更换，请重新关注新邮件。",
  history: "Gmail 中的原检查位置已过期，请重新关注新邮件。"
};
const keyFor = chatId => imap.hash(chatId);
const get = async ctx => (await ctx.api.database({ ...store, action: "get", key: keyFor(ctx.principal.chatId) })).record;
const put = async (ctx, row, value) => (await ctx.api.database({ ...store, action: "put",
  key: keyFor(ctx.principal.chatId), expectedRevision: row?.revision || 0, value })).record;

async function checkOwner(ctx) {
  const p = ctx.principal, caps = await ctx.api.getCapabilities();
  if (p.source !== "channel" || p.role !== "owner" || p.messageType !== "private" || !p.senderId ||
      !caps.conversationBinding?.privateOwner || !caps.conversationBinding.account)
    throw imap.failure("MAIL_OWNER_ONLY", "请在实例主人的私聊中使用邮箱。");
  return caps;
}

function bindingProblem(value, caps) {
  if ((caps.dataRestoreId || "") !== value.restoreId) return "restored";
  const binding = caps.conversationBinding;
  if (!binding?.privateOwner || binding.account !== value.account) return "binding";
  return "";
}

function handlers(open = imap.withInbox) {
  async function connectAccount(ctx) {
    if (ctx.config.provider === "gmail") {
      const api = await gmail.connect(ctx);
      return { gmail: api, accountKey: api.accountKey, email: api.profile.emailAddress };
    }
    const settings = await imap.connection(ctx);
    return { settings, accountKey: settings.accountKey, email: settings.user };
  }
  const tool = run => async ctx => {
    const caps = await checkOwner(ctx), a = await connectAccount(ctx);
    a.scope = scopeKey(ctx, caps, a.accountKey);
    return run({ ...ctx, fileScope: a.scope }, a, ctx.input, caps);
  };
  function gmailOnly(a) {
    if (!a.gmail) throw imap.failure("MAIL_GMAIL_ONLY", "这项操作需要 Gmail API 连接。");
    return a.gmail;
  }

  async function cancelPending(ctx, row, account) {
    if (row?.value.pending && row.value.account === account) await ctx.api.cancelConversationEvent({
      id: row.value.pending.id, reserve: true, expectedAccount: account });
  }

  async function watchMail(ctx) {
    const caps = await checkOwner(ctx), row = await get(ctx), value = row?.value;
    const account = caps.conversationBinding.account;
    const problem = value && bindingProblem(value, caps);
    if (ctx.input.action === "status") {
      if (!value || problem) return { active: false, ...(problem ? { reason: reasons[problem] } : {}) };
      return { active: value.active, criteria: value.criteria, lastCheckedAt: value.lastCheckedAt || null,
        ...(value.reason ? { reason: reasons[value.reason] } : {}), ...(value.lastError ? { lastError: value.lastError } : {}) };
    }
    if (ctx.input.action === "stop") {
      if (row) {
        const stopped = await put(ctx, row, { ...value, active: false });
        await cancelPending(ctx, stopped, account);
        if (stopped.value.pending) await put(ctx, stopped, { ...stopped.value, pending: null });
      }
      return { active: false };
    }
    if (ctx.input.action !== "start") throw imap.failure("MAIL_ACTION", "不支持这项关注操作。");
    const criteria = imap.filters(ctx.input);
    if (!Object.keys(criteria).length && ctx.input.all !== true)
      throw imap.failure("MAIL_FILTER_REQUIRED", "请指定要关注的发件人、主题，或明确关注全部新邮件。");
    if (Object.keys(criteria).length && ctx.input.all === true)
      throw imap.failure("MAIL_FILTER_CONFLICT", "关注全部来信时请清除发件人和主题条件。");
    const a = await connectAccount(ctx);
    const baseline = a.gmail ? { namespace: a.accountKey, after: { historyId: a.gmail.profile.historyId } }
      : await open(a.settings, box => ({ namespace: box.namespace, after: box.mailbox.uidNext - 1 }));
    if (value?.active && !problem && value.namespace === baseline.namespace && JSON.stringify(criteria) === JSON.stringify(value.criteria))
      return { active: true, criteria };
    await cancelPending(ctx, row, account);
    await put(ctx, row, { active: true, criteria, account, accountKey: a.accountKey, chatId: ctx.principal.chatId,
      restoreId: caps.dataRestoreId || "", watchId: randomUUID(), ...baseline, pending: null });
    return { active: true, criteria };
  }

  async function poll(ctx) {
    const cursor = await ctx.api.getState("page", "channel");
    const page = await ctx.api.database({ ...store, action: "query", where: { active: true }, limit: 4, cursor: cursor || undefined });
    const slot = Math.floor(Date.now() / 120000);
    let firstError;
    for (const row of page.records) {
      const { watchId, chatId } = row.value;
      try {
        await ctx.api.jobs({ action: "start", actionId: "check-inbox", chatId,
          requestKey: "mail:" + watchId + ":" + row.revision + ":" + slot, input: { watchId } });
      } catch (error) { firstError ||= error; }
    }
    await ctx.api.setState("page", page.nextCursor || "", "channel");
    if (firstError) throw firstError;
  }

  async function checkInbox(ctx) {
    let row = await get(ctx);
    if (!row?.value.active || row.value.watchId !== ctx.input.watchId || row.value.chatId !== ctx.principal.chatId) return;
    const value = row.value;
    const pause = async reason => {
      await put(ctx, row, { ...row.value, active: false, reason, pending: null });
      return { active: false, reason: reasons[reason] };
    };
    const binding = bindingProblem(value, await ctx.api.getCapabilities());
    if (binding) return pause(binding);
    try {
      const a = await connectAccount(ctx);
      if (value.accountKey !== a.accountKey) return pause("mailbox");
      // Verify UIDVALIDITY on every retry, including a previously prepared batch.
      const result = a.gmail ? (value.pending ? null : await gmail.changes(a.gmail, value))
        : await open(a.settings, box => value.namespace !== box.namespace ? { reset: true }
          : value.pending ? null : imap.changes(box, value));
      if (result?.reset) return pause(a.gmail ? "history" : "mailbox");
      if (result && !result.messages.length) {
        await put(ctx, row, { ...value, after: result.after, lastCheckedAt: new Date().toISOString(), lastError: null });
        return;
      }
      if (!value.pending) {
        const pending = { id: "mail:" + value.watchId + ":" + (a.gmail ? imap.hash(result.after) : result.after), after: result.after,
          text: JSON.stringify({ source: "邮箱来信", criteria: value.criteria, messages: result.messages }) };
        row = await put(ctx, row, { ...value, pending });
      }
      const fresh = await get(ctx);
      if (fresh?.revision !== row.revision || !fresh.value.active) return;
      const changed = bindingProblem(value, await ctx.api.getCapabilities());
      if (changed) return pause(changed);
      const current = await connectAccount({ ...ctx, config: await ctx.api.getConfig() });
      if (current.accountKey !== value.accountKey) return pause("mailbox");
      const pending = row.value.pending;
      const receipt = await ctx.api.publishConversationEvent({ id: pending.id, text: pending.text, delivery: "flush",
        kind: "notice", expectedAccount: value.account, ownerPrivate: true });
      if (!receipt?.accepted || !receipt.id) throw imap.failure("MAIL_NOTICE", "来信通知尚未被原私聊受理。");
      await put(ctx, row, { ...row.value, after: pending.after, pending: null, lastCheckedAt: new Date().toISOString(), lastError: null });
      return { accepted: true };
    } catch (error) {
      if (error.code?.startsWith("MAIL_")) {
        const latest = await get(ctx);
        if (latest?.revision === row.revision) await put(ctx, latest, { ...latest.value, lastError: { code: error.code, message: error.message } });
      }
      throw error;
    }
  }

  return {
    googleLogin: require("./authorize-gmail.cjs").desktopLogin,
    runBulk: async ctx => {
      const caps = await ctx.api.getCapabilities();
      if (!caps.conversationBinding?.privateOwner) throw imap.failure("MAIL_OWNER_ONLY", "原私聊已失去邮箱操作权限。");
      return organize.runBulk(ctx, gmailOnly(await connectAccount(ctx)), caps);
    },
    profile: tool((ctx, a) => a.gmail ? a.gmail.profile : { emailAddress: a.email, provider: "imap" }),
    searchMail: tool((ctx, a, input) => {
      if (a.gmail) return gmail.search(a.gmail, input);
      if (input.query || input.labelIds?.length || input.includeSpamTrash) gmailOnly(a);
      return open(a.settings, async box => {
        const found = await imap.search(box, input);
        if (input.idsOnly) found.messages = found.messages.map(({ id, folder }) => ({ id, folder }));
        return found;
      }, input.folder);
    }),
    readMail: tool(async (ctx, a, input) => {
      const ids = input.ids?.length ? input.ids : [input.id];
      if (!ids[0]) throw imap.failure("MAIL_ID_REQUIRED", "请指定要读取的邮件。");
      const result = [];
      const collect = async fn => {
        for (const id of ids) { result.push(await fn(id)); gmail.bounded(result); }
        return input.ids?.length ? { messages: result } : result[0];
      };
      return a.gmail ? (input.ids?.length ? { messages: await gmail.messages(a.gmail, ids, input.format) } : gmail.bounded(await gmail.message(a.gmail, ids[0], input.format)))
        : open(a.settings, box => collect(id => imap.read(box, id)), input.folder);
    }),
    readThread: tool((ctx, a, i) => gmail.threads(gmailOnly(a), i)),
    folders: tool((ctx, a, i) => a.gmail ? organize.folders(a.gmail, i) : open(a.settings, box => imapActions.folders(box, i))),
    modify: tool((ctx, a, i, caps) => a.gmail ? organize.modify(ctx, a.gmail, caps, i) : open(a.settings, box => imapActions.modify(box, i), i.folder, true)),
    attachment: tool((ctx, a, i) => a.gmail ? gmail.file(ctx, a.gmail, i) : open(a.settings, box => imapActions.file(ctx, box, i), i.folder)),
    drafts: tool(outbox.drafts), send: tool(outbox.send), watchMail, poll, checkInbox
  };
}

module.exports = { handlers };
