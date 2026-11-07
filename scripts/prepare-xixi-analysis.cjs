"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");

async function main() {
  const [sourceDirectory, outputDirectory] = process.argv.slice(2);
  if (!sourceDirectory || !outputDirectory) throw Error("Usage: node scripts/prepare-xixi-analysis.cjs <existing persona directory> <output directory>");
  const annotations = JSON.parse(await fs.readFile(path.join(__dirname, "../personas/xixi-sticker-analysis.json"), "utf8"));
  const lookup = new Map(annotations.stickers.map(item => [item.id, item]));
  if (lookup.size !== 33) throw Error("Expected 33 independently reviewed sticker IDs");
  const output = path.resolve(outputDirectory); await fs.mkdir(output, { recursive: true });
  const promptHash = crypto.createHash("sha256").update(annotations.prompt).digest("hex"), files = [];
  for (const suffix of ["", ".media", ".preview"]) {
    const name = `xixi${suffix}.openbot-persona.json`, original = await fs.readFile(path.join(sourceDirectory, name));
    const bundle = JSON.parse(original);
    if (bundle.id !== annotations.personaId) throw Error("Unexpected source persona");
    if (suffix && (bundle.stickers.length !== lookup.size || bundle.stickers.some(item => !lookup.has(item.id)))) throw Error("Source sticker IDs have changed; review the new images first");
    bundle.version = annotations.version;
    bundle.stickers = bundle.stickers.map(item => {
      const reviewed = lookup.get(item.id);
      if (suffix === ".media") {
        const asset = bundle.assets.find(asset => asset.id === item.asset);
        if (!asset || crypto.createHash("sha256").update(Buffer.from(asset.dataBase64, "base64")).digest("hex") !== reviewed.imageSha256) throw Error(`Image changed: ${item.id}; review it again`);
      }
      for (const field of ["caption", "meaning", "ocrText"]) if (typeof reviewed.analysis[field] !== "string") throw Error(`Invalid ${item.id}: ${field}`);
      for (const field of ["tags", "usageExamples", "avoidContexts"]) if (!Array.isArray(reviewed.analysis[field])) throw Error(`Invalid ${item.id}: ${field}`);
      return { ...item, name: reviewed.name, description: reviewed.analysis.caption, tags: reviewed.analysis.tags,
        metadata: { ...item.metadata, "meme-library": { schemaVersion: 1, analysis: reviewed.analysis, promptHash, review: "time-ordered visual samples" } } };
    });
    const bytes = Buffer.from(JSON.stringify(bundle));
    await fs.writeFile(path.join(output, name), bytes);
    files.push({ file: name, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), count: bundle.stickers.length });
    if (JSON.stringify(bundle.assets) !== JSON.stringify(JSON.parse(original).assets)) throw Error("Original image bytes changed");
  }
  await fs.writeFile(path.join(output, "xixi-release.json"), JSON.stringify({ id: "xixi", version: annotations.version, files }, null, 2) + "\n");
  console.log(JSON.stringify({ output, version: annotations.version, files }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
