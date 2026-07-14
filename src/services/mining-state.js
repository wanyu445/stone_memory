const crypto = require("crypto");

function archiveFingerprint(messages) {
  const hash = crypto.createHash("sha256");
  for (const msg of messages || []) {
    hash.update(JSON.stringify([msg.timestamp || "", msg.type || "", msg.text || ""]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function getDayState(state, date) {
  const value = state?.[`day:${date}`];
  return value && typeof value === "object" ? value : null;
}

function isCompleted(state, date) {
  const day = getDayState(state, date);
  if (day?.status === "completed" || day?.status === "completed_empty") return true;
  // 兼容旧状态；历史 skipped+mined 不再视为真正完成。
  return !!state?.[`mined:${date}`] && !state?.[`skipped:${date}`];
}

function shouldAttempt(state, date, messages, now = Date.now()) {
  if (isCompleted(state, date)) return false;
  const day = getDayState(state, date);
  if (!day) return true;
  if (day.status === "blocked" || (day.status === "failed" && day.attempt >= 3)) return false;
  if (day.status === "failed" && day.nextRetryAt) {
    return new Date(day.nextRetryAt).getTime() <= now;
  }
  return true;
}

function listBlockedDays(state) {
  return Object.entries(state || {}).flatMap(([key, value]) => {
    if (!key.startsWith("day:") || !value || value.status !== "blocked") return [];
    return [{ date: key.slice(4), ...value }];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function retryDelayMs(attempt) {
  const delays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
  return delays[Math.min(Math.max(1, attempt) - 1, delays.length - 1)];
}

module.exports = { archiveFingerprint, getDayState, isCompleted, shouldAttempt, retryDelayMs, listBlockedDays };
