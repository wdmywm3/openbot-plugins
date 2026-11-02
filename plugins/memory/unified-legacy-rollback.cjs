"use strict";
const { decodeRecord } = require("./lib/plugins/plugin-record-codec.cjs");
const { get, readMemory } = require("./unified-state.cjs");
async function convert(ctx, storage, scope, runId) {
  const rows = storage.db.prepare("SELECT * FROM channel_dream_undo WHERE channel_id=? AND chat_id=? AND run_id=? ORDER BY kind,item_id").all(scope.channelId, scope.chatId, runId);
  const changes = [], conflicts = [], covered = new Set();
  const blob = id => { const row = storage.db.prepare("SELECT * FROM channel_dream_run_payloads WHERE hash=?").get(id); if (!row) throw Error("旧审计正文缺失"); return decodeRecord(row); };
  if (!rows.length) return { changes, conflicts: ["这条旧整理记录没有保存可补偿的修改前版本；原日志已保留。"] };
  for (const row of rows.filter(item => ["memory", "record"].includes(item.kind))) {
    try {
      const before = blob(row.before_hash), after = blob(row.after_hash), family = row.kind === "memory" ? "fact" : "record";
      const mapping = get(storage, `unified-map:${scope.chatId}:${family}:${row.item_id}`);
      if (!mapping || !after) throw Error("旧对象没有可用的新编号，不能恢复删除内容");
      const current = await readMemory(ctx, scope, mapping.id, { historical: true });
      if (!current || current.revision !== mapping.revision || current.attributes?.legacy?.revision !== after.revision) throw Error("记录已有后续变更，不能覆盖");
      let beforeRevision = null;
      if (before) {
        let cursor = 0;
        do {
          const page = await ctx.api.memory({ action: "history", chatId: scope.chatId, id: mapping.id, after: cursor, limit: 100 });
          for (const version of page.items) {
            const old = await readMemory(ctx, scope, mapping.id, { revision: version.revision, historical: true, complete: false });
            if (old?.attributes?.legacy?.revision === before.revision) beforeRevision = version.revision;
          }
          cursor = page.nextCursor;
        } while (cursor != null);
        if (!beforeRevision) throw Error("修改前正文未能映射，需核对旧文件");
      }
      changes.push({ id: mapping.id, afterRevision: current.revision, beforeRevision });
      for (const value of [before, after]) if (value?.documentRef?.artifactId) covered.add(value.documentRef.artifactId);
    } catch (error) { conflicts.push(`${row.item_id}：${error.message}`); }
  }
  for (const row of rows.filter(item => !["memory", "record"].includes(item.kind))) {
    const before = blob(row.before_hash), after = blob(row.after_hash);
    if (row.kind === "document" && covered.has((after || before)?.artifactId)) continue;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    conflicts.push(`${row.kind} ${row.item_id}：旧策略或独立文件变更需单独核对，未生成覆盖操作`);
  }
  return { changes, conflicts };
}
module.exports = { convert };
