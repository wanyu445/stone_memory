const path = require("path");
const { loadConfig } = require("../config");
const {
  executePendingRebuild,
  isTurnBlocked,
} = require("./automatic-rebuild-coordinator");
const {
  updateDetectedContextWindow,
} = require("./rebuild-log");

function configuredThread(config, threadId, runtime) {
  return Boolean(threadId && config[threadId]?.runtime === runtime);
}

function resolveClaudeThreadId(payload, config) {
  if (configuredThread(config, payload?.session_id, "claude")) return payload.session_id;
  const transcript = String(payload?.transcript_path || "");
  const basename = path.basename(transcript, path.extname(transcript));
  if (configuredThread(config, basename, "claude")) return basename;
  return null;
}

function reportClaudeContextWindow(payload, {
  config = loadConfig(),
  updateDetected = updateDetectedContextWindow,
  now = () => new Date().toISOString(),
} = {}) {
  const threadId = resolveClaudeThreadId(payload, config);
  if (!threadId) return { handled: false, reason: "thread_not_registered" };
  const maxTokens = Number(payload?.context_window?.context_window_size);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return { handled: false, reason: "context_window_unavailable", threadId };
  }
  const detected = {
    detectedMaxTokens: maxTokens,
    detectedAt: now(),
    detectedSource: "claude_status_line",
  };
  updateDetected(threadId, detected);
  return { handled: true, threadId, ...detected };
}

async function handleClaudeStop(payload, {
  config = loadConfig(),
  execute = executePendingRebuild,
} = {}) {
  if (payload?.hook_event_name && payload.hook_event_name !== "Stop") {
    return { handled: false, reason: "not_stop" };
  }
  const threadId = resolveClaudeThreadId(payload, config);
  if (!threadId) return { handled: false, reason: "thread_not_registered" };
  const result = await execute(threadId, { turnSettled: true });
  return { handled: true, threadId, result };
}

function handleClaudeTurnGate(payload, {
  config = loadConfig(),
  blocked = isTurnBlocked,
} = {}) {
  if (payload?.hook_event_name && payload.hook_event_name !== "UserPromptSubmit") {
    return { handled: false, reason: "not_user_prompt_submit", blocked: false };
  }
  const threadId = resolveClaudeThreadId(payload, config);
  if (!threadId) {
    return { handled: false, reason: "thread_not_registered", blocked: false };
  }
  return { handled: true, threadId, blocked: blocked(threadId) };
}

async function handleCodexNotification(notification, {
  config = loadConfig(),
  execute = executePendingRebuild,
} = {}) {
  const appServerCompleted = notification?.method === "turn/completed";
  const cliCompleted = notification?.type === "agent-turn-complete";
  if (!appServerCompleted && !cliCompleted) {
    return { handled: false, reason: "not_turn_completed" };
  }
  const threadId = appServerCompleted
    ? notification?.params?.threadId
    : notification?.["thread-id"];
  const status = appServerCompleted
    ? notification?.params?.turn?.status
    : "completed";
  if (!threadId || !["completed", "failed", "interrupted"].includes(status)) {
    return { handled: false, reason: "invalid_turn_completed" };
  }
  if (!config[threadId]) {
    return { handled: false, reason: "thread_not_registered", threadId };
  }
  if (!configuredThread(config, threadId, "codex")) {
    return { handled: false, reason: "runtime_mismatch", threadId };
  }
  const result = await execute(threadId, { turnSettled: true });
  return { handled: true, threadId, status, result };
}

module.exports = {
  handleClaudeStop,
  handleClaudeTurnGate,
  handleCodexNotification,
  reportClaudeContextWindow,
  resolveClaudeThreadId,
};
