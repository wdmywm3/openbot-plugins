"use strict";
// Local, immutable review/install candidates. The published catalog still requires a real committed source ref.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), host = path.resolve(process.env.OPENBOT_HOST_ROOT || path.join(root, "../openbot"));
const fromHost = require("node:module").createRequire(path.join(host, "package.json"));
const Zip = fromHost("jszip"), { readPluginPackage } = fromHost("./electron/lib/plugins/plugin-package.cjs");
const digest = data => crypto.createHash("sha256").update(data).digest("hex");
const args = process.argv.slice(2), verify = args.includes("--verify"), selection = args.indexOf("--only");
const selected = selection < 0 ? null : new Set(String(args[selection + 1] || "").split(",").filter(Boolean));
if (selected && (!selected.size || [...selected].some(name => !/^[a-z0-9][a-z0-9-]*$/.test(name)))) throw Error("--only requires comma-separated plugin directory names");
const target = args.find((value, index) => !["--verify", "--only"].includes(value) && (selection < 0 || index !== selection + 1));
if (!target) throw Error("Usage: node scripts/prepare-candidates.cjs DESTINATION [--verify] [--only name,name]");
const output = path.resolve(target);
function inside(base, relative) {
  const value = path.resolve(base, relative), rel = path.relative(base, value);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw Error("Invalid candidate path"); return value;
}
async function verifyCandidates() {
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "candidates.json"), "utf8"));
  assert.equal(manifest.schemaVersion, "openbot-local-candidates/1");
  for (const plugin of manifest.plugins) {
    const directory = inside(output, plugin.directory), archive = fs.readFileSync(inside(output, plugin.archive));
    assert.equal(digest(archive), plugin.archiveSha256);
    const zip = await Zip.loadAsync(archive);
    assert.equal(Object.values(zip.files).filter(entry => !entry.dir).length, plugin.files.length);
    for (const file of plugin.files) {
      const bytes = fs.readFileSync(inside(directory, file.path));
      assert.equal(bytes.length, file.size); assert.equal(digest(bytes), file.sha256);
      assert.equal(digest(await zip.file(file.path).async("nodebuffer")), file.sha256);
    }
    const current = readPluginPackage(directory); assert.equal(current.manifest.version, plugin.version); assert.equal(current.manifest.id, plugin.id);
  }
  console.log(`Verified ${manifest.plugins.length} immutable local candidates and ZIP contents.`);
}
async function main() {
  if (verify) return verifyCandidates();
  if (fs.existsSync(output)) throw Error("Use a new output directory; existing candidates are never overwritten");
  fs.mkdirSync(output, { recursive: true });
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "catalog-v2.json"), "utf8")).plugins;
  const manifest = { schemaVersion: "openbot-local-candidates/1", status: "unpublished", createdAt: new Date().toISOString(),
    hostVersion: JSON.parse(fs.readFileSync(path.join(host, "package.json"))).version,
    hostFeatures: fromHost("./electron/lib/plugins/plugin-protocol.cjs").FEATURES, plugins: [] };
  for (const name of fs.readdirSync(path.join(root, "plugins")).sort()) {
    if (selected && !selected.has(name)) continue;
    const source = path.join(root, "plugins", name); if (!fs.existsSync(path.join(source, "plugin.json"))) continue;
    const pack = readPluginPackage(source), directory = `packages/${name}`, archive = `${name}-${pack.manifest.version}.zip`;
    const dest = inside(output, directory), files = [], zip = new Zip();
    function copy(from, prefix = "") {
      for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if ([".git", "node_modules", "__pycache__"].includes(entry.name) || /\.py[co]$/i.test(entry.name)) continue;
        if (entry.isSymbolicLink()) throw Error("Candidate packages cannot contain symlinks");
        const relative = prefix + entry.name, file = path.join(from, entry.name);
        if (entry.isDirectory()) copy(file, relative + "/");
        else if (entry.isFile()) { const bytes = fs.readFileSync(file), destination = inside(dest, relative);
          fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes, { flag: "wx" });
          files.push({ path: relative, size: bytes.length, sha256: digest(bytes) }); zip.file(relative, bytes, { date: new Date("2000-01-01T00:00:00Z") }); }
      }
    }
    copy(source);
    assert(files.reduce((sum, file) => sum + file.size, 0) <= 50 * 1024 * 1024, "Package exceeds catalog limit");
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    fs.writeFileSync(inside(output, archive), bytes, { flag: "wx" });
    const previous = catalog.find(item => item.id === pack.manifest.id);
    manifest.plugins.push({ id: pack.manifest.id, name: pack.manifest.name, version: pack.manifest.version,
      previousPublishedVersion: previous?.version || null, requiredFeatures: pack.manifest.requiredFeatures || [],
      directory, archive, archiveSha256: digest(bytes), sourceSha256: digest(JSON.stringify(files)), files });
  }
  if (selected && manifest.plugins.length !== selected.size) throw Error("An explicitly selected plugin directory is missing");
  fs.writeFileSync(path.join(output, "candidates.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  fs.writeFileSync(path.join(output, "README.md"), "# 本地插件候选包\n\n这些包包含当前源码，尚未发布到市场。可在 OpenBot 的插件导入入口选择 packages 下的目录进行本地验收。ZIP 与目录逐文件核验。\n\n正式发布需将对应源码提交到插件仓库，再用该提交生成生产目录；不能用候选包摘要冒充远程 Git 提交。\n\n" + manifest.plugins.map(p => `- ${p.name} ${p.version}：${p.directory}`).join("\n") + "\n", { flag: "wx" });
  await verifyCandidates();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
