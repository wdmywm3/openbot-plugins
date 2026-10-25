// WBI signs public query parameters; this helper never receives account secrets.
function biliMd5Ascii(input) {
  const bytes = Array.from(input, c => c.charCodeAt(0));
  if (bytes.some(value => value > 127)) throw new Error("WBI query must be URI encoded");
  const length = bytes.length * 8;
  bytes.push(128); while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push(i < 4 ? length >>> (i * 8) & 255 : 0);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const shifts = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = Array.from({ length: 16 }, (_, i) => bytes[offset + 4 * i] | bytes[offset + 4 * i + 1] << 8 | bytes[offset + 4 * i + 2] << 16 | bytes[offset + 4 * i + 3] << 24);
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      const round = Math.floor(i / 16), f = round === 0 ? b & c | ~b & d : round === 1 ? d & b | ~d & c : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : 7 * i % 16;
      const value = a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) + words[g] | 0, shift = shifts[round][i % 4];
      [a, b, c, d] = [d, b + (value << shift | value >>> (32 - shift)) | 0, b, c];
    }
    [a, b, c, d].forEach((value, i) => { state[i] = state[i] + value | 0; });
  }
  return state.map(word => [0, 8, 16, 24].map(shift => (word >>> shift & 255).toString(16).padStart(2, "0")).join("")).join("");
}
function biliWbiSign(params, images, timestamp = Math.floor(Date.now() / 1000)) {
  const stem = url => /\/([a-f0-9]{32})\.[a-z]+(?:\?|$)/i.exec(String(url || ""))?.[1] || "";
  const raw = stem(images?.img_url) + stem(images?.sub_url);
  if (raw.length !== 64) return null;
  const order = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
  const mixin = order.map(i => raw[i]).join("").slice(0, 32);
  const sorted = Object.fromEntries(Object.entries({ ...params, wts: timestamp }).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, String(value).replace(/[!'()*]/g, "")]));
  const query = Object.entries(sorted).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  return { ...sorted, w_rid: biliMd5Ascii(query + mixin) };
}
async function biliFallbackText(ctx, job, configuredAccount) {
  if (!configuredAccount && !ctx.config?.browseUid) return [];
  const account = configuredAccount || await biliAccount(ctx, "browse");
  const nav = await biliRequest(ctx, account, "/x/web-interface/nav");
  if (!nav.wbi_img) return [];
  const upMid = job.upMid || (await biliRequest(ctx, account, "/x/web-interface/view", { bvid: job.bvid })).owner?.mid;
  if (!biliNumericId(upMid)) return [];
  const signed = biliWbiSign({ bvid: job.bvid, cid: job.cid, up_mid: upMid }, nav.wbi_img);
  if (!signed) return [];
  let data;
  try { data = await biliRequest(ctx, account, "/x/web-interface/view/conclusion/get", signed); }
  catch (error) { if ([-101, -400, -404, -500, -502, -503].includes(error.code)) return []; throw error; }
  // Only transcript entries count. Summary and outline cannot replace speech.
  const sections = data.model_result?.subtitle;
  if (!Array.isArray(sections)) return [];
  const raw = sections.flatMap(section => Array.isArray(section.part_subtitle) ? section.part_subtitle : [section]);
  if (raw.length > 30000) throw new Error("平台补充文字过长");
  return raw.map(item => {
    const start = Number(item.start ?? item.from ?? item.start_timestamp ?? item.timestamp);
    const end = Number(item.end ?? item.to ?? item.end_timestamp ?? start);
    return { start, end, text: String(item.text ?? item.content ?? "").trim() };
  }).filter(item => item.text).map(item => {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start || item.end > job.duration + 5 || item.text.length > 8000)
      throw new Error("平台补充文字时间戳或内容无效");
    return item;
  }).sort((a, b) => a.start - b.start);
}
