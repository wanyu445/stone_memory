function templateFingerprint(text) {
  if (!text) return "";
  return String(text).split("\n").map(line =>
    line
      .replace(/\[\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2}(:\d{2})?\]/g, "[DATE]")
      .replace(/\d{4}-\d{2}-\d{2}/g, "DATE")
      .replace(/\d{2}:\d{2}(:\d{2})?/g, "TIME")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "UUID")
      .replace(/\b\d+(\.\d+)?\b/g, "N")
      .replace(/https?:\/\/\S+/g, "URL")
      .trim()
  ).join("\n");
}

function isSystemInjection(text) {
  const fingerprint = templateFingerprint(text);
  if (!fingerprint) return false;
  return /<!-- stmem-rule:|<memory_context>|Relevant past memories:|Continue from where you left off\.|Review the current code changes|你上线了|Trigger:|\[轮询唤醒\]|你从哪来|石头待办清单|WECHAT SESSION INSTRUCTIONS/i.test(fingerprint);
}

module.exports = { isSystemInjection, templateFingerprint };
