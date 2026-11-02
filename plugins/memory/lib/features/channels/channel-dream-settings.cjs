"use strict";

const DEFAULT_DREAM_SETTINGS = Object.freeze({ enabled: false, schedule: "daily", dailyTime: "03:00", idleMinutes: 30 });
const isPrivateDreamScope = scope => /(?:^|:)private:/.test(String(scope?.chatId || ""));
function normalizeDreamSettings(value = {}, previous = DEFAULT_DREAM_SETTINGS) {
  const settings = { ...DEFAULT_DREAM_SETTINGS, ...previous, ...value };
  if (typeof settings.enabled !== "boolean" || !["hourly", "daily"].includes(settings.schedule)
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.dailyTime)
    || !Number.isInteger(settings.idleMinutes) || settings.idleMinutes !== 0 && (settings.idleMinutes < 5 || settings.idleMinutes > 1440)) {
    throw new Error("请选择有效的梦境时间；闲置时间须为 5 到 1440 分钟，0 表示关闭闲置整理");
  }
  return { enabled: settings.enabled, schedule: settings.schedule, dailyTime: settings.dailyTime, idleMinutes: settings.idleMinutes };
}
module.exports = { DEFAULT_DREAM_SETTINGS, normalizeDreamSettings, isPrivateDreamScope };
