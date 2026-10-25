"use strict";
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, ".."), start = "// BEGIN SHARED ACTIVITY LEARNING", end = "// END SHARED ACTIVITY LEARNING";
const block = `${start}\n${fs.readFileSync(path.join(root, "shared/activity-learning.js"), "utf8").trim()}\n${end}\n`;
for (const plugin of ["bilibili-explorer", "android-roamer"]) {
  const file = path.join(root, "plugins", plugin, "index.js"), before = fs.readFileSync(file, "utf8");
  const a = before.indexOf(start), b = before.indexOf(end);
  const next = a < 0 ? before + "\n" + block : before.slice(0, a) + block + before.slice(b + end.length).replace(/^\r?\n/, "");
  if (process.argv.includes("--check")) { if (before !== next) throw Error(`${plugin}: run node scripts/sync-learning.cjs`); }
  else if (before !== next) fs.writeFileSync(file, next);
}
{
  const file = path.join(root, "plugins/bilibili-explorer/index.js"), before = fs.readFileSync(file, "utf8");
  const start = "// BEGIN BILI TEXT READER", end = "// END BILI TEXT READER";
  const block = `${start}\n${fs.readFileSync(path.join(root, "shared/bili-text-reader.js"), "utf8").trim()}\n${end}\n`;
  const a = before.indexOf(start), b = before.indexOf(end);
  const next = a < 0 ? before + "\n" + block : before.slice(0, a) + block + before.slice(b + end.length).replace(/^\r?\n/, "");
  if (process.argv.includes("--check")) { if (before !== next) throw Error("bilibili-explorer: run node scripts/sync-learning.cjs"); }
  else if (before !== next) fs.writeFileSync(file, next);
}
