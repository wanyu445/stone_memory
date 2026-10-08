const fs = require("fs");
const path = require("path");
const os = require("os");
const { CONFIG_PATH, loadConfig } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { findThreadSessionFile } = require("../lib/thread-session-file");
const { canonicalMemoryDir } = require("./memory-identity");
const { normalizeScenarioConfig } = require("./scenario-registry");

const STONE = path.join(os.homedir(), ".stone_memory");
const GLOBAL_KEYS = new Set(["runtimes", "threadId", "apiKeys", "web", "memories"]);

function normalizeName(value) {
  return String(value || "").trim().normalize("NFKC").toLocaleLowerCase();
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const temp = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(temp, CONFIG_PATH);
}

function validateThreadInput(input, config = loadConfig(), { allowExisting = false } = {}) {
  if (!input.scenario && !input.purpose) throw new Error("缺少必填项：scenario 或 purpose");
  input = normalizeScenarioConfig(input, allowExisting ? config[input.threadId] : undefined);
  const required = ["libraryName", "threadId", "ai", "user", "runtime", "purpose", "minerMode"];
  for (const key of required) if (!String(input[key] || "").trim()) throw new Error(`缺少必填项：${key}`);
  if (!/^[A-Za-z0-9._:-]+$/.test(input.threadId)) throw new Error("真实线程 ID 只能包含字母、数字、点、冒号、下划线和连字符");
  if (config[input.threadId] && !allowExisting) throw new Error("这个线程已经绑定到其他记忆体");
  const wanted = normalizeName(input.libraryName);
  const duplicate = Object.entries(config).find(([key, item]) =>
    key !== input.threadId && !GLOBAL_KEYS.has(key) && item && typeof item === "object" && normalizeName(item.label || key) === wanted);
  if (duplicate) throw new Error(`已经存在名为“${String(input.libraryName).trim()}”的记忆体`);
  if (!["claude", "codex"].includes(input.runtime)) throw new Error("运行时必须是 claude 或 codex");
  if (!String(input.sessionDir || "").trim()) throw new Error("需要填写线程文件搜索目录");
  if (!["api", "subagent"].includes(input.minerMode)) throw new Error("挖掘模式必须是 api 或 subagent");
  if (input.minerMode === "api") {
    const existingKey = config.apiKeys?.[input.apiProvider]?.key;
    const existingModel = config.apiKeys?.[input.apiProvider]?.model;
    const existingBaseUrl = config.apiKeys?.[input.apiProvider]?.baseUrl;
    if (!String(input.apiProvider || "").trim() || (!String(input.apiKey || "").trim() && !existingKey)) throw new Error("API 模式需要厂商和 API Key");
    if (!String(input.model || existingModel || "").trim()) throw new Error("API 模式需要填写上游实际可用的模型名；Stone Memory 不预设模型名");
    if (input.apiProvider !== "deepseek" && !String(input.baseUrl || existingBaseUrl || "").trim()) throw new Error("非 DeepSeek API 模式需要填写兼容 chat/completions 的 Base URL");
  }
}

function threadDirectory(input) {
  if (input.memoryId) return canonicalMemoryDir(STONE, input.memoryId);
  return path.join(STONE, "runtimes", input.runtime, input.purpose, input.threadId);
}

function validateSessionBinding(input) {
  const file = findThreadSessionFile(String(input.sessionDir || "").trim(), String(input.threadId || "").trim());
  if (!file) {
    throw new Error(
      `无法绑定线程：在 ${String(input.sessionDir || "").trim() || "指定目录"} 中找不到文件名包含真实线程 ID `
      + `${String(input.threadId || "").trim() || "(空)"} 的 JSONL。记忆体名字应填入 libraryName，threadId 必须填写 Claude/Codex 的真实线程 ID。`,
    );
  }
  return file;
}

