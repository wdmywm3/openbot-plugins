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
  for (const entry of catalog.personas || []) {
    assert.match(entry.ref, /^[a-f0-9]{40}$/);
    const read = resource => {
      const bytes = execFileSync("git", ["show", `${entry.ref}:${resource.file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(bytes.length, resource.size);
      assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), resource.sha256);
      return JSON.parse(bytes.toString("utf8"));
    };
    const core = read(entry);
    assert.equal(core.id, entry.id); assert.equal(core.version, entry.version);
    if (entry.referenceCount !== undefined) {
      assert.equal(core.referenceImages?.length, entry.referenceCount);
      assert(core.referenceImages.every(image => core.assets.some(asset => asset.id === image.asset)), "role references belong to the core package");
    }
    if (entry.media) {
      assert.equal(core.schemaVersion, 2, "legacy hosts must reject split-media packs before updating a role");
      assert.equal(core.stickers.length, 0, "optional media is not included in the core package");
      const media = read(entry.media);
      assert.equal(media.id, entry.id); assert.equal(media.version, entry.version); assert.equal(media.schemaVersion, 2);
      assert.equal(media.stickers.length, entry.media.count);
      if (entry.preview) {
        assert.ok(entry.preview.size <= 4 * 1024 * 1024);
        const preview = read(entry.preview);
        assert.equal(preview.id, entry.id); assert.equal(preview.version, entry.version);
        assert.deepEqual(preview.stickers.map(sticker => sticker.id), media.stickers.map(sticker => sticker.id));
      }
    }
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
