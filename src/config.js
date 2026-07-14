const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = path.join(os.homedir(), ".stone_memory", "stmem.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return {}; }
}

/** 获取线程配置：从 threads.<id> 读取，每线程独立完整配置，不 fallback */
function getCfg(key, threadId, fallback) {
  const cfg = loadConfig();
  if (threadId && cfg[threadId]) {
    const v = cfg[threadId][key];
    if (v !== undefined) return v;
  }
  return fallback;
}

/** 获取线程所在目录 */
function getThreadDir(threadId) {
  if (!threadId) throw new Error("threadId is required");
  const runtime = getCfg("runtime", threadId, "claude");
  const purpose = getCfg("purpose", threadId, "accompany");
  return path.join(os.homedir(), ".stone_memory", "runtimes", runtime, purpose, threadId);
}

/** 列出所有已配置的线程 ID */
const GLOBAL_KEYS = new Set(["runtimes", "threadId", "apiKeys"]);

function listThreadIds() {
  const cfg = loadConfig();
  return Object.keys(cfg).filter(k => !GLOBAL_KEYS.has(k) && typeof cfg[k] === "object");
}

module.exports = { loadConfig, getCfg, getThreadDir, listThreadIds, CONFIG_PATH };
