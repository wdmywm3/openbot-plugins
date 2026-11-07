"use strict";
// Replace the six trial illustrations and attach the approved persona references.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const sharp = require("../plugins/meme-library/node_modules/sharp");
const source = process.argv[2];
if (!source) throw Error("Usage: node scripts/add-xixi-stickers.cjs <directory with six stickers and reference-front/back/chibi.png>");
const root = path.resolve(__dirname, "../personas"), version = "1.1.17";
const oldAppearance = "浅蓝短发、蓝眼睛、猫耳长尾，音符和四角星发饰，白色连帽斗篷短裙配深蓝饰带，左腿有挂着音符的蓝色腿环。清爽，不性感，没有耳机、兽爪和翅膀。";
const approvedAppearance = "浅蓝色短发、蓝眼睛、白绒猫耳、蓝色长尾，脸颊两侧各有两道蓝色猫纹。发间有银色四角星和金色短条发夹。穿白色蓝边的连帽斗篷裙，胸前是带银星扣的深蓝蝴蝶结，脖子和锁骨自然露出。整体清爽。";
const entries = [
  { id: "q-you-okay", file: "01-sweat.png", name: "嘻嘻Q版：你没事吧你", caption: "浅蓝发猫娘摊开双手，流着冷汗，疑惑又无语地看向对方，文字是你没事吧你。", ocrText: "你没事吧你", meaning: "对离谱言行表示无语、疑惑或轻松吐槽。", tags: ["汗颜", "无语", "你没事吧", "疑惑", "吐槽"], examples: ["朋友说了离谱的玩笑", "聊天中被奇怪提议整无语"], avoid: ["对方认真求助或表达痛苦", "严肃冲突或需要安慰"] },
  { id: "q-drooling-rice", file: "02-drool.png", name: "嘻嘻Q版：流口水", caption: "嘻嘻趴着托腮看一碗白饭，眼神馋馋的，嘴角流口水。", ocrText: "", meaning: "看到想吃的东西或喜欢的事物，表达馋了、好想要。", tags: ["流口水", "馋", "想吃", "白饭", "想要"], examples: ["朋友分享好吃的", "看到特别喜欢的东西"], avoid: ["对方描述饥饿或经济困境", "不适合轻松玩笑的认真话题"] },
  { id: "q-proud-hands-on-hips", file: "03-proud.png", name: "嘻嘻Q版：得意叉腰", caption: "嘻嘻双手叉腰抬起下巴，猫尾翘起，笑得很得意。", ocrText: "", meaning: "被夸后的骄傲、得意或熟人间俏皮嘴硬。", tags: ["得意", "叉腰", "骄傲", "哼", "嘴硬"], examples: ["被朋友夸奖", "和朋友玩闹时小小炫耀"], avoid: ["对方正在难过或认真求助", "需要道歉时"] },
  { id: "q-thought-template", file: "04-thought-template.png", name: "嘻嘻Q版：想法填字", caption: "右下角是手指抵下巴思考的嘻嘻，左上方有空白的思考泡泡，可按聊天填写短句。", ocrText: "", meaning: "用短句表达想法、疑惑、玩梗或熟人之间的轻松吐槽。", tags: ["思考", "想法", "可填字", "吐槽", "玩梗", "白痴"], examples: ["想表达一个有趣的念头", "熟人之间适度用白痴一类说法打趣", "对聊天中的事困惑或玩梗"], avoid: ["对方认真求助、难过或明确不喜欢被逗", "用来攻击人格或持续辱骂"], textTemplate: { version: 1, rect: { x: .115, y: .13, width: .43, height: .22 }, color: "#192550", align: "center", maxFontSize: .075 } },
  { id: "q-eat-a-little", file: "05-eat-a-little.png", name: "嘻嘻Q版：你好我吃一点", caption: "嘻嘻拿筷子夹白饭，文字是你好我吃一点。", ocrText: "你好，我吃一点", meaning: "调皮地讨一口吃的，也可以在分享好东西时接偷吃的梗。", tags: ["你好我吃一点", "偷吃", "白饭", "筷子", "馋"], examples: ["朋友晒吃的", "群里分享好东西时俏皮接梗"], avoid: ["对方因食物或钱财正处于困难中"] },
  { id: "q-peek", file: "06-peek.png", name: "嘻嘻Q版：探头", caption: "嘻嘻从边缘探出脑袋和双手，睁大眼睛好奇地看过来。", ocrText: "", meaning: "探头围观、好奇或轻轻打招呼。", tags: ["探头", "好奇", "围观", "看看", "冒泡"], examples: ["发现感兴趣的话题", "轻轻探头打招呼"], avoid: ["对方正在认真表达痛苦或寻求帮助"] },
];
const assetId = bytes => "image-" + crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 24);
async function main() {
  const suffixes = ["", ".media", ".preview"], bundles = [];
  for (const suffix of suffixes) {
    const file = path.join(root, `xixi${suffix}.openbot-persona.json`), bundle = JSON.parse(await fs.readFile(file, "utf8"));
    if (bundle.id !== "xixi" || !["1.1.16", version].includes(bundle.version) || (suffix && bundle.stickers.length !== 39)) throw Error(`Unexpected source package: ${file}`);
    bundle.version = version;
    bundle.profile.systemPrompt = bundle.profile.systemPrompt.replace(oldAppearance, approvedAppearance);
    if (!bundle.profile.systemPrompt.includes(approvedAppearance)) throw Error(`Appearance section missing: ${file}`);
    if (typeof bundle.profile.description === "string") {
      bundle.profile.description = bundle.profile.description.replace("蓝发蓝眼、白色斗篷装的音游猫娘", "浅蓝发蓝眼、戴银星和金色发夹、穿白蓝斗篷的猫娘");
    }
    bundles.push({ suffix, file, bundle });
  }
  for (const entry of entries) {
    const sourceBytes = await fs.readFile(path.join(source, entry.file));
    const original = await sharp(sourceBytes).resize(768, 768, { fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
    const preview = await sharp(original).resize(256, 256, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    const id = assetId(original);
    const analysis = { caption: entry.caption, ocrText: entry.ocrText, meaning: entry.meaning,
      tags: ["嘻嘻", "Q版", ...entry.tags], usageExamples: entry.examples, avoidContexts: entry.avoid };
    const sticker = { id: entry.id, name: entry.name, description: entry.caption, tags: analysis.tags, enabled: true, asset: id,
      metadata: { "meme-library": { schemaVersion: 1, analysis, ...(entry.textTemplate ? { textTemplate: entry.textTemplate } : {}), review: "visual review 2026-11-07" } } };
    for (const target of bundles.filter(item => item.suffix)) {
      const index = target.bundle.stickers.findIndex(item => item.id === sticker.id);
      if (index < 0) throw Error(`Missing trial sticker: ${sticker.id}`);
      const previousAsset = target.bundle.stickers[index].asset;
      target.bundle.stickers[index] = sticker;
      if (target.bundle.avatar !== previousAsset && !target.bundle.stickers.some(item => item.asset === previousAsset)) {
        target.bundle.assets = target.bundle.assets.filter(asset => asset.id !== previousAsset);
      }
      if (!target.bundle.assets.some(asset => asset.id === id)) {
        target.bundle.assets.push({ id, mimeType: "image/webp", dataBase64: (target.suffix === ".preview" ? preview : original).toString("base64") });
      }
    }
  }
  const core = bundles.find(item => !item.suffix).bundle;
  const previousReferences = new Set((core.referenceImages || []).map(item => item.asset));
  core.assets = core.assets.filter(item => item.id === core.avatar || !previousReferences.has(item.id));
  core.referenceImages = [];
  for (const [view, name] of [["front", "嘻嘻 · 正面"], ["back", "嘻嘻 · 背面"], ["chibi", "嘻嘻 · Q 版"]]) {
    const bytes = await sharp(path.join(source, `reference-${view}.png`)).resize(1280, 1280, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 94 }).toBuffer();
    const asset = assetId(bytes);
    core.referenceImages.push({ id: `xixi-${view}`, name, view, asset });
    if (!core.assets.some(item => item.id === asset)) core.assets.push({ id: asset, mimeType: "image/webp", dataBase64: bytes.toString("base64") });
  }
  for (const { file, bundle } of bundles) {
    const data = JSON.stringify(bundle);
    if (Buffer.byteLength(data) > (file.includes(".preview.") ? 4 : 32) * 1024 * 1024) throw Error("Package exceeds size limit");
    await fs.writeFile(file, data);
    console.log(`${path.basename(file)}: ${bundle.stickers.length} stickers, ${Buffer.byteLength(data)} bytes`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
