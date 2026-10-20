function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function currentDay(offsetMinutes) {
  return Math.floor((Date.now() + offsetMinutes * 60000) / 86400000);
}

module.exports.handle = async function handle({ command, message, principal, api, config = {} }) {
  const saved = await api.getState("checkins");
  const entries = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  if (command.name === "checkinrank") {
    const size = integer(config.rankSize, 10, 1, 20);
    const ranking = Object.values(entries)
      .sort((a, b) => Number(b.points || 0) - Number(a.points || 0) || Number(b.streak || 0) - Number(a.streak || 0))
      .slice(0, size);
    return { text: ranking.length
      ? `签到排行\n${ranking.map((entry, index) => `${index + 1}. ${entry.name || entry.userId}：${entry.points || 0} 分，连续 ${entry.streak || 0} 天`).join("\n")}`
      : "当前会话还没有签到记录" };
  }

  const userId = String(principal.senderId || message.sender?.id || "");
  if (!userId) return { text: "无法识别签到用户" };
  const offset = integer(config.timezoneOffsetMinutes, 480, -720, 840);
  const day = currentDay(offset);
  const previous = entries[userId] && typeof entries[userId] === "object" ? entries[userId] : {};
  if (Number(previous.day) === day) {
    return { text: `${previous.name || userId} 今天已经签到，连续 ${previous.streak || 1} 天，共 ${previous.points || 0} 分` };
  }
  const minimum = integer(config.minPoints, 5, 0, 10000);
  const maximum = Math.max(minimum, integer(config.maxPoints, 15, 0, 10000));
  const gained = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
  const entry = {
    userId,
    name: String(message.sender?.name || principal.senderName || userId).slice(0, 80),
    day,
    streak: Number(previous.day) === day - 1 ? Number(previous.streak || 0) + 1 : 1,
    points: Number(previous.points || 0) + gained,
  };
  await api.setState("checkins", { ...entries, [userId]: entry });
  return { text: `${entry.name} 签到成功，获得 ${gained} 分；连续 ${entry.streak} 天，共 ${entry.points} 分` };
};
