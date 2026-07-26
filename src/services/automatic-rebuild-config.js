const DEFAULT_TRIGGER_RATIO = 0.86;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_INTERVAL_MS = 500;
const AUTOMATIC_REBUILD_KEYS = new Set([
  "enabled", "triggerRatio", "triggerTokens", "lifecycle",
]);
const LIFECYCLE_KEYS = new Set([
  "mode", "startCommand", "stopCommand", "healthCheckCommand", "cwd",
  "timeoutMs", "healthTimeoutMs", "healthIntervalMs",
]);

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function validRatio(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number < 1 ? number : null;
}

function optionalString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function rejectUnknownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} 不在配置 schema 中`);
  }
}

function validateAutomaticRebuildInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("automaticRebuild 必须是对象");
  }
  rejectUnknownKeys(raw, AUTOMATIC_REBUILD_KEYS, "automaticRebuild");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error("automaticRebuild.enabled 必须是 boolean");
  }
  if (raw.triggerTokens !== undefined && raw.triggerTokens !== null
    && (typeof raw.triggerTokens !== "number"
      || positiveInteger(raw.triggerTokens) == null)) {
    throw new Error("automaticRebuild.triggerTokens 必须是正整数或 null");
  }
  if (raw.triggerRatio !== undefined && raw.triggerRatio !== null
    && (typeof raw.triggerRatio !== "number"
      || validRatio(raw.triggerRatio) == null)) {
    throw new Error("automaticRebuild.triggerRatio 必须大于 0、小于 1，或为 null");
  }
  if (raw.lifecycle === undefined) return raw;
  if (!raw.lifecycle || typeof raw.lifecycle !== "object"
    || Array.isArray(raw.lifecycle)) {
    throw new Error("automaticRebuild.lifecycle 必须是对象");
  }
  const lifecycle = raw.lifecycle;
  rejectUnknownKeys(lifecycle, LIFECYCLE_KEYS, "automaticRebuild.lifecycle");
  if (lifecycle.mode !== undefined
    && !["managed", "supervisor"].includes(lifecycle.mode)) {
    throw new Error("automaticRebuild.lifecycle.mode 必须是 managed 或 supervisor");
  }
  for (const key of ["startCommand", "stopCommand", "healthCheckCommand", "cwd"]) {
    if (lifecycle[key] !== undefined && lifecycle[key] !== null
      && typeof lifecycle[key] !== "string") {
      throw new Error(`automaticRebuild.lifecycle.${key} 必须是 string 或 null`);
    }
  }
  for (const key of ["timeoutMs", "healthTimeoutMs", "healthIntervalMs"]) {
    if (lifecycle[key] !== undefined && lifecycle[key] !== null
      && (typeof lifecycle[key] !== "number"
        || positiveInteger(lifecycle[key]) == null)) {
      throw new Error(`automaticRebuild.lifecycle.${key} 必须是正整数或 null`);
    }
  }
  return raw;
}

function resolveLifecycle(rawLifecycle = {}, enabled = true) {
  const mode = rawLifecycle.mode === "managed" ? "managed" : "supervisor";
  const lifecycle = {
    mode,
    startCommand: optionalString(rawLifecycle.startCommand),
    stopCommand: optionalString(rawLifecycle.stopCommand),
    healthCheckCommand: optionalString(rawLifecycle.healthCheckCommand),
    cwd: optionalString(rawLifecycle.cwd),
    timeoutMs: positiveInteger(rawLifecycle.timeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS,
    healthTimeoutMs: positiveInteger(rawLifecycle.healthTimeoutMs) || DEFAULT_HEALTH_TIMEOUT_MS,
    healthIntervalMs: positiveInteger(rawLifecycle.healthIntervalMs) || DEFAULT_HEALTH_INTERVAL_MS,
  };
  const errors = [];
  if (!enabled) return { lifecycle, errors };
  if (!lifecycle.startCommand) errors.push("automaticRebuild.lifecycle.startCommand 未配置");
  if (mode === "managed") {
    if (!lifecycle.cwd) errors.push("automaticRebuild.lifecycle.cwd 未配置");
  } else {
    if (!lifecycle.stopCommand) errors.push("automaticRebuild.lifecycle.stopCommand 未配置");
    if (!lifecycle.healthCheckCommand) errors.push("automaticRebuild.lifecycle.healthCheckCommand 未配置");
  }
  return { lifecycle, errors };
}

function resolveAutomaticRebuildConfig(threadConfig = {}) {
  const raw = threadConfig.automaticRebuild && typeof threadConfig.automaticRebuild === "object"
    ? threadConfig.automaticRebuild
    : {};
  const enabled = raw.enabled !== false;
  const triggerTokens = raw.triggerTokens == null ? null : positiveInteger(raw.triggerTokens);
  const triggerRatio = raw.triggerRatio == null ? DEFAULT_TRIGGER_RATIO : validRatio(raw.triggerRatio);
  const errors = [];
  if (raw.triggerTokens != null && triggerTokens == null) {
    errors.push("automaticRebuild.triggerTokens 必须是正整数");
  }
  if (raw.triggerRatio != null && triggerRatio == null) {
    errors.push("automaticRebuild.triggerRatio 必须大于 0 且小于 1");
  }
  const resolvedLifecycle = resolveLifecycle(raw.lifecycle || {}, enabled);
  errors.push(...resolvedLifecycle.errors);
  return {
    enabled,
    triggerTokens,
    triggerRatio: triggerRatio || DEFAULT_TRIGGER_RATIO,
    lifecycle: resolvedLifecycle.lifecycle,
    ready: enabled && errors.length === 0,
    errors,
  };
}

function effectiveMaxTokens(threadConfig = {}, usage = {}) {
  return positiveInteger(threadConfig.contextWindowTokens)
    || positiveInteger(usage.detectedMaxTokens);
}

function resolveTriggerThreshold(threadConfig = {}, usage = {}) {
  const config = resolveAutomaticRebuildConfig(threadConfig);
  const maxTokens = effectiveMaxTokens(threadConfig, usage);
  const thresholdTokens = config.triggerTokens
    || (maxTokens ? Math.floor(maxTokens * config.triggerRatio) : null);
  return { thresholdTokens, maxTokens, config };
}

module.exports = {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_HEALTH_INTERVAL_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_TRIGGER_RATIO,
  effectiveMaxTokens,
  resolveAutomaticRebuildConfig,
  resolveTriggerThreshold,
  validateAutomaticRebuildInput,
};
