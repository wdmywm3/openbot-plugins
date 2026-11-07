"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const engineRoot = path.join(__dirname, "../plugins/meme-library");
const localRequire = require("node:module").createRequire(path.join(engineRoot, "package.json"));
const { createEngine, balanceCjkLines } = localRequire("./engine/server.cjs");
async function main() {
  assert.deepEqual(balanceCjkLines("你到底在想什么呢", 4).split("\n").map(line => [...line].length), [4, 4], "short Chinese lines are balanced");
  assert.equal(balanceCjkLines("Hello world", 4), "Hello world", "Latin word wrapping remains natural");
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
    const template = { version: 1, rect: { x: .1, y: .1, width: .8, height: .7 }, color: "#ff0000", align: "center", maxFontSize: .15 };
    const rendered = await engine.call({ action: "renderText", hash, template, text: "白痴！< & >" });
    assert.equal(rendered.mimeType, "image/webp");
    const pixels = await localRequire("sharp")(Buffer.from(rendered.data, "base64")).raw().toBuffer({ resolveWithObject: true });
    assert([...pixels.data].some((value, i) => i % pixels.info.channels === 0 && value > 100 && pixels.data[i + 2] < 180), "rendered text has visible red pixels");
    assert.equal((await engine.call({ action: "has", hash })).present, true, "rendering preserves the original");
    await assert.rejects(engine.call({ action: "renderText", hash, template: { ...template, rect: { ...template.rect, x: .8 } }, text: "test" }), /区域/);
    await assert.rejects(engine.call({ action: "renderText", hash, template, text: "a".repeat(81) }), /80/);
    const concurrent = await Promise.allSettled(Array.from({ length: 3 }, () => engine.call({ action: "renderText", hash, template, text: "你好" })));
    assert.equal(concurrent.filter(item => item.status === "rejected").length, 1, "render concurrency is bounded");
    const cancel = new AbortController();
    const canceled = engine.call({ action: "renderText", hash, template, text: "取消测试" }, cancel.signal);
    cancel.abort();
    await assert.rejects(canceled, /abort/i, "a canceled render cannot return an image");
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