function createThread(input, { allowExisting = false, requireSession = true } = {}) {
  const config = loadConfig();
  if (!String(input?.memoryId || "").trim() && !config[input?.threadId]) {
    throw new Error("旧布局创建入口已关闭；请先创建新版记忆体并显式传入 memoryId");
  }
  validateThreadInput(input, config, { allowExisting });
  input = normalizeScenarioConfig(input, allowExisting ? config[input.threadId] : undefined);
  const sessionFile = requireSession ? validateSessionBinding(input) : null;
  const existing = config[input.threadId] || {};
  if (allowExisting && existing.runtime && input.runtime !== existing.runtime) throw new Error("运行时暂不支持直接迁移");
  if (allowExisting && existing.purpose && input.purpose !== existing.purpose) throw new Error("用途暂不支持直接迁移");
  const libraryName = String(input.libraryName).trim();
  const threadId = String(input.threadId).trim();
  const oldModules = existing.watcherModules || {};
  const inputModules = input.watcherModules || {};
  const moduleValue = (name, inputKey, legacyDefault) => {
    if (Object.hasOwn(inputModules, name)) return inputModules[name] === true;
    if (Object.hasOwn(input, inputKey)) return input[inputKey] === true;
    if (Object.hasOwn(oldModules, name)) return oldModules[name] === true;
    if (Object.hasOwn(existing, inputKey)) return existing[inputKey] === true;
    return legacyDefault;
  };
  const watcherModules = { ...oldModules, ...inputModules,
    archive: moduleValue("archive", "automaticFullMining", true),
    miner: moduleValue("miner", "automaticMemoryMaintenance", true),
    compression: moduleValue("compression", "automaticCompression", false),
    dream: moduleValue("dream", "automaticDream", false),
  };
  const automaticFullMining = watcherModules.archive;
  const automaticMemoryMaintenance = watcherModules.miner;
  const automaticCompression = watcherModules.compression;
  const automaticDream = watcherModules.dream;
  const watcherEnabled = typeof input.watcherEnabled === "boolean"
    ? input.watcherEnabled
    : typeof existing.watcherEnabled === "boolean"
      ? existing.watcherEnabled
      : Object.values(watcherModules).some(Boolean);
  const entry = {
    memoryId: String(input.memoryId || existing.memoryId || threadId).trim(),
    ai: String(input.ai).trim(),
    user: String(input.user).trim(),
    userGender: String(input.userGender || "unspecified").trim(),
    relationshipTimeline: Array.isArray(input.relationshipTimeline)
      ? input.relationshipTimeline.map(row => String(row || "").trim()).filter(Boolean)
      : (Array.isArray(existing.relationshipTimeline) ? existing.relationshipTimeline : []),
    label: libraryName,
    runtime: input.runtime,
    purpose: input.purpose,
    scenario: input.scenario,
    sessionDir: String(input.sessionDir || "").trim(),
    minerMode: input.minerMode,
    windowDays: Math.max(1, Number(input.windowDays) || 1),
    keepToolPairs: input.keepToolPairs === undefined || input.keepToolPairs === "" ? 15 : Math.max(0, Number(input.keepToolPairs) || 0),
    mcpRebuildDefaultsEnabled: input.mcpRebuildDefaultsEnabled === true,
    mcpSummaryLimit: Math.max(0, Math.floor(Number(input.mcpSummaryLimit) || 0)),
    mcpMinImportance: Math.max(0, Math.min(5, Math.floor(Number(input.mcpMinImportance) || 0))),
    contextWindowTokens: input.contextWindowTokens === undefined || input.contextWindowTokens === ""
      ? (existing.contextWindowTokens || null)
      : (Math.max(0, Number(input.contextWindowTokens) || 0) || null),
    automaticFullMining,
    automaticMemoryMaintenance,
    automaticCompression,
    automaticDream,
    watcherEnabled,
    watcherModules,
    ...(Array.isArray(existing.mcpModules) ? { mcpModules: existing.mcpModules } : {}),
    ...(Number.isInteger(existing.mcpModuleConfigVersion) ? { mcpModuleConfigVersion: existing.mcpModuleConfigVersion } : {}),
  };
  if (input.minerMode === "api") {
    const existingKey = config.apiKeys?.[input.apiProvider]?.key;
    const existingModel = config.apiKeys?.[input.apiProvider]?.model;
    if (!input.apiProvider || (!input.apiKey && !existingKey)) throw new Error("API 模式需要厂商和 API Key");
    if (!String(input.model || existingModel || "").trim()) throw new Error("API 模式需要填写上游实际可用的模型名；Stone Memory 不预设模型名");
    entry.apiProvider = input.apiProvider;
    config.apiKeys = config.apiKeys || {};
    config.apiKeys[input.apiProvider] = {
      key: input.apiKey || existingKey,
      baseUrl: input.baseUrl || config.apiKeys[input.apiProvider]?.baseUrl || undefined,
      model: String(input.model || existingModel).trim(),
    };
  }
  config.runtimes = config.runtimes || {
    claude: { type: "claude", command: "claude -p", flags: { systemPrompt: "--system-prompt-file", mcpConfig: "--mcp-config", model: "--model" } },
  };
  config[threadId] = entry;
  if (input.memoryId) {
    config.memories = config.memories || {};
    const memory = config.memories[input.memoryId];
    if (!memory) throw new Error(`记忆体不存在：${input.memoryId}`);
    const bindings = Array.isArray(memory.bindings) ? memory.bindings.filter(item => item.threadId !== threadId) : [];
    bindings.push({ threadId, runtime: entry.runtime, purpose: entry.purpose, sessionDir: entry.sessionDir, boundAt: new Date().toISOString() });
    config.memories[input.memoryId] = { ...memory, label: libraryName, status: "active", updatedAt: new Date().toISOString(), bindings };
  }
  if (input.memoryId) {
    require("./memory-setup").updateMemorySettings(input.memoryId, { scenario: entry.scenario }, { apply: true });
  }
  saveConfig(config);

  const root = threadDirectory({ ...input, threadId });
  for (const relative of ["memory/archive/full", "memory/import/done", "memory/mined/feelings", "rules", "logs"])
    fs.mkdirSync(path.join(root, relative), { recursive: true });
  const retain = path.join(root, "memory", "retain-config.json");
  if (!fs.existsSync(retain)) fs.writeFileSync(retain, JSON.stringify({ retain: {}, eventAnchors: {} }, null, 2));
  const audit = path.join(root, "memory", "audit-marks.json");
  if (!fs.existsSync(audit)) fs.writeFileSync(audit, JSON.stringify({ lastCutoffDate: `${new Date().getFullYear()}-01-01`, retainMarks: {} }, null, 2));
  const instructions = path.join(root, "rules", "instructions.md");
  if (!fs.existsSync(instructions)) fs.writeFileSync(instructions, `# ${entry.ai} 的系统指令\n\n在此定义 ${entry.ai} 的基础人格、行为规则、回复风格。\n每次 rebuild 时这些指令会自动注入到新线程头部。\n`);
  const operations = path.join(root, "rules", "operations.md");
  if (!fs.existsSync(operations)) fs.writeFileSync(operations, `# ${entry.ai} 的操作指令\n\n在此定义 ${entry.ai} 可以使用的工具、API、外部系统。\n每次 rebuild 时这些操作指令会自动注入到新线程头部。\n`);

  const store = new MemoryStore({ memoryDir: path.join(root, "memory"), threadId });
  store.registerThread({ runtime: entry.runtime, purpose: entry.purpose, label: entry.label });
  store.close();
  const searchRoot = entry.sessionDir;
  function hasSession(dir) {
    if (!dir || !fs.existsSync(dir)) return false;
    return fs.readdirSync(dir, { withFileTypes: true }).some(item => item.isDirectory()
      ? hasSession(path.join(dir, item.name))
      : item.name.endsWith(".jsonl") && item.name.includes(threadId) && !item.name.includes(".rebuilt"));
  }
  return {
    threadId, ...entry, directory: root,
    sessionFound: sessionFile ? true : hasSession(searchRoot),
    sessionFile: sessionFile || null,
    updatedExisting: !!existing.label,
  };
}

module.exports = { createThread, validateThreadInput, validateSessionBinding, normalizeName, saveConfig };
