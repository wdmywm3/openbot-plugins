function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function currentDay(offsetMinutes) {
  return Math.floor((Date.now() + offsetMinutes * 60000) / 86400000);
}

const sortedEntries = values => values.sort((a, b) => Number(b.points || 0) - Number(a.points || 0)
  || Number(b.streak || 0) - Number(a.streak || 0)).slice(0, 20);

async function databaseCheckin({ command, message, principal, api, config = {} }) {
  const database = input => api.database({ name: "checkins", scope: "chat", ...input });
  let oldRanking;
  const rankingSnapshot = async () => {
    const { record } = await database({ action: "get", collection: "ranking", key: "top" });
    if (record) return record;
    if (!oldRanking) oldRanking = (async () => {
      const saved = await api.getState("checkin:ranking");
      if (Array.isArray(saved)) return sortedEntries(saved);
      const legacy = await api.getState("checkins");
      return sortedEntries(Object.entries(legacy && typeof legacy === "object" ? legacy : {})
        .map(([userId, entry]) => ({ ...entry, userId: entry.userId || userId })));
    })();
    return { revision: 0, value: await oldRanking };
  };
  if (command.name === "checkinrank") {
    for (let attempt = 0; attempt < 64; attempt++) {
      const snapshot = await rankingSnapshot();
      if (!snapshot.revision) {
        try { await database({ action: "put", collection: "ranking", key: "top", value: snapshot.value, expectedRevision: 0 }); }
        catch (error) { if (String(error?.message).includes("记录已改变")) continue; throw error; }
      }
      const size = integer(config.rankSize, 10, 1, 20), ranking = snapshot.value;
      return { text: ranking.length
        ? `签到排行\n${ranking.slice(0, size).map((entry, index) => `${index + 1}. ${entry.name || entry.userId}：${entry.points || 0} 分，连续 ${entry.streak || 0} 天`).join("\n")}`
        : "当前会话还没有签到记录" };
    }
    throw new Error("签到排行更新繁忙，请稍后重试");
  }
  const userId = String(principal.senderId || message.sender?.id || "");
  if (!userId) return { text: "无法识别签到用户" };
  const day = currentDay(integer(config.timezoneOffsetMinutes, 480, -720, 840));
  const minimum = integer(config.minPoints, 5, 0, 10000);
  const maximum = Math.max(minimum, integer(config.maxPoints, 15, 0, 10000));
  const gained = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
  let legacyUser;
  for (let attempt = 0; attempt < 64; attempt++) {
    const { record } = await database({ action: "get", collection: "users", key: userId });
    if (!record && !legacyUser) legacyUser = (async () => await api.getState(`checkin:user:${userId}`)
      || (await api.getState("checkins"))?.[userId] || {})();
    const previous = record ? record.value : await legacyUser;
    const already = Number(previous.day) === day;
    const entry = already ? { ...previous, userId, name: String(previous.name || message.sender?.name || userId).slice(0, 80) } : {
      userId, name: String(message.sender?.name || principal.senderName || userId).slice(0, 80), day,
      streak: Number(previous.day) === day - 1 ? Number(previous.streak || 0) + 1 : 1,
      points: Number(previous.points || 0) + gained,
    };
    const ranking = await rankingSnapshot();
    try {
      // The points and ranking commit together. An interruption cannot leave a
      // successful check-in absent from the ranking or grant the points twice.
      await database({ action: "batch", operations: [
        { action: "put", collection: "users", key: userId, value: entry, expectedRevision: record?.revision || 0 },
        { action: "put", collection: "ranking", key: "top", expectedRevision: ranking.revision,
          value: sortedEntries([...ranking.value.filter(item => item.userId !== userId), entry]) },
      ] });
      return { text: already
        ? `${entry.name || userId} 今天已经签到，连续 ${entry.streak || 1} 天，共 ${entry.points || 0} 分`
        : `${entry.name} 签到成功，获得 ${gained} 分；连续 ${entry.streak} 天，共 ${entry.points} 分` };
    } catch (error) {
      // Retry only a rejected revision, never an uncertain storage failure.
      if (!String(error?.message).includes("记录已改变")) throw error;
    }
  }
  throw new Error("签到更新繁忙，请稍后重试");
}

module.exports.handle = async function handle(ctx) {
  const { command, message, principal, api, config = {} } = ctx;
  if (typeof api.database === "function") return databaseCheckin(ctx);
  if (typeof api.updateState !== "function") return { text: "请更新 OpenBot 后使用签到，以保证多人同时签到时积分正确。" };
  const sorted = values => values.sort((a, b) => Number(b.points || 0) - Number(a.points || 0) || Number(b.streak || 0) - Number(a.streak || 0)).slice(0, 20);
  const rankKey = "checkin:ranking";
  let ranking = await api.getState(rankKey);
  if (!Array.isArray(ranking)) {
    const legacy = await api.getState("checkins");
    const initial = sorted(Object.values(legacy && typeof legacy === "object" ? legacy : {}));
    ranking = await api.updateState(rankKey, value => Array.isArray(value) ? value : initial);
  }
  if (command.name === "checkinrank") {
    const size = integer(config.rankSize, 10, 1, 20);
    return { text: ranking.length
      ? `签到排行\n${ranking.slice(0, size).map((entry, index) => `${index + 1}. ${entry.name || entry.userId}：${entry.points || 0} 分，连续 ${entry.streak || 0} 天`).join("\n")}`
      : "当前会话还没有签到记录" };
  }

  const userId = String(principal.senderId || message.sender?.id || "");
  if (!userId) return { text: "无法识别签到用户" };
  const offset = integer(config.timezoneOffsetMinutes, 480, -720, 840);
  const day = currentDay(offset);
  const key = `checkin:user:${userId}`;
  let initial = await api.getState(key);
  // Read the old shared record only when this user has not migrated yet.
  if (!initial) initial = (await api.getState("checkins"))?.[userId] || {};
  const minimum = integer(config.minPoints, 5, 0, 10000);
  const maximum = Math.max(minimum, integer(config.maxPoints, 15, 0, 10000));
  const gained = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
  let already = false;
  const entry = await api.updateState(key, saved => {
    const previous = saved || initial;
    already = Number(previous.day) === day;
    if (already) return previous;
    return { userId, name: String(message.sender?.name || principal.senderName || userId).slice(0, 80), day,
      streak: Number(previous.day) === day - 1 ? Number(previous.streak || 0) + 1 : 1,
      points: Number(previous.points || 0) + gained };
  });
  await api.updateState(rankKey, value => sorted([...(Array.isArray(value) ? value : []).filter(item => item.userId !== userId), entry]));
  if (already) return { text: `${entry.name || userId} 今天已经签到，连续 ${entry.streak || 1} 天，共 ${entry.points || 0} 分` };
  return { text: `${entry.name} 签到成功，获得 ${gained} 分；连续 ${entry.streak} 天，共 ${entry.points} 分` };
};
