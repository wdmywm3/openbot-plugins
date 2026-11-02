"use strict";

// Time-based sampling inspired by dsh-read-animation (MIT); see animation-NOTICE.txt.
// No DSH services or runtime patches are used. Originals are never rewritten.
const sharp = require("sharp");
const INPUT_OPTIONS = { pages: 1, limitInputPixels: 40_000_000, failOn: "error" };

function animationInfo(metadata) {
  if (!["gif", "webp"].includes(metadata.format) || !(metadata.pages > 1)) return null;
  const frameCount = metadata.pages;
  if (!Number.isSafeInteger(frameCount) || frameCount > 100_000) throw new Error("Animation has too many frames");
  let durationMs = 0, substitutedDelays = false;
  const frames = Array.from({ length: frameCount }, (_, index) => {
    const raw = metadata.delay?.[index];
    const delayMs = Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.round(raw)) : 100;
    if (!(Number.isFinite(raw) && raw > 0)) substitutedDelays = true;
    const frame = { index, timeMs: durationMs, delayMs };
    durationMs += delayMs;
    return frame;
  });
  return { frameCount, durationMs, loop: metadata.loop ?? null, substitutedDelays, frames };
}

function frameAt(animation, timeMs) {
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs >= animation.durationMs) {
    throw new Error(`Animation time must be at least 0 and below ${animation.durationMs} ms`);
  }
  let lo = 0, hi = animation.frameCount - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (animation.frames[mid].timeMs <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  return animation.frames[lo];
}

function animationFrame(animation, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= animation.frameCount) {
    throw new Error(`Animation frame must be an integer from 0 to ${animation.frameCount - 1}`);
  }
  return animation.frames[index];
}

function sampleAnimation(animation, count = 8) {
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error("Animation sample count must be from 1 to 16");
  if (count >= animation.frameCount) return animation.frames;
  const indices = new Set();
  for (let i = 0; i < count; i++) {
    const time = count === 1 ? 0 : Math.floor((animation.durationMs - 1) * i / (count - 1));
    indices.add(frameAt(animation, time).index);
  }
  return [...indices].map(index => animation.frames[index]);
}

function frameLabel(frame) {
  return `Frame ${frame.index} @ ${frame.timeMs} ms, duration ${frame.delayMs} ms`;
}

async function animationSheet(bytes, animation, { count = 8, signal } = {}) {
  signal?.throwIfAborted();
  const sampled = sampleAnimation(animation, count);
  const tile = 384, gap = 8, caption = 28;
  const columns = Math.min(3, sampled.length), rows = Math.ceil(sampled.length / columns);
  const width = columns * (tile + gap) - gap, height = rows * (tile + caption + gap) - gap;
  const layers = [];
  // Decode selected pages individually, never a full-height strip of the animation.
  for (const [position, frame] of sampled.entries()) {
    signal?.throwIfAborted();
    const input = await sharp(bytes, { ...INPUT_OPTIONS, page: frame.index }).rotate()
      .resize(tile, tile, { fit: "inside", withoutEnlargement: true }).flatten({ background: "white" })
      .timeout({ seconds: 5 }).png().toBuffer({ resolveWithObject: true });
    signal?.throwIfAborted();
    const left = (position % columns) * (tile + gap), top = Math.floor(position / columns) * (tile + caption + gap);
    layers.push({ input: input.data, left: left + Math.floor((tile - input.info.width) / 2), top: top + Math.floor((tile - input.info.height) / 2) });
    // Only validated numeric metadata enters the SVG, never filenames or captions from a message.
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${caption}"><rect width="100%" height="100%" fill="white"/><text x="4" y="18" font-family="sans-serif" font-size="13" fill="black">#${frame.index} | ${frame.timeMs} ms | +${frame.delayMs} ms</text></svg>`), left, top: top + tile });
  }
  const output = await sharp({ create: { width, height, channels: 3, background: "white" } })
    .composite(layers).timeout({ seconds: 5 }).png().toBuffer();
  signal?.throwIfAborted();
  const description = `同一张动图共 ${animation.frameCount} 帧，总时长 ${animation.durationMs} ms。按时间抽取 ${sampled.length} 帧，排成 ${columns} 列、${rows} 行，从左到右、从上到下阅读，末尾空白格忽略。帧编号从 0 开始：${sampled.map(frame => `#${frame.index}@${frame.timeMs}ms（持续${frame.delayMs}ms）`).join("、")}。${animation.loop === 0 ? "无限循环。" : animation.loop === null ? "循环次数未知。" : `文件记录的循环次数：${animation.loop}。`}${animation.substitutedDelays ? "缺失或无效的帧时长按100ms估算。" : ""}这些是同一动画的抽样画面，不是多张独立图片；未展示的中间动作未知。`;
  return { bytes: output, mime: "image/png", width, height, description, frameCount: animation.frameCount,
    durationMs: animation.durationMs, loop: animation.loop, substitutedDelays: animation.substitutedDelays,
    sampledFrames: sampled.map(frame => frame.index), frames: sampled };
}

module.exports = { animationInfo, animationFrame, frameAt, frameLabel, sampleAnimation, animationSheet };
