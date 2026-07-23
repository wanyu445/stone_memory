const fs = require("fs");
const path = require("path");
const os = require("os");
const { CONFIG_PATH, loadConfig } = require("../config");
const { MemoryStore } = require("../storage/memory-store");

const STONE = path.join(os.homedir(), ".stone_memory");
const GLOBAL_KEYS = new Set(["runtimes", "threadId", "apiKeys"]);

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
  const required = ["libraryName", "threadId", "ai", "user", "runtime", "purpose", "minerMode"];
  for (const key of required) if (!String(input[key] || "").trim()) throw new Error(`缺少必填项：${key}`);
  if (!/^[A-Za-z0-9._:-]+$/.test(input.threadId)) throw new Error("绑定线程只能包含字母、数字、点、冒号、下划线和连字符");
  if (config[input.threadId] && !allowExisting) throw new Error("这个线程已经绑定到其他记忆体");
  const wanted = normalizeName(input.libraryName);
  const duplicate = Object.entries(config).find(([key, item]) =>
    key !== input.threadId && !GLOBAL_KEYS.has(key) && item && typeof item === "object" && normalizeName(item.label || key) === wanted);
  if (duplicate) throw new Error(`已经存在名为“${String(input.libraryName).trim()}”的记忆体`);
  if (!["claude", "codex"].includes(input.runtime)) throw new Error("运行时必须是 claude 或 codex");
  if (!String(input.sessionDir || "").trim()) throw new Error("需要填写线程文件搜索目录");
  if (!["api", "subagent"].includes(input.minerMode)) throw new Error("挖掘模式必须是 api 或 subagent");
}

function threadDirectory(input) {
  return path.join(STONE, "runtimes", input.runtime, input.purpose, input.threadId);
}

function createThread(input, { allowExisting = false } = {}) {
  const config = loadConfig();
  validateThreadInput(input, config, { allowExisting });
  const existing = config[input.threadId] || {};
  if (allowExisting && existing.runtime && input.runtime !== existing.runtime) throw new Error("运行时暂不支持直接迁移");
  if (allowExisting && existing.purpose && input.purpose !== existing.purpose) throw new Error("用途暂不支持直接迁移");
  const libraryName = String(input.libraryName).trim();
  const threadId = String(input.threadId).trim();
  const entry = {
    ai: String(input.ai).trim(),
    user: String(input.user).trim(),
    userGender: String(input.userGender || "unspecified").trim(),
    label: libraryName,
    runtime: input.runtime,
    purpose: input.purpose,
    sessionDir: String(input.sessionDir || "").trim(),
    minerMode: input.minerMode,
    windowDays: Math.max(1, Number(input.windowDays) || 3),
    keepToolPairs: input.keepToolPairs === undefined || input.keepToolPairs === "" ? 30 : Math.max(0, Number(input.keepToolPairs) || 0),
    contextWindowTokens: input.contextWindowTokens === undefined || input.contextWindowTokens === ""
      ? (existing.contextWindowTokens || null)
      : (Math.max(0, Number(input.contextWindowTokens) || 0) || null),
    automaticFullMining: input.automaticFullMining !== false,
    automaticMemoryMaintenance: input.automaticMemoryMaintenance !== false,
  };
  if (input.minerMode === "api") {
    const existingKey = config.apiKeys?.[input.apiProvider]?.key;
    if (!input.apiProvider || (!input.apiKey && !existingKey)) throw new Error("API 模式需要厂商和 API Key");
    entry.apiProvider = input.apiProvider;
    config.apiKeys = config.apiKeys || {};
    config.apiKeys[input.apiProvider] = { key: input.apiKey || existingKey, baseUrl: input.baseUrl || config.apiKeys[input.apiProvider]?.baseUrl || undefined };
  }
  config.runtimes = config.runtimes || {
    claude: { command: "claude -p --bare", flags: { systemPrompt: "--system-prompt-file", mcpConfig: "--mcp-config", model: "--model" } },
  };
  config[threadId] = entry;
  saveConfig(config);

  const root = threadDirectory({ ...input, threadId });
  for (const relative of ["memory/archive/full", "memory/import/done", "memory/mined/feelings", "rules", "logs"])
    fs.mkdirSync(path.join(root, relative), { recursive: true });
  const retain = path.join(root, "memory", "retain-config.json");
  if (!fs.existsSync(retain)) fs.writeFileSync(retain, JSON.stringify({ retain: {}, eventAnchors: {} }, null, 2));
  const audit = path.join(root, "memory", "audit-marks.json");
  if (!fs.existsSync(audit)) fs.writeFileSync(audit, JSON.stringify({ lastCutoffDate: `${new Date().getFullYear()}-01-01`, retainMarks: {} }, null, 2));
  const instructions = path.join(root, "rules", "instructions.md");
  if (!fs.existsSync(instructions)) fs.writeFileSync(instructions, `<!-- stmem-rule: instructions.md -->\n# ${entry.ai} 的系统指令\n\n在此定义 ${entry.ai} 的基础人格、行为规则、回复风格。\n每次 rebuild 时这些指令会自动注入到新线程头部。\n`);
  const operations = path.join(root, "rules", "operations.md");
  if (!fs.existsSync(operations)) fs.writeFileSync(operations, `<!-- stmem-rule: operations.md -->\n# ${entry.ai} 的操作指令\n\n在此定义 ${entry.ai} 可以使用的工具、API、外部系统。\n每次 rebuild 时这些操作指令会自动注入到新线程头部。\n`);

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
  return { threadId, ...entry, directory: root, sessionFound: hasSession(searchRoot), updatedExisting: !!existing.label };
}

module.exports = { createThread, validateThreadInput, normalizeName, saveConfig };
