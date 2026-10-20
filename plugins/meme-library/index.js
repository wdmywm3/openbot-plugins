function first(source, keys) {
  for (const key of keys) {
    const value = source && source[key] !== undefined && source[key] !== null ? String(source[key]).trim() : "";
    if (value) return value;
  }
  return "";
}

function assetsFrom(result) {
  const data = result?.result?.data ?? result?.data ?? result?.result ?? result;
  const rows = Array.isArray(data) ? data : (data?.faces || data?.custom_faces || data?.items || []);
  return rows.map((item) => {
    if (typeof item === "string") return { id: "", packageId: "", key: "", url: item, label: item };
    const id = first(item, ["providerAssetId", "id", "face_id", "faceId", "emoji_id", "emojiId", "resid", "md5"]);
    const url = first(item, ["url", "file", "file_url", "fileUrl", "thumb", "preview"]);
    const summary = first(item, ["providerSummary", "caption", "desc", "description", "summary", "name"]);
    return {
      id,
      packageId: first(item, ["emoji_package_id", "emojiPackageId", "package_id", "packageId"]),
      key: first(item, ["key", "emoji_key", "emojiKey"]),
      url,
      label: `${summary} ${id} ${url}`.trim(),
      summary,
    };
  }).filter((item) => item.id || item.url);
}

module.exports.handle = async function handle({ command, args, api, config = {} }) {
  const keyword = String(args || "").trim().toLowerCase();
  const assets = assetsFrom(typeof api.searchMemes === "function" ? await api.searchMemes("", 50) : []);
  if (command.name === "memeinfo") return { text: `当前会话可用收藏表情 ${assets.length} 个` };
  if (!assets.length) return { text: "当前会话没有可用的收藏表情" };
  let matches = keyword
    ? assetsFrom(await api.searchMemes(keyword, 50))
    : assets;
  if (!matches.length && config.emptyKeywordFallsBack === true) matches = assets;
  if (!matches.length) return { text: `没有找到包含“${args}”的收藏表情` };
  const selected = matches[Math.floor(Math.random() * matches.length)];
  const blocks = [];
  if (config.replyToSource === true) blocks.push({ type: "reply", messageId: "current" });
  blocks.push(selected.id ? {
    type: "customFace",
    customFaceId: selected.id,
    emojiPackageId: selected.packageId,
    key: selected.key,
    summary: selected.summary,
    url: selected.url,
  } : { type: "image", url: selected.url });
  return { blocks };
};
