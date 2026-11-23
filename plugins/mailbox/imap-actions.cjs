"use strict";

const imap = require("./imap.cjs");
const { MAX_BYTES, saveFile } = require("./compose.cjs");
const fail = imap.failure;
async function fetchItem(box, id, query) {
  const item = await box.client.fetchOne(imap.uidOf(box, id), query, { uid: true });
  if (!item) throw fail("MAIL_GONE", "指定的邮件已不在这个文件夹中。");
  return item;
}
async function download(box, id, part) {
  const { content } = await box.client.download(imap.uidOf(box, id), part, { uid: true, maxBytes: MAX_BYTES + 1, chunkSize: 65536 });
  if (!content) throw fail("MAIL_FILE_GONE", "服务器未返回邮件原件。");
  const chunks = [];
  let size = 0;
  for await (const chunk of content) {
    size += chunk.length;
    if (size > MAX_BYTES) throw fail("MAIL_FILE_LIMIT", "读取的邮件内容已超过 " + MAX_BYTES + " 字节。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function file(ctx, box, input) {
  const item = await fetchItem(box, input.id, { bodyStructure: true });
  const list = imap.attachments(item.bodyStructure).filter(a => input.part != null ? a.part === input.part : a.filename === input.filename);
  if (!list.length) throw fail("MAIL_FILE_GONE", "这封邮件中没有指定的附件。");
  if (list.length > 1) throw fail("MAIL_FILE_AMBIGUOUS", "邮件中有多个同名附件，请指定部件编号。");
  const [ref] = list;
  return saveFile(ctx, ref.filename, await download(box, input.id, ref.part), ref.mimeType);
}
async function folders(box, input) {
  if (input.action === "create") {
    if (!input.name?.trim() || /[\r\n\0]/.test(input.name)) throw fail("MAIL_FOLDER", "邮件文件夹名称无效。");
    const result = await box.client.mailboxCreate(input.name);
    if (!result) throw fail("MAIL_FOLDER_CREATE", "服务器未确认创建文件夹。");
    return { folder: input.name };
  }
  const entries = await box.client.list({ statusQuery: { messages: true, unseen: true } });
  const filtered = entries.filter(x => !x.flags.has("\\Noselect") && (!input.name || x.path === input.name));
  const start = Number(input.cursor || 0), limit = input.limit || 30;
  if (!Number.isSafeInteger(start) || start < 0) throw fail("MAIL_CURSOR", "文件夹列表游标无效。");
  return { folders: filtered.slice(start, start + limit).map(x => ({ folder: x.path, specialUse: x.specialUse,
    messages: x.status?.messages, unread: x.status?.unseen })), nextCursor: start + limit < filtered.length ? String(start + limit) : null };
}
async function modify(box, input) {
  const ids = [...new Set(input.ids || [])];
  if (!ids.length) throw fail("MAIL_ID_REQUIRED", "请指定要整理的邮件。");
  const uids = ids.map(id => imap.uidOf(box, id)), range = uids.join(",");
  const rows = await box.client.fetchAll(range, { uid: true }, { uid: true });
  if (rows.length !== ids.length) throw fail("MAIL_GONE", "所选邮件中有邮件已离开这个文件夹。");
  const flags = { read: ["\\Seen", true], unread: ["\\Seen", false], star: ["\\Flagged", true], unstar: ["\\Flagged", false] };
  if (flags[input.action]) {
    const [flag, add] = flags[input.action];
    const updated = await box.client[add ? "messageFlagsAdd" : "messageFlagsRemove"](range, [flag], { uid: true });
    if (!updated) throw fail("MAIL_FLAGS", "服务器未确认更新邮件标记。");
    const after = await box.client.fetchAll(range, { uid: true, flags: true }, { uid: true });
    if (after.length !== ids.length || after.some(r => r.flags?.has(flag) !== add)) throw fail("MAIL_FLAGS", "邮件标记复查与请求不一致。");
  } else {
    const special = { archive: "\\Archive", trash: "\\Trash" };
    let folder = input.action === "restore" ? "INBOX" : input.destination;
    if (special[input.action] && !folder) folder = (await box.client.list()).find(x => x.specialUse === special[input.action])?.path;
    if (!["archive", "trash", "restore", "move"].includes(input.action)) throw fail("MAIL_FEATURE", "按标签整理需要 Gmail 连接。");
    if (!folder) throw fail("MAIL_DESTINATION", "请指定目标文件夹。");
    if (folder === box.folder || (folder.toUpperCase() === "INBOX" && box.folder.toUpperCase() === "INBOX")) throw fail("MAIL_DESTINATION", "所选邮件已经在目标文件夹中。");
    // The library's MOVE fallback can expunge unrelated messages on old servers.
    if (!box.client.capabilities.has("MOVE") && !box.client.capabilities.has("IMAP4REV2")) throw fail("MAIL_MOVE_UNSUPPORTED", "邮件服务器未提供 MOVE。");
    if (!await box.client.messageMove(range, folder, { uid: true })) throw fail("MAIL_MOVE", "服务器未确认移动邮件。");
  }
  return { modifiedIds: ids };
}
module.exports = { file, download, folders, modify, fetchItem };
