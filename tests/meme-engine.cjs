"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const engineRoot = path.join(__dirname, "../plugins/meme-library");
const localRequire = require("node:module").createRequire(path.join(engineRoot, "package.json"));
const { createEngine } = localRequire("./engine/server.cjs");
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-meme-engine-")); let engine, index;
  try {
    const png = await localRequire("sharp")({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
    const hash = crypto.createHash("sha256").update(png).digest("hex");
    engine = createEngine(root);
    await assert.rejects(engine.call({ action: "put", hash, offset: 0, data: "bad!", done: true }), /编码/);
    await engine.call({ action: "put", hash, offset: 0, data: png.subarray(0, 20).toString("base64") });
    await assert.rejects(engine.call({ action: "put", hash, offset: 21, data: "aGk=" }), /顺序/);
    await engine.call({ action: "put", hash, offset: 20, data: png.subarray(20).toString("base64"), done: true });
    assert.equal((await engine.call({ action: "has", hash })).present, true);
    const picture = await engine.call({ action: "prepare", hash }); assert.equal(picture.mimeType, "image/jpeg");
    await assert.rejects(engine.call({ action: "embed", hash, text: "蓝色方块" }), /未知/);
    await assert.rejects(engine.call({ action: "prepare", hash: "../secret" }), /摘要/);
    const exportId = "e".repeat(64);
    await engine.call({ action: "exportBegin", id: exportId, instance: "test" });
    await engine.call({ action: "exportAdd", id: exportId, hash, item: { legacyId: "original", mimeType: "image/png", annotation: { caption: "蓝色方块", tags: ["蓝色"] } } });
    const exported = await engine.call({ action: "exportFinish", id: exportId });
    const file = exported.files[0], bundle = await engine.call({ action: "exportRead", id: exportId, name: file.name });
    const bundleBytes = Buffer.from(bundle.data, "base64");
    for (let offset = 0; offset < bundleBytes.length; offset += 32768) {
      await engine.call({ action: "bundlePut", hash: file.hash, offset, data: bundleBytes.subarray(offset, offset + 32768).toString("base64"), done: offset + 32768 >= bundleBytes.length });
    }
    assert.equal((await engine.call({ action: "bundleInfo", hash: file.hash })).count, 1);
    const recovered = await engine.call({ action: "bundleItem", hash: file.hash, index: 0 });
    assert.deepEqual(Buffer.from(recovered.data, "base64"), png); assert.deepEqual(recovered.annotation.tags, ["蓝色"]);
    engine.close();
    console.log("Meme media engine: bounded verified transfer, image preparation and lossless export/import passed; inference belongs to the host");
  } finally {
    engine?.close(); index?.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("openbot-meme-engine-")); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
