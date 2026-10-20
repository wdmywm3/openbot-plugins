function number(value, fallback, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback));
}
function parseResult(text) {
  const input = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(input); } catch { throw new Error("探索结果格式无效，本轮未分享"); }
}
function candidate(item, minimum) {
  if (!item || Number(item.score) < minimum || !Number.isFinite(Number(item.score))) return null;
  const match = /^https:\/\/(?:www\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]{10})(?:[/?#].*)?$/.exec(String(item.url || ""));
  if (!match || !String(item.title || "").trim() || !String(item.reason || "").trim()) return null;
  return { id: match[1], url: `https://www.bilibili.com/video/${match[1]}`, title: String(item.title).slice(0, 160), reason: String(item.reason).slice(0, 400) };
}
async function stateFor(ctx) {
  return (await ctx.api.getState("exploration", "channel")) || { version: 1, seen: [], feedback: [], day: "", sharedToday: 0, nextAt: 0 };
}
async function explore(ctx, manual) {
  const config = ctx.config || {}, chatId = String(config.targetChat || "").trim();
  if (!chatId || !String(config.interests || "").trim()) return manual ? "先配置推荐会话和感兴趣的话题。" : null;
  if (manual && ctx.message.chatId !== chatId) return "请在配置的推荐会话中运行探索命令。";
  const state = await stateFor(ctx), now = Date.now(), date = new Date(now);
  if (!manual && now < Number(state.nextAt || 0)) return null;
  const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  if (day !== state.day) { state.day = day; state.sharedToday = 0; }
  const start = number(config.quietStartHour, 23, 0, 23), end = number(config.quietEndHour, 8, 0, 23), hour = date.getHours();
  const quiet = start !== end && (start < end ? hour >= start && hour < end : hour >= start || hour < end);
  if (quiet || state.sharedToday >= number(config.dailyShareLimit, 3, 0, 20)) return manual ? "当前处于免打扰时段，或已达到今日推荐上限。" : null;
  // Save the next deadline before calling the model so restarts do not repeat an unfinished run.
  state.nextAt = now + number(config.intervalMinutes, 60, 10, 1440) * 60000;
  state.lastRunAt = now; state.lastError = "";
  await ctx.api.setState("exploration", state, "channel");
  try {
    const result = await ctx.api.runAgent({
      chatId, tools: Array.isArray(config.tools) ? config.tools : ["web_search", "web_fetch"],
      maxToolCalls: number(config.maxToolCalls, 8, 1, 20), timeoutMs: 90000,
      prompt: [
        "主动寻找适合当前角色和用户兴趣的 B 站视频。先搜索少量候选，阅读标题、简介；工具能取字幕时再阅读字幕。",
        "必须使用工具获得真实视频链接；只有标题/简介时不要声称看过视频。不要评论、点赞、私信，也不要操作 QQ。",
        "可以选择不推荐。最多推荐一个；避免已推荐或发送结果不明的视频。候选评分是对本次兴趣匹配的判断。",
        `兴趣：${String(config.interests).slice(0, 2000)}`,
        `用户反馈：${JSON.stringify((state.feedback || []).slice(-20))}`,
        `上一轮线索：${String(state.nextQuery || "").slice(0, 400)}`,
        `已发现/已推荐：${JSON.stringify((state.seen || []).slice(-100))}`,
        '仅返回 JSON：{"candidate":null 或 {"url":"https://www.bilibili.com/video/BV...","title":"标题","reason":"推荐理由及实际阅读范围","score":0到100},"nextQuery":"下轮值得继续找的线索"}',
      ].join("\n"),
    });
    if (!result.toolCalls) throw new Error("本轮没有取得工具证据，未分享");
    const parsed = parseResult(result.text);
    state.nextQuery = String(parsed.nextQuery || "").slice(0, 400);
    const chosen = candidate(parsed.candidate, number(config.minimumScore, 75, 0, 100));
    if (chosen && !(result.observedUrls || []).some(url => {
      const found = candidate({ url, score: 100, title: "evidence", reason: "evidence" }, 0);
      return found?.id === chosen.id;
    })) throw new Error("候选链接没有出现在工具结果中，本轮未分享");
    if (!chosen || (state.seen || []).some(item => item.id === chosen.id)) {
      state.lastOutcome = "没有新的合适视频"; await ctx.api.setState("exploration", state, "channel");
      return manual ? state.lastOutcome : null;
    }
    // Claim before delivery. Unknown delivery outcomes remain claimed and are not retried.
    state.seen = [...(state.seen || []), { id: chosen.id, at: now, status: "pending" }].slice(-300);
    state.sharedToday++;
    await ctx.api.setState("exploration", state, "channel");
    const mention = String(config.mentionUserId || "");
    const blocks = [];
    if (/^\d{5,20}$/.test(mention) && chatId.includes(":group:")) blocks.push({ type: "at", target: mention });
    blocks.push({ type: "text", text: `${chosen.title}\n${chosen.reason}\n${chosen.url}` });
    const sent = await ctx.api.push(chatId, blocks);
    if (!sent || sent.networkStatus === "error") throw new Error("发送结果不明，已保留记录，避免重复推送");
    if (sent?.skipped || sent === false) {
      state.seen = state.seen.filter(item => item.id !== chosen.id); state.sharedToday--;
      state.lastOutcome = "会话暂未允许推送";
    } else {
      state.seen[state.seen.length - 1].status = "sent"; state.lastShareAt = Date.now(); state.lastOutcome = `已推荐：${chosen.title}`;
    }
    await ctx.api.setState("exploration", state, "channel");
    return manual ? null : undefined;
  } catch (error) {
    state.lastError = String(error.message || error).slice(0, 600);
    for (const item of state.seen || []) if (item.status === "pending") item.status = "unknown";
    await ctx.api.setState("exploration", state, "channel");
    if (manual) return `本轮探索结束：${state.lastError}`;
    return null;
  }
}
module.exports.poll = ctx => explore(ctx, false);
module.exports.handle = async ctx => {
  const command = ctx.command?.name || "explore";
  const state = await stateFor(ctx);
  if (command === "explorestatus") return [
    state.lastOutcome || "尚未推荐", state.lastError ? `上次问题：${state.lastError}` : "",
    state.nextAt ? `下次检查：${new Date(state.nextAt).toLocaleString()}` : "等待配置",
    `今日推荐：${state.sharedToday || 0}`,
  ].filter(Boolean).join("\n");
  if (command === "explorelike" || command === "exploreavoid") {
    const text = String(ctx.args || "").trim().slice(0, 200);
    if (!text) return "请在命令后填写希望多看或少看的主题。";
    state.feedback = [...(state.feedback || []), { preference: command === "explorelike" ? "more" : "less", text }].slice(-20);
    await ctx.api.setState("exploration", state, "channel"); return "已记录，下轮探索会参考。";
  }
  return explore(ctx, true);
};
