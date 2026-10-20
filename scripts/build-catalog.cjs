"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const ref = process.argv[2] || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error("Use a committed Git SHA");
const filesAtRef = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", "plugins"], { cwd: root, encoding: "utf8" }).trim().split("\n");
const read = file => execFileSync("git", ["show", `${ref}:${file}`], { cwd: root });
const plugins = filesAtRef.filter(file => /^plugins\/[^/]+\/plugin.json$/.test(file)).map(file => {
  const manifest = JSON.parse(read(file));
  const base = file.slice(0, -"plugin.json".length);
  return { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description,
    category: manifest.category || "utility", permissions: manifest.permissions || [], ref,
    files: filesAtRef.filter(item => item.startsWith(base)).map(item => {
      const bytes = read(item);
      return { path: item.slice(base.length), size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    }) };
});
fs.writeFileSync(path.join(root, "catalog.json"), JSON.stringify({ schemaVersion: 1, plugins }, null, 2) + "\n");
console.log(`Catalog contains ${plugins.length} plugins pinned to ${ref}`);
