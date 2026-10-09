const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  RESERVED_CONFIG_KEYS, listMemoryIds: configuredMemoryIds, resolveMemoryIdentity,
} = require("./services/memory-identity");

const CONFIG_PATH = path.join(os.homedir(), ".stone_memory", "stmem.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return {}; }
}

function canonicalRuntimeConfig(context) {
  const memory = context.memoryConfig || {};
  const bindings = context.bindingConfig || {};
  const primary = (bindings.bindings || []).find(item => item.id === bindings.primaryBindingId && item.enabled !== false) || null;
  const watcher = context.watcherConfig || {};
  return {
    ...memory,
    minerMode: memory.miner?.mode,
    apiProvider: memory.miner?.apiProfile,
    windowDays: memory.rebuild?.windowDays,
    keepToolPairs: memory.rebuild?.keepToolPairs,
    contextWindowTokens: memory.rebuild?.contextWindowTokens,
    mcpRebuildDefaultsEnabled: memory.rebuild?.mcpRebuildDefaultsEnabled,
    mcpSummaryLimit: memory.rebuild?.mcpSummaryLimit,
    mcpMinImportance: memory.rebuild?.mcpMinImportance,
    relationshipTimeline: Array.isArray(memory.relationshipTimeline) ? memory.relationshipTimeline : [],
    runtime: primary?.provider,
    sessionDir: primary?.sessionRoot,
    externalThreadId: primary?.externalThreadId,
    threadFile: primary?.resolvedThreadFile,
    watcherEnabled: watcher.enabled,
    watcherModules: watcher.modules || {},
  };
}

function getMemoryRuntimeConfig(memoryId, cfg = loadConfig()) {
  const context = resolveMemoryIdentity(cfg, path.dirname(CONFIG_PATH), memoryId);
  return context.layout === "memory-v1" ? canonicalRuntimeConfig(context) : context.config;
}

/** 获取线程配置：从 threads.<id> 读取，每线程独立完整配置，不 fallback */
function getCfg(key, threadId, fallback) {
  const cfg = loadConfig();
  if (threadId) {
    let entry = cfg[threadId];
    let context = null;
    try { context = resolveMemoryIdentity(cfg, path.dirname(CONFIG_PATH), threadId); }
    catch {}
    if (context?.layout === "memory-v1") {
      const memory = context.memoryConfig || {};
      const canonical = canonicalRuntimeConfig(context);
      const canonicalValues = {
        label: memory.label, purpose: memory.purpose, ai: memory.ai, user: memory.user,
        userGender: memory.userGender, minerMode: memory.miner?.mode,
        apiProvider: memory.miner?.apiProfile, windowDays: memory.rebuild?.windowDays,
        keepToolPairs: memory.rebuild?.keepToolPairs, contextWindowTokens: memory.rebuild?.contextWindowTokens,
        mcpRebuildDefaultsEnabled: memory.rebuild?.mcpRebuildDefaultsEnabled,
        mcpSummaryLimit: memory.rebuild?.mcpSummaryLimit, mcpMinImportance: memory.rebuild?.mcpMinImportance,
        relationshipTimeline: Array.isArray(memory.relationshipTimeline) ? memory.relationshipTimeline : [],
        runtime: canonical.runtime, sessionDir: canonical.sessionDir,
        externalThreadId: canonical.externalThreadId, threadFile: canonical.threadFile,
        watcherEnabled: canonical.watcherEnabled, watcherModules: canonical.watcherModules,
      };
      if (canonicalValues[key] !== undefined && canonicalValues[key] !== null) return canonicalValues[key];
      entry = memory;
    } else if (context) entry = context.config;
    const v = entry?.[key];
    if (v !== undefined) return v;
  }
  return fallback;
}

/** 获取线程所在目录 */
function getThreadDir(threadId) {
  if (!threadId) throw new Error("threadId is required");
  const cfg = loadConfig();
  try { return resolveMemoryIdentity(cfg, path.dirname(CONFIG_PATH), threadId).root; }
  catch {
    // Legacy compatibility: diagnostics and isolated callers historically used
    // this helper to describe an unconfigured thread path. New code that needs
    // a verified memory must use getMemoryContext(), which remains strict.
    const runtime = cfg[threadId]?.runtime || "claude";
    const purpose = cfg[threadId]?.purpose || "accompany";
    return path.join(path.dirname(CONFIG_PATH), "runtimes", runtime, purpose, threadId);
  }
}

/** 列出所有已配置的线程 ID */
const GLOBAL_KEYS = RESERVED_CONFIG_KEYS;

function listThreadIds() {
  const cfg = loadConfig();
  return Object.keys(cfg).filter(k => !GLOBAL_KEYS.has(k) && typeof cfg[k] === "object");
}

function listMemoryIds() { return configuredMemoryIds(loadConfig()); }

function getMemoryContext(memoryId) {
  return resolveMemoryIdentity(loadConfig(), path.dirname(CONFIG_PATH), memoryId);
}

module.exports = { loadConfig, getCfg, getThreadDir, listThreadIds, listMemoryIds, getMemoryContext, getMemoryRuntimeConfig, CONFIG_PATH };
