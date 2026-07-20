function resolveAutoCompactConfig(threadConfig = {}) {
  const raw = threadConfig.autoCompact;
  if (!raw || raw.enabled !== true) return { enabled: false };

  const maxChars = positiveInteger(raw.maxChars);
  const stopChars = positiveInteger(raw.stopChars ?? raw.maxChars);
  if (maxChars == null) return { enabled: false, error: "autoCompact.maxChars 必须是正整数" };
  if (stopChars == null) return { enabled: false, error: "autoCompact.stopChars 必须是正整数" };
  if (stopChars > maxChars) return { enabled: false, error: "autoCompact.stopChars 不能高于 maxChars" };
  return { enabled: true, maxChars, stopChars };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

module.exports = { resolveAutoCompactConfig };
