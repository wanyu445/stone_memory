const fs = require("fs");

function usageFromRow(row, runtime) {
  if (runtime === "codex") {
    const info = row?.type === "event_msg" && row.payload?.type === "token_count" ? row.payload.info : null;
    const usedTokens = Number(info?.last_token_usage?.input_tokens);
    if (!Number.isFinite(usedTokens)) return null;
    const maxTokens = Number(info?.model_context_window);
    return { usedTokens, detectedMaxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null,
      observedAt: row.timestamp || null, source: "codex_token_count" };
  }
  const usage = row?.message?.usage;
  if (!usage) return null;
  const values = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
    .map(Number).filter(Number.isFinite);
  if (!values.length) return null;
  return { usedTokens: values.reduce((sum, value) => sum + value, 0), detectedMaxTokens: null,
    observedAt: row.timestamp || null, model: row.message?.model || null, source: "claude_message_usage" };
}

function latestContextUsage(file, runtime) {
  if (!file || !fs.existsSync(file)) return null;
  const fd = fs.openSync(file, "r");
  try {
    let position = fs.fstatSync(fd).size;
    let suffix = Buffer.alloc(0);
    const chunkSize = 64 * 1024;
    while (position > 0) {
      const size = Math.min(chunkSize, position);
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      fs.readSync(fd, chunk, 0, size, position);
      const combined = Buffer.concat([chunk, suffix]);
      let end = combined.length;
      let firstNewline = -1;
      for (let i = combined.length - 1; i >= 0; i -= 1) {
        if (combined[i] !== 10) continue;
        firstNewline = i;
        const line = combined.subarray(i + 1, end).toString("utf8").trim();
        end = i;
        if (!line) continue;
        try { const usage = usageFromRow(JSON.parse(line), runtime); if (usage) return usage; }
        catch {}
      }
      suffix = firstNewline >= 0 ? combined.subarray(0, firstNewline) : combined;
    }
    const firstLine = suffix.toString("utf8").trim();
    if (firstLine) try { return usageFromRow(JSON.parse(firstLine), runtime); } catch {}
    return null;
  } finally { fs.closeSync(fd); }
}

module.exports = { usageFromRow, latestContextUsage };
