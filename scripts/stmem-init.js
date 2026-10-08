#!/usr/bin/env node
/**
 * stmem init — 为已创建的记忆体接入线程
 *
 * 用法:
 *   stmem init --memory <id> --batch-file <path> 安全读取机器配置
 *   stmem init --batch-file <path> --validate   只校验，不写入
 *   stmem init --template [--runtime codex]     输出机器可填写模板
 *   stmem init --schema                         输出 JSON Schema
 *   stmem init --help                           帮助
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const STONE = path.join(os.homedir(), ".stone_memory");
const cfgFile = path.join(STONE, "stmem.json");
const {
  createThread, validateThreadInput, validateSessionBinding, normalizeName,
} = require("../src/services/thread-setup");
const { INIT_SCHEMA, buildInitTemplate } = require("../src/services/init-contract");
const { createMemory, getMemory } = require("../src/services/memory-setup");
const { listScenarios, getScenario, scenarioId } = require("../src/services/scenario-registry");

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(cfgFile, "utf8")); }
  catch { return {}; }
}

async function askRequired(rl, question, existingVal) {
  while (true) {
    const suffix = existingVal ? ` [${existingVal}]` : "";
    const answer = await new Promise(resolve => {
      rl.question(`${question}${suffix}: `, resolve);
    });
    const val = answer.trim() || existingVal || "";
    if (val) return val;
    console.log("  此项为必填，请输入。");
  }
}

async function askOptionalNumber(rl, question, existingVal, defaultVal) {
  const d = existingVal ?? defaultVal;
  const suffix = ` [${d}]`;
  const answer = await new Promise(resolve => {
    rl.question(`${question}${suffix}: `, resolve);
  });
  return parseInt(answer.trim() || String(d), 10) || d;
}

async function askOptional(rl, question, defaultVal) {
  const answer = await new Promise(resolve => {
    rl.question(`${question} [${defaultVal}]: `, resolve);
  });
  return answer.trim() || defaultVal;
}

async function interactiveInit(threadId) {
  const cfg = loadCfg();
  const existing = cfg[threadId] || {};

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n初始化线程: ${threadId}\n`);

  const ai = await askRequired(rl, "AI 名字", existing.ai);
  const user = await askRequired(rl, "用户名字", existing.user);
  let label;
  while (true) {
    label = await askRequired(rl, "记忆体名字（控制台显示名称）", existing.label);
    const duplicate = Object.entries(cfg).find(([id, item]) => id !== threadId && item && typeof item === "object" && normalizeName(item.label || id) === normalizeName(label));
    if (!duplicate) break;
    console.log(`  已经存在名为“${label}”的记忆体，请换一个名字。`);
  }
  const userGender = await askRequired(rl, "用户性别 (male/female)", existing.userGender);
  const runtime = await askRequired(rl, "运行时 (claude/codex)", existing.runtime);
  const scenario = await askRequired(rl, `场景 (${listScenarios().map(row => `${row.id}=${row.label}`).join(" / ")})`, scenarioId(existing));
  const purpose = existing.purpose || getScenario(scenario).storagePurpose;
  const defaultSessionDir = runtime === "codex" ? path.join(os.homedir(), ".codex", "sessions") : existing.sessionDir;
  const sessionDir = await askRequired(rl, "线程文件搜索目录（会递归查找）", existing.sessionDir || defaultSessionDir);
  const minerMode = await askRequired(rl, "挖掘模式 (api/subagent)", existing.minerMode || "subagent");
  let apiProvider = existing.apiProvider || "", apiKey = "", baseUrl = "", model = "";
  if (minerMode === "api") {
    apiProvider = await askRequired(rl, "API 厂商 (deepseek/openai/anthropic)", existing.apiProvider || "deepseek");
    // 填写 API key
    const existingKey = (cfg.apiKeys?.[apiProvider]?.key) || "";
    apiKey = await askRequired(rl, `  ${apiProvider} API Key`, existingKey);
    const defaultBaseUrl = { deepseek: "https://api.deepseek.com", openai: "https://api.openai.com", anthropic: "https://api.anthropic.com" }[apiProvider] || "";
    const existingBaseUrl = cfg.apiKeys?.[apiProvider]?.baseUrl || "";
    baseUrl = await askOptional(rl, `  ${apiProvider} Base URL (回车默认)`, existingBaseUrl || defaultBaseUrl);
    model = await askRequired(rl, `  ${apiProvider} 模型名（必须与上游实际名称一致）`, cfg.apiKeys?.[apiProvider]?.model || "");
  }
  const windowDays = await askOptionalNumber(rl, "rebuild 窗口天数", existing.windowDays, 1);
  const keepToolPairs = await askOptionalNumber(rl, "保留工具对数", existing.keepToolPairs, 15);

  rl.close();

  return { threadId, libraryName: label, ai, user, userGender, runtime, purpose, scenario, sessionDir, minerMode,
    apiProvider, apiKey, baseUrl, model, windowDays, keepToolPairs,
    automaticFullMining: existing.automaticFullMining !== false,
    automaticMemoryMaintenance: existing.automaticMemoryMaintenance !== false,
    automaticCompression: existing.automaticCompression === true,
    automaticDream: existing.automaticDream === true };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--new")) {
    const nameIndex = args.indexOf("--name");
    const memory = createMemory({ label: nameIndex >= 0 ? args[nameIndex + 1] : "新建记忆体" });
    console.log(JSON.stringify({ success: true, memory }, null, 2));
    return;
  }
  if (args.includes("--template")) {
    const runtimeIndex = args.indexOf("--runtime");
    const scenarioIndex = args.indexOf("--scenario");
    console.log(JSON.stringify(buildInitTemplate(runtimeIndex >= 0 ? args[runtimeIndex + 1] : "codex", scenarioIndex >= 0 ? args[scenarioIndex + 1] : "life-supervision"), null, 2));
    return;
  }
  if (args.includes("--schema")) {
    console.log(JSON.stringify(INIT_SCHEMA, null, 2));
    return;
  }
  const threadIdx = args.indexOf("--thread");
  const argumentThreadId = threadIdx >= 0 ? args[threadIdx + 1] : null;
  const memoryIdx = args.indexOf("--memory");
  const memoryId = memoryIdx >= 0 ? args[memoryIdx + 1] : null;
  if (memoryId && !getMemory(memoryId)) throw new Error(`记忆体不存在：${memoryId}`);

  let input;
  if (args.includes("--batch") || args.includes("--batch-file")) {
    const raw = args.includes("--batch-file")
      ? JSON.parse(fs.readFileSync(args[args.indexOf("--batch-file") + 1], "utf8"))
      : JSON.parse(args[args.indexOf("--batch") + 1] || "{}");
    if (argumentThreadId && raw.threadId && argumentThreadId !== raw.threadId) {
      throw new Error(`--thread (${argumentThreadId}) 与 batch 文件中的 threadId (${raw.threadId}) 不一致`);
    }
    const threadId = argumentThreadId || raw.threadId;
    if (!threadId) throw new Error("batch 文件必须填写真实 threadId");
    if (!memoryId && !loadCfg()[threadId]) throw new Error("旧布局创建入口已关闭；请先运行 stmem memory create，再用 --memory <id> 接入线程");
    input = { ...raw, memoryId, threadId, libraryName: raw.libraryName || raw.label || threadId };
    if (args.includes("--validate")) {
      validateThreadInput(input, loadCfg(), { allowExisting: true });
      const sessionFile = validateSessionBinding(input);
      console.log(JSON.stringify({
        valid: true, threadId, libraryName: input.libraryName,
        sessionDir: input.sessionDir, sessionFile,
      }, null, 2));
      return;
    }
  } else {
    if (!argumentThreadId) {
      console.log("用法:\n"
        + "  stmem init --new [--name <名称>]\n"
        + "  stmem init --memory <记忆体ID> --thread <真实线程ID> --batch-file <json>\n"
        + "  stmem init --template --runtime codex --scenario life-supervision\n"
        + "  stmem init --memory <记忆体ID> --batch-file <json> --validate");
      process.exit(1);
    }
    if (!memoryId && !loadCfg()[argumentThreadId]) throw new Error("旧布局创建入口已关闭；请先运行 stmem memory create，再用 --memory <id> 接入线程");
    input = await interactiveInit(argumentThreadId);
  }
  const tc = createThread(input, { allowExisting: true });

  console.log(`\n✅ 初始化完成`);
  console.log(`   AI: ${tc.ai}  用户: ${tc.user}`);
  console.log(`   运行时: ${tc.runtime}  场景: ${getScenario(tc.scenario).label} (${tc.scenario})`);
  console.log(`   记忆目录: ${tc.directory}`);
  console.log(`   已绑定线程文件: ${tc.sessionFile}`);

}

main().catch(e => { console.error(`[init] error: ${e.message}`); process.exit(1); });
