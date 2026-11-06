"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
for (const name of ["catalog.json", "catalog-v2.json"]) {
const filename = path.join(root, name);
if (fs.existsSync(filename)) {
  const catalog = JSON.parse(fs.readFileSync(filename, "utf8"));
  assert.equal(catalog.schemaVersion, 1);
  for (const entry of catalog.plugins) {
    assert.ok(entry.files.reduce((sum, file) => sum + file.size, 0) <= (name === "catalog.json" ? 10 : 50) * 1024 * 1024);
    assert.match(entry.ref, /^[a-f0-9]{40}$/);
    for (const file of entry.files) {
      assert.ok(file.size <= (name === "catalog.json" ? 2 : 50) * 1024 * 1024);
      const bytes = execFileSync("git", ["show", `${entry.ref}:plugins/${entry.id}/${file.path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(bytes.length, file.size);
      assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), file.sha256);
    }
    const manifest = JSON.parse(execFileSync("git", ["show", `${entry.ref}:plugins/${entry.id}/plugin.json`], { cwd: root }));
    assert.equal(entry.version, manifest.version);
    assert.deepEqual(entry.permissions, manifest.extensions?.["com.openbot"]?.permissions || manifest.permissions);
  }
  console.log(`${name}: ${catalog.plugins.length} immutable packages verified`);
} else console.log("catalog not generated yet");
}

// Regenerating plugin entries must not silently discard the character market.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-catalog-sections-"));
try {
  const git = (...args) => execFileSync("git", args, { cwd: temp, stdio: "pipe" });
  fs.mkdirSync(path.join(temp, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(temp, "plugins", "sample"), { recursive: true });
  fs.copyFileSync(path.join(root, "scripts", "build-catalog.cjs"), path.join(temp, "scripts", "build-catalog.cjs"));
  fs.writeFileSync(path.join(temp, "plugins", "sample", "plugin.json"), JSON.stringify({ id: "sample", name: "Sample", version: "1.0.0" }));
  const personas = [{ id: "xixi", version: "1.1.14", file: "personas/xixi.openbot-persona.json" }];
  fs.writeFileSync(path.join(temp, "catalog.json"), JSON.stringify({ schemaVersion: 1, plugins: [], personas }));
  fs.writeFileSync(path.join(temp, "catalog-v2.json"), JSON.stringify({ schemaVersion: 1, plugins: [], personas }));
  git("init", "-q"); git("add", "plugins");
  git("-c", "user.name=OpenBot test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  execFileSync(process.execPath, [path.join(temp, "scripts", "build-catalog.cjs")], { cwd: temp });
  for (const name of ["catalog.json", "catalog-v2.json"]) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, name), "utf8")).personas, personas);
  console.log("Catalog generation preserves character-market entries");
} finally {
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
