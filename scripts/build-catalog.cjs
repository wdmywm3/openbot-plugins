"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const ref = process.argv[2] || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error("Use a committed Git SHA");
const filesAtRef = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", "plugins"], { cwd: root, encoding: "utf8" }).trim().split("\n");
const read = file => execFileSync("git", ["show", `${ref}:${file}`], { cwd: root });
const plugins = filesAtRef.filter(file => /^plugins\/[^/]+\/plugin.json$/.test(file)).map(file => {
  const raw = JSON.parse(read(file));
  const ext = raw.extensions?.["com.openbot"] || {};
  const manifest = raw.$schema ? { ...ext, id: raw.name, name: ext.displayName || raw.name, version: raw.version, description: raw.description } : raw;
  const base = file.slice(0, -"plugin.json".length);
  const names = filesAtRef.filter(item => item.startsWith(base)).map(item => item.slice(base.length));
  const components = ["commands", "events", "hooks", "tools"].filter(key => manifest[key]?.length);
  if (manifest.background?.export) components.push("background");
  if (names.some(name => /(?:^|\/)SKILL\.md$/.test(name))) components.push("skills");
  if (names.includes("mcp.json") || names.includes(".mcp.json")) components.push("mcp");
  const metadata = { usage: (manifest.commands || []).map(command => `/${command.name} ${command.description || ""}`.trim()).join("\n"),
    platforms: [], requirements: [], changelog: "", ...manifest.metadata, components,
    hasBackgroundAgent: manifest.background?.agent === true || manifest.background?.agent?.enabled === true };
  return { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description,
    category: manifest.category || "utility", main: manifest.main || "", permissions: manifest.permissions || [], metadata, ref,
    files: filesAtRef.filter(item => item.startsWith(base)).map(item => {
      const bytes = read(item);
      return { path: item.slice(base.length), size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    }) };
});
fs.writeFileSync(path.join(root, "catalog.json"), JSON.stringify({ schemaVersion: 1, plugins }, null, 2) + "\n");
console.log(`Catalog contains ${plugins.length} plugins pinned to ${ref}`);
