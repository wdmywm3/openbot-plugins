"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { animationInfo, animationSheet } = require("./animation-image.cjs");
const sharp = require("sharp");
const digest = data => crypto.createHash("sha256").update(data).digest("hex");
const MAX_IMAGE = 10 * 1024 * 1024;

function createEngine(root) {
  fs.mkdirSync(path.join(root, "images"), { recursive: true });
  fs.mkdirSync(path.join(root, "bundles"), { recursive: true });
  fs.mkdirSync(path.join(root, "exports"), { recursive: true });
  const exports = new Map();
  const uploads = new Map();
  const imagePath = hash => {
    if (!/^[a-f0-9]{64}$/.test(hash || "")) throw Error("图片摘要无效");
    return path.join(root, "images", hash);
  };
  function image(hash) {
    const file = imagePath(hash), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE) throw Error("图片无效");
    const bytes = fs.readFileSync(file);
    if (digest(bytes) !== hash) throw Error("图片校验失败");
    return bytes;
  }
  async function call(input, signal) {
    signal?.throwIfAborted();
    if (["exportBegin", "exportAdd", "exportFinish", "exportRead"].includes(input.action)) {
      if (!/^[a-f0-9]{64}$/.test(input.id || "")) throw Error("导出任务编号无效");
      const folder = path.join(root, "exports", input.id);
      const flush = state => {
        if (!state.items.length) return;
        fs.mkdirSync(folder, { recursive: true });
        const bundle = { format: "openbot-sticker-library", version: 1, sourceInstanceId: state.instance,
          preferences: [], items: state.items };
        const name = `${state.files.length + 1}.json`, bytes = Buffer.from(JSON.stringify(bundle));
        fs.writeFileSync(path.join(folder, name), bytes);
        state.files.push({ name, hash: digest(bytes) }); state.items = []; state.bytes = 0;
      };
      if (input.action === "exportBegin") {
        if (!exports.has(input.id) && exports.size >= 8) throw Error("导出任务过多");
        exports.set(input.id, { instance: String(input.instance || ""), items: [], bytes: 0, files: [] }); return { started: true };
      }
      const state = exports.get(input.id);
      if (input.action === "exportRead") {
        if (!/^[1-9][0-9]{0,4}\.json$/.test(input.name || "")) throw Error("导出文件名无效");
        const bytes = fs.readFileSync(path.join(folder, input.name));
        if (bytes.length > MAX_IMAGE) throw Error("导出文件过大");
        return { data: bytes.toString("base64") };
      }
      if (!state) throw Error("导出已中断，请重新导出");
      if (input.action === "exportAdd") {
        const item = { ...input.item, hash: input.hash, data: image(input.hash).toString("base64") }, size = Buffer.byteLength(JSON.stringify(item));
        if (size > 9 * 1024 * 1024) throw Error("这张原图过大，暂不能导出为表情包文件");
        if (state.bytes + size > 9 * 1024 * 1024) flush(state);
        state.items.push(item); state.bytes += size; return { added: true };
      }
      flush(state); exports.delete(input.id); return { files: state.files };
    }
    if (["bundlePut", "bundleInfo", "bundleItem"].includes(input.action)) {
      imagePath(input.hash); // Validate the content-addressed name.
      const file = path.join(root, "bundles", input.hash + ".json");
      if (input.action === "bundlePut") {
        const offset = input.offset, chunk = typeof input.data === "string" && input.data.length <= 48000 ? Buffer.from(input.data, "base64") : null;
        if (!chunk || chunk.toString("base64") !== input.data || !Number.isSafeInteger(offset) || offset < 0 || offset + chunk.length > MAX_IMAGE) throw Error("迁移包分块无效");
        const temp = file + ".partial";
        if (offset === 0) fs.writeFileSync(temp, chunk);
        else { if (!fs.existsSync(temp) || fs.statSync(temp).size !== offset) throw Error("迁移包分块顺序不一致"); fs.appendFileSync(temp, chunk); }
        if (input.done) {
          const bytes = fs.readFileSync(temp); if (digest(bytes) !== input.hash) throw Error("迁移包校验失败");
          const bundle = JSON.parse(bytes.toString("utf8"));
          const items = bundle.format === "openbot-sticker-history" ? bundle.events : bundle.items;
          if (!["openbot-sticker-library", "openbot-sticker-history"].includes(bundle.format) || bundle.version !== 1 || !Array.isArray(items) || items.length > 1000) throw Error("不支持的表情迁移包");
          fs.renameSync(temp, file);
        }
        return { received: offset + chunk.length };
      }
      const bytes = fs.readFileSync(file); if (bytes.length > MAX_IMAGE || digest(bytes) !== input.hash) throw Error("迁移包校验失败");
      const bundle = JSON.parse(bytes.toString("utf8"));
      const history = bundle.format === "openbot-sticker-history", items = history ? bundle.events : bundle.items;
      if (input.action === "bundleInfo") return { history, count: items.length, preferences: bundle.preferences || [], sourceInstanceName: bundle.sourceInstanceName, sourceInstanceId: bundle.sourceInstanceId };
      if (!Number.isInteger(input.index) || input.index < 0 || input.index >= items.length) throw Error("迁移条目编号无效");
      if (history) return items[input.index];
      const item = bundle.items[input.index], image = Buffer.from(item.data || "", "base64");
      if (!image.length || image.length > MAX_IMAGE || image.toString("base64") !== item.data || digest(image) !== item.hash) throw Error("迁移图片校验失败");
      return item;
    }
    if (input.action === "has") { try { image(input.hash); return { present: true }; } catch { return { present: false }; } }
    if (input.action === "put") {
      const file = imagePath(input.hash), offset = input.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || typeof input.data !== "string" || input.data.length > 48000) throw Error("图片分块无效");
      const chunk = Buffer.from(input.data, "base64");
      if (chunk.toString("base64") !== input.data || offset + chunk.length > MAX_IMAGE) throw Error("图片分块过大或编码无效");
      for (const [hash, entry] of uploads) if (entry.at < Date.now() - 300000) uploads.delete(hash);
      let entry = uploads.get(input.hash);
      if (offset === 0) {
        if (!entry && uploads.size >= 8) throw Error("图片上传队列已满");
        entry = { chunks: [], length: 0, at: Date.now() }; uploads.set(input.hash, entry);
      }
      if (!entry || entry.length !== offset) throw Error("图片分块顺序不一致，请重新传入");
      entry.chunks.push(chunk); entry.length += chunk.length; entry.at = Date.now();
      if (input.done) {
        const bytes = Buffer.concat(entry.chunks); uploads.delete(input.hash);
        if (digest(bytes) !== input.hash) throw Error("图片校验失败");
        const meta = await sharp(bytes, { pages: 1, limitInputPixels: 40000000 }).metadata();
        if (!["png", "jpeg", "webp", "gif"].includes(meta.format)) throw Error("不支持的图片格式");
        const temporary = file + "." + crypto.randomUUID();
        try { fs.writeFileSync(temporary, bytes, { flag: "wx" }); fs.renameSync(temporary, file); }
        finally { fs.rmSync(temporary, { force: true }); }
      }
      return { received: entry.length, done: input.done === true };
    }
    if (input.action === "prepare") {
      const bytes = image(input.hash), meta = await sharp(bytes, { pages: 1, limitInputPixels: 40000000 }).metadata();
      const animation = animationInfo(meta);
      if (animation) {
        const sheet = await animationSheet(bytes, animation, { count: 6, signal });
        return { mimeType: "image/png", data: sheet.bytes.toString("base64"), caption: sheet.description };
      }
      const data = await sharp(bytes, { pages: 1, limitInputPixels: 40000000 }).rotate()
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      return { mimeType: "image/jpeg", data: data.toString("base64"), caption: "静态图片" };
    }
    throw Error("未知表情处理操作");
  }
  return { call, close() { uploads.clear(); } };
}

