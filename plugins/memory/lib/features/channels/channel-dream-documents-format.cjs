"use strict";

const yaml = require("js-yaml");

const KIND_LABELS = { fact: "事实", preference: "偏好", episode: "经历", goal: "目标", question: "问题", followup: "跟进", topic: "话题", style: "交流偏好" };
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const text = value => typeof value === "string" ? value : "";
const line = value => text(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
const pointer = value => typeof value === "string" && value.trim().length <= 2048 ? value.trim() : "";

function instant(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function sourceIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(pointer).filter(Boolean))].sort(compare);
}

function noteRefs(values) {
  const result = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const ref = {};
    // These are provenance pointers only. File metadata never grants access;
    // the host registry owns document identity, scope and authorization.
    for (const key of ["id", "pluginId", "path", "scope", "revision", "title"]) {
      if (key === "revision" && Number.isSafeInteger(value[key]) && value[key] >= 0) ref[key] = value[key];
      else if (pointer(value[key])) ref[key] = pointer(value[key]);
    }
    if (!ref.id && !ref.path) continue;
    result.set(JSON.stringify(ref), ref);
  }
  return [...result].sort(([a], [b]) => compare(a, b)).map(([, value]) => value);
}

function frontmatter(metadata) {
  return `---\n${yaml.dump(metadata, { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: -1, forceQuotes: true })}---\n\n`;
}

function markdownText(value) {
  return line(value).replace(/([\\`*_{}\[\]<>()!|#])/g, "\\$1");
}

function renderDreamDocument({ id, kind, title, content, createdAt, updatedAt, occurredAt, sourceIds: sources, noteRefs: notes } = {}) {
  const metadata = { id: pointer(id), kind: line(kind) };
  for (const [key, value] of Object.entries({ createdAt, updatedAt, occurredAt })) {
    const date = instant(value);
    if (date) metadata[key] = date.toISOString();
  }
  metadata.sourceIds = sourceIds(sources);
  metadata.noteRefs = noteRefs(notes);
  return `${frontmatter(metadata)}# ${markdownText(title) || "梦境记录"}\n\n${text(content)}\n`;
}

function contentFromDreamDocument(markdown) {
  let body = text(markdown).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  // Split text without evaluating YAML, JSON, tags, or edited identity fields.
  // An incomplete frontmatter block is preserved instead of losing user text.
  const header = body.match(/^---[ \t]*\n(?:[\s\S]*?\n)?---[ \t]*(?:\n|$)/);
  if (header) body = body.slice(header[0].length);
  body = body.replace(/^\n+/, "");
  body = body.replace(/^#[ \t]+[^\n]*(?:\n|$)/, "");
  return body.replace(/^\n+|\n+$/g, "");
}

function linkPath(value) {
  const relative = text(value).replace(/\\/g, "/");
  if (!relative || /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(relative) || /[\u0000-\u001f\u007f]/.test(relative)) return "";
  // Encode raw filesystem path components, including Markdown delimiters.
  // Preserve ../ because a daily index and its subjects occupy sibling folders.
  return relative.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

function renderDreamDaily({ date, timeZone = "UTC", entries = [] } = {}) {
  const day = text(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || instant(`${day}T00:00:00Z`)?.toISOString().slice(0, 10) !== day) throw new Error("梦境日记日期无效");
  if (typeof timeZone !== "string" || !timeZone.trim()) throw new Error("梦境日记时区无效");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const candidates = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !pointer(entry.id)) continue;
    const occurred = instant(entry.occurredAt), href = linkPath(entry.relativePath);
    if (!occurred || !href) continue;
    const parts = Object.fromEntries(formatter.formatToParts(occurred).map(part => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` !== day) continue;
    candidates.push({ id: pointer(entry.id), title: line(entry.title) || "梦境记录", kind: line(entry.kind),
      relativePath: text(entry.relativePath).replace(/\\/g, "/"), occurredAt: occurred.toISOString(),
      href, time: `${parts.hour}:${parts.minute}` });
  }
  candidates.sort((a, b) => compare(a.occurredAt, b.occurredAt) || compare(a.id, b.id)
    || compare(a.relativePath, b.relativePath) || compare(a.kind, b.kind) || compare(a.title, b.title));
  const seen = new Set();
  const documents = candidates.filter(entry => !seen.has(entry.id) && seen.add(entry.id));
  const metadata = { kind: "daily", date: day, timeZone,
    entries: documents.map(({ id, title, kind, relativePath, occurredAt }) => ({ id, title, kind, relativePath, occurredAt })) };
  const body = documents.map(entry => `- ${entry.time} · ${markdownText(Object.hasOwn(KIND_LABELS, entry.kind) ? KIND_LABELS[entry.kind] : entry.kind || "记录")}：[${markdownText(entry.title)}](${entry.href})`).join("\n");
  return `${frontmatter(metadata)}# ${day}\n${body ? `\n${body}\n` : ""}`;
}

module.exports = { renderDreamDocument, contentFromDreamDocument, renderDreamDaily };
