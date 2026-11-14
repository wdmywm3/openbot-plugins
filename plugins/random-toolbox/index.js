function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

module.exports.handle = async function handle({ command, args, principal, api, config = {} }) {
  if (command.name === "coin") return { text: Math.random() < 0.5 ? "正面" : "反面" };
  if (command.name === "random") {
    const numbers = String(args || "").match(/-?\d+/g)?.map(Number) || [];
    const minimum = numbers.length > 1 ? numbers[0] : 1;
    const maximum = numbers.length > 1 ? numbers[1] : (numbers[0] || 100);
    const lower = Math.min(minimum, maximum);
    const upper = Math.max(minimum, maximum);
    const maxRange = integer(config.maxRange, 1000000, 1, 1000000000);
    if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || upper - lower > maxRange) {
      return { text: `随机数范围无效，最大跨度为 ${maxRange}` };
    }
    return { text: `${lower} 到 ${upper}：${lower + Math.floor(Math.random() * (upper - lower + 1))}` };
  }
  if (command.name === "choose") {
    const options = String(args || "").split(/\s*(?:\||还是|，|,)\s*/).map((item) => item.trim()).filter(Boolean);
    const maxOptions = integer(config.maxOptions, 30, 2, 100);
    if (options.length < 2) return { text: "用法：/choose 火锅 | 烧烤 | 拉面" };
    if (options.length > maxOptions) return { text: `最多提供 ${maxOptions} 个选项` };
    return { text: `选择：${options[Math.floor(Math.random() * options.length)]}` };
  }
  if (config.allowPickMember === false) return { text: "当前机器人已关闭群成员抽取" };
  const groupId = String(principal.groupId || "");
  if (!groupId) return { text: "该命令只能在群聊中使用" };
  if (!(await api.getCapabilities()).qqActions?.includes("get_group_member_list")) return { text: "当前实例无法读取群成员。" };
  const candidates = new Map();
  let cursor = "";
  for (let page = 0; page < 64; page++) {
    const result = await api.callQq("get_group_member_list", { group_id: groupId, limit: 5000, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data) || result.truncated) return { text: "未能读取完整群成员列表，请稍后重试。" };
    for (const member of result.data) if (member.user_id) candidates.set(member.user_id, member);
    if (candidates.size > 5000) return { text: "未能读取完整群成员列表，请稍后重试。" };
    cursor = result.next_cursor;
    if (!cursor) break;
  }
  if (cursor) return { text: "未能读取完整群成员列表，请稍后重试。" };
  if (!candidates.size) return { text: "没有读取到群成员" };
  const selected = [...candidates.values()][Math.floor(Math.random() * candidates.size)];
  const userId = selected.user_id;
  const name = selected.card || selected.nickname || userId;
  return { segments: [
    { type: "at", data: { qq: userId } },
    { type: "text", data: { text: ` 抽中了 ${name}` } },
  ] };
};