function serve(root) {
  if (!root || !path.isAbsolute(root)) throw Error("需要插件的受管数据目录");
  const engine = createEngine(root), pending = new Map();
  const output = value => process.stdout.write(JSON.stringify(value) + "\n");
  const rl = require("node:readline").createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", line => {
    if (Buffer.byteLength(line) > 128 * 1024) return;
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.method === "notifications/cancelled") { pending.get(message.params?.requestId)?.abort(); return; }
    if (message.id === undefined) return;
    const controller = new AbortController(); pending.set(message.id, controller);
    void (async () => {
      let result;
      if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "meme-library", version: "2.0.0" } };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools: [{ name: "sticker_engine", description: "表情插件内部的动图采样与导入导出。",
        inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: true } }] };
      else if (message.method === "tools/call" && message.params?.name === "sticker_engine") {
        try {
          const value = await engine.call(message.params.arguments || {}, controller.signal);
          result = { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
        } catch (error) { result = { isError: true, content: [{ type: "text", text: String(error.message).slice(0, 1000) }] }; }
      } else throw Error("不支持的方法");
      output({ jsonrpc: "2.0", id: message.id, result });
    })().catch(error => output({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: error.message } }))
      .finally(() => pending.delete(message.id));
  });
  rl.on("close", () => { engine.close(); process.exit(0); });
}
if (require.main === module) serve(process.argv[2]);
module.exports = { createEngine };
