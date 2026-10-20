"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."), filename = path.join(root, "catalog.json");
if (fs.existsSync(filename)) {
  const catalog = JSON.parse(fs.readFileSync(filename, "utf8"));
  assert.equal(catalog.schemaVersion, 1);
  for (const entry of catalog.plugins) {
    assert.match(entry.ref, /^[a-f0-9]{40}$/);
    for (const file of entry.files) {
      const bytes = execFileSync("git", ["show", `${entry.ref}:plugins/${entry.id}/${file.path}`], { cwd: root });
      assert.equal(bytes.length, file.size);
      assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), file.sha256);
    }
    const manifest = JSON.parse(execFileSync("git", ["show", `${entry.ref}:plugins/${entry.id}/plugin.json`], { cwd: root }));
    assert.equal(entry.version, manifest.version);
    assert.deepEqual(entry.permissions, manifest.permissions);
  }
  console.log(`catalog: ${catalog.plugins.length} immutable packages verified`);
} else console.log("catalog not generated yet");
