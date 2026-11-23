"use strict";
const { get, put } = require("./unified-state.cjs");
const { DAY, WINDOW, human, stickerId, label, expression, occasions, mediaOnly } = require("./unified-profile-usage.cjs");
const { sample: impressionSample } = require("./unified-profile-impressions.cjs");

const cursorKey = scope => "plus:profile-feed:" + scope.chatId;
const planKey = scope => "plus:profile-plan:" + scope.chatId;
const TEXT = "text";
const sensitive = content => require("./unified-dream.cjs").containsSecret(content);
function usable(row, scope, floor, now) {
  return human(row) && (!row.chatId || row.chatId === scope.chatId) && typeof row.id === "string" && !!row.id
    && typeof row.version === "string" && !!row.version && Number.isSafeInteger(row.seq) && row.seq > floor
    && Number.isSafeInteger(row.createdAt) && row.createdAt >= now - WINDOW && row.createdAt <= now && !sensitive(row.content);
}
function ref(row, signal, title = "") {
  return { id: row.id, version: row.version, at: row.createdAt, seq: row.seq, subject: String(row.sender.id), signal, title,
    substantive: signal === TEXT && impressionSample(row) ? 1 : 0 };
}
// A visible segment can identify a distinctive expression or name a sticker.
// Keep just the candidate and its source reference when the segment commits.
function hints(scope, materials, suggestions, floor, now = Date.now()) {
  const rows = new Map(materials.filter(row => usable(row, scope, floor, now)).map(row => [row.id, row]));
  const result = [];
  for (const hint of (suggestions || []).slice(0, 24)) {
    const row = rows.get(hint?.messageId);
    if (!row) continue;
    if (hint.type === "expression" && expression(hint.expression) && row.content.includes(hint.expression))
      result.push(ref(row, "expression:" + hint.expression));
    if (hint.type === "sticker" && label(hint.label)) {
      const attachment = row.attachments?.find(a => a.index === hint.index && stickerId(a, row));
      if (attachment) result.push(ref(row, "sticker:" + stickerId(attachment, row), label(hint.label)));
    }
  }
  return result;
}
function insertStatement(storage) {
  return storage.db.prepare(`INSERT INTO profile_observations(chat,id,signal,subject,version,seq,at,label,substantive) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat,id,signal) DO UPDATE SET subject=excluded.subject,version=excluded.version,seq=excluded.seq,at=excluded.at,substantive=excluded.substantive,
    label=CASE WHEN excluded.version=version AND excluded.label='' THEN label ELSE excluded.label END WHERE excluded.seq>=seq`);
}
function append(storage, scope, refs, insert) {
  if (!refs?.length) return;
  insert ||= insertStatement(storage);
  for (const row of refs) insert.run(scope.chatId, row.id, row.signal, row.subject, row.version, row.seq, row.at, row.title || "", row.substantive || 0);
}
function importLegacy(storage, scope, floor, now, usages, people) {
  const refs = [];
  function add(subject, signal, rows) {
    for (const row of rows || []) if (subject && row.id && row.version && Number.isSafeInteger(row.seq) && row.seq > floor
      && row.at >= now - WINDOW && row.at <= now) refs.push({ ...row, subject, signal, title: label(row.title), substantive: signal === TEXT ? 1 : 0 });
  }
  for (const item of usages || []) {
    if (item.type === "sticker" && item.value || item.type === "expression" && expression(item.value))
      add(item.subject, item.type + ":" + item.value, item.refs);
  }
  for (const item of people || []) add(item.subject, TEXT, item.refs);
  append(storage, scope, refs);
}
function migrate(storage, scope, floor, now) {
  const old = ["plus:profile-usage:", "plus:impression-samples:"].map(prefix => prefix + scope.chatId);
  const values = old.map(k => get(storage, k));
  if (!values.some(Boolean)) return;
  storage.db.exec("SAVEPOINT profile_samples_upgrade");
  try {
    importLegacy(storage, scope, floor, now, ...values);
    storage.db.prepare("DELETE FROM plugin_meta WHERE key IN (?,?)").run(...old);
    storage.db.exec("RELEASE profile_samples_upgrade");
  } catch (error) { storage.db.exec("ROLLBACK TO profile_samples_upgrade; RELEASE profile_samples_upgrade"); throw error; }
}
function prune(storage, scope, now) {
  storage.db.prepare("DELETE FROM profile_observations WHERE chat=? AND at<?").run(scope.chatId, now - WINDOW);
  storage.db.prepare(`DELETE FROM profile_reviews WHERE chat=? AND NOT EXISTS
    (SELECT 1 FROM profile_observations o WHERE o.chat=profile_reviews.chat AND o.subject=profile_reviews.subject AND o.signal=profile_reviews.signal)`).run(scope.chatId);
}
function reset(storage, chatId) {
  storage.db.prepare("DELETE FROM profile_observations WHERE chat=?").run(chatId);
  storage.db.prepare("DELETE FROM profile_reviews WHERE chat=?").run(chatId);
  storage.db.prepare("DELETE FROM plugin_meta WHERE key IN (?,?)").run(cursorKey({ chatId }), planKey({ chatId }));
}
async function scan(ctx, storage, scope, floor, upper, assertLive, now) {
  const db = storage.db, key = cursorKey(scope);
  let after = Math.max(get(storage, key, 0), floor);
  const obsolete = db.prepare("DELETE FROM profile_observations WHERE chat=? AND id=? AND seq<=? AND (version<>? OR subject<>?)");
  const revoked = db.prepare("DELETE FROM profile_observations WHERE chat=? AND id=? AND seq<=?");
  const insert = insertStatement(storage);
  for (let pageIndex = 0; pageIndex < 4 && after < upper; pageIndex++) {
    const page = await ctx.api.sources({ action: "changes", chatId: scope.chatId, after, upper, limit: 80 });
    assertLive();
    if (!Array.isArray(page.items) || !Number.isSafeInteger(page.upper) || page.upper < after || page.upper > upper) throw Error("画像资料位置无效");
    db.exec("SAVEPOINT profile_feed");
    try {
      for (const row of page.items) {
        if (!Number.isSafeInteger(row.seq) || row.seq <= after || row.seq > page.upper) throw Error("画像资料顺序无效");
        after = row.seq;
        if (!usable(row, scope, floor, now)) {
          if (!row.chatId || row.chatId === scope.chatId) revoked.run(scope.chatId, row.id, row.seq);
          continue;
        }
        obsolete.run(scope.chatId, row.id, row.seq, row.version, String(row.sender.id));
        const refs = [];
        if (row.content.trim().length >= 2 && !mediaOnly(row.content)) refs.push(ref(row, TEXT));
        for (const media of row.attachments || []) {
          const id = stickerId(media, row);
          if (id) refs.push(ref(row, "sticker:" + id, label(media.description)));
        }
        append(storage, scope, refs, insert);
      }
      if (page.nextCursor == null) after = page.upper;
      else if (!page.items.length) throw Error("画像资料没有前进");
      put(storage, key, after);
      db.exec("RELEASE profile_feed");
    } catch (error) { db.exec("ROLLBACK TO profile_feed; RELEASE profile_feed"); throw error; }
    if (page.nextCursor == null) break;
  }
  return after;
}
function due(storage, scope, now, upper, limit) {
  return storage.db.prepare(`SELECT o.subject,o.signal,MAX(o.seq) AS through,COALESCE(r.reviewed,0) AS reviewed
    FROM profile_observations o LEFT JOIN profile_reviews r ON r.chat=o.chat AND r.subject=o.subject AND r.signal=o.signal
    WHERE o.chat=? AND o.at>=? AND o.seq<=? AND COALESCE(r.reviewed,0)<=? AND COALESCE(r.retry_at,0)<=?
    GROUP BY o.subject,o.signal HAVING COUNT(*)>=3 AND MAX(o.at)-MIN(o.at)>=? AND MAX(o.seq)>COALESCE(r.through,0)
    ORDER BY reviewed, MIN(o.seq),o.subject,o.signal LIMIT ?`).all(scope.chatId, now - WINDOW, upper, now - 7 * DAY, now, 2 * DAY, limit);
}
function mark(storage, scope, item) {
  storage.db.prepare(`INSERT INTO profile_reviews(chat,subject,signal,through,reviewed) VALUES(?,?,?,?,?)
    ON CONFLICT(chat,subject,signal) DO UPDATE SET through=MAX(through,excluded.through),reviewed=MAX(reviewed,excluded.reviewed),retry_at=0`)
    .run(scope.chatId, item.subject, item.signal, item.through, item.reviewed);
}
function retry(storage, scope, item, now) {
  storage.db.prepare(`INSERT INTO profile_reviews(chat,subject,signal,through,reviewed,retry_at) VALUES(?,?,?,0,0,?)
    ON CONFLICT(chat,subject,signal) DO UPDATE SET retry_at=excluded.retry_at`).run(scope.chatId, item.subject, item.signal, now + 15 * 60000);
}
function spread(rows, count) {
  if (rows.length <= count) return rows;
  if (count === 1) return [rows.at(-1)];
  return Array.from({ length: count }, (_, i) => rows[Math.round(i * (rows.length - 1) / (count - 1))]);
}
function select(rows, limit) {
  const anchors = spread(occasions(rows), Math.min(8, limit));
  const ids = new Set(anchors.map(r => r.id));
  return [...anchors, ...spread(rows.filter(r => !ids.has(r.id)), limit - anchors.length)].sort((a, b) => a.at - b.at);
}
function sample(storage, scope, item, now) {
  const daily = storage.db.prepare(`SELECT id,version,at,label,substantive FROM (
    SELECT id,version,at,label,substantive,
      ROW_NUMBER() OVER (PARTITION BY at/? ORDER BY at,id) AS first,
      ROW_NUMBER() OVER (PARTITION BY at/? ORDER BY at DESC,id DESC) AS last,
      ROW_NUMBER() OVER (PARTITION BY at/? ORDER BY substantive DESC,at,id) AS rich
    FROM profile_observations WHERE chat=? AND subject=? AND signal=? AND seq<=? AND at>=?)
    WHERE first<=2 OR last=1 OR (substantive=1 AND rich<=2) ORDER BY at,id`).all(DAY, DAY, DAY, scope.chatId, item.subject, item.signal, item.through, now - WINDOW);
  // A qualifying middle send can be neither the first nor the last message on its date.
  if (daily.length >= 3 && occasions(daily).length < 3) {
    const middle = storage.db.prepare(`SELECT id,version,at,label,substantive FROM profile_observations
      WHERE chat=? AND subject=? AND signal=? AND seq<=? AND at BETWEEN ? AND ? ORDER BY at,id LIMIT 1`)
      .get(scope.chatId, item.subject, item.signal, item.through, daily[0].at + DAY, daily.at(-1).at - DAY);
    if (middle && !daily.some(r => r.id === middle.id)) daily.push(middle);
    daily.sort((a, b) => a.at - b.at);
  }
  if (item.signal !== TEXT) return select(daily, 8);
  const substantial = select(daily.filter(r => r.substantive), 14);
  const included = new Set(substantial.map(r => r.id));
  return [...substantial, ...select(daily.filter(r => !included.has(r.id)), 18 - substantial.length)].sort((a, b) => a.at - b.at);
}
module.exports = { TEXT, cursorKey, planKey, usable, hints, append, importLegacy, migrate, prune, reset, scan, due, mark, retry, sample, select };
