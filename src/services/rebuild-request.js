function normalizeIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(item => String(item || "").trim()).filter(Boolean))];
}

function normalizeRebuildRequest(input = {}, defaults = {}) {
  const summaryInput = input.summary || {};
  const contextInput = input.context || {};
  const trimInput = input.trim || {};
  const legacyLimit = Math.max(0, Number(input.summaryLimit) || 0);
  const legacyImportance = Math.max(0, Math.min(5, Number(input.minImportance) || 0));
  const summaryMode = summaryInput.mode === "limited"
    ? "limited"
    : summaryInput.mode === "default"
      ? "default"
      : (legacyLimit || legacyImportance ? "limited" : "default");
  const contextMode = contextInput.mode === "watermark" || input.watermark === true
    ? "watermark" : "active_days";

  return {
    summary: {
      mode: summaryMode,
      limit: summaryMode === "limited"
        ? Math.max(0, Number(summaryInput.limit ?? input.summaryLimit) || 0) : 0,
      minImportance: summaryMode === "limited"
        ? Math.max(0, Math.min(5, Number(summaryInput.minImportance ?? input.minImportance) || 0)) : 0,
    },
    context: {
      mode: contextMode,
      windowDays: Math.max(1, Number(contextInput.windowDays ?? input.window ?? input.windowDays ?? defaults.windowDays) || 1),
      toolPairs: Math.max(0, Number(contextInput.toolPairs ?? input.toolPairs ?? defaults.toolPairs ?? 15) || 0),
    },
    trim: {
      excludedMessages: normalizeIds(trimInput.excludedMessages ?? input.excludedMessages),
      excludedTools: normalizeIds(trimInput.excludedTools ?? input.excludedTools),
    },
    bindingId: String(input.bindingId ?? "").trim() || null,
    trigger: ["cli", "web", "mcp"].includes(String(input.trigger || ""))
      ? String(input.trigger) : String(defaults.trigger || "cli"),
  };
}

function rebuildRequestCliArgs(request) {
  const row = normalizeRebuildRequest(request);
  const args = [
    "--window", String(row.context.windowDays),
    "--tool-pairs", String(row.context.toolPairs),
    "--summary-limit", String(row.summary.limit),
    "--min-importance", String(row.summary.minImportance),
    "--trigger", row.trigger,
  ];
  if (row.context.mode === "watermark") args.push("--watermark");
  if (row.bindingId) args.push("--binding", row.bindingId);
  return args;
}

function isProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return null;
  try {
    process.kill(value, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

// Claude Code >= 2.1.28x exports CLAUDE_CODE_SESSION_ID / CLAUDE_PID into every
// child shell, and those variables are inherited by detached scripts (nohup, &)
// that outlive the session. The hazard this guard protects against is replacing
// the thread file of the *currently running* session before its tool result
// returns. So we only block when:
//   1. the target Binding points at the exporting session (or is unknown), and
//   2. that session process is still alive (or liveness cannot be determined).
function isUnsafeActiveClaudeApply(runtime, env = process.env, options = {}) {
  if (runtime === "codex") return false;
  const sessionId = String(env.CLAUDE_CODE_SESSION_ID || "").trim();
  if (!sessionId) return false;
  // New memory-first layouts use memoryId as the database identity and keep the
  // Claude session id on the Binding. threadId remains a compatibility alias for
  // old callers where both identities were the same.
  const targetSessionId = String(options.targetSessionId || options.threadId || "").trim();
  if (targetSessionId && targetSessionId !== sessionId) return false;
  const alive = (options.isProcessAlive || isProcessAlive)(env.CLAUDE_PID);
  if (alive === false) return false;
  return true;
}

module.exports = { normalizeRebuildRequest, rebuildRequestCliArgs, isUnsafeActiveClaudeApply, isProcessAlive };
