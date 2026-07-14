#!/usr/bin/env node
/**
 * stmem init — 交互式初始化新线程
 *
 * 用法:
 *   stmem init --thread <id>                    交互式
 *   stmem init --thread <id> --batch '<json>'   非交互式（脚本调用）
 *   stmem init --help                           帮助
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const STONE = path.join(os.homedir(), ".stone_memory");
const cfgFile = path.join(STONE, "stmem.json");

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(cfgFile, "utf8")); }
  catch { return {}; }
}

function saveCfg(cfg) {
  fs.mkdirSync(STONE, { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf8");
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
  const label = await askOptional(rl, "线程备注（如'主石头'、'星露谷石头'）", existing.label || threadId);
  const userGender = await askRequired(rl, "用户性别 (male/female)", existing.userGender);
  const runtime = await askRequired(rl, "运行时 (claude/codex)", existing.runtime);
  const purpose = await askRequired(rl, "用途 (accompany/coding/study)", existing.purpose);
  const sessionDir = await askRequired(rl, "线程文件目录（绝对路径）", existing.sessionDir);
  const minerMode = await askRequired(rl, "挖掘模式 (api/subagent)", existing.minerMode || "subagent");
  let apiProvider = existing.apiProvider || "";
  if (minerMode === "api") {
    apiProvider = await askRequired(rl, "API 厂商 (deepseek/openai/anthropic)", existing.apiProvider || "deepseek");
    // 填写 API key
    const existingKey = (cfg.apiKeys?.[apiProvider]?.key) || "";
    const apiKey = await askRequired(rl, `  ${apiProvider} API Key`, existingKey);
    const defaultBaseUrl = { deepseek: "https://api.deepseek.com", openai: "https://api.openai.com", anthropic: "https://api.anthropic.com" }[apiProvider] || "";
    const existingBaseUrl = cfg.apiKeys?.[apiProvider]?.baseUrl || "";
    const baseUrl = await askOptional(rl, `  ${apiProvider} Base URL (回车默认)`, existingBaseUrl || defaultBaseUrl);
    cfg.apiKeys = cfg.apiKeys || {};
    cfg.apiKeys[apiProvider] = { key: apiKey, baseUrl: baseUrl || undefined };
  }
  const windowDays = await askOptionalNumber(rl, "rebuild 窗口天数", existing.windowDays, 3);
  const keepToolPairs = await askOptionalNumber(rl, "保留工具对数", existing.keepToolPairs, 30);

  rl.close();

  const tc = { ai, user, userGender, label, runtime, purpose, sessionDir, minerMode, windowDays, keepToolPairs };
  if (apiProvider) tc.apiProvider = apiProvider;
  cfg[threadId] = tc;
  if (!cfg.runtimes) {
    cfg.runtimes = {
      claude: { command: "claude -p --bare", flags: { systemPrompt: "--system-prompt-file", mcpConfig: "--mcp-config", model: "--model" } },
    };
  }
  saveCfg(cfg);

  return cfg[threadId];
}

async function main() {
  const args = process.argv.slice(2);
  const threadIdx = args.indexOf("--thread");
  const threadId = threadIdx >= 0 ? args[threadIdx + 1] : null;

  if (!threadId) {
    console.log("用法: stmem init --thread <id>\n       stmem init --help");
    process.exit(1);
  }

  let tc;
  if (args.includes("--batch")) {
    // 非交互模式
    const jsonArg = args[args.indexOf("--batch") + 1] || "{}";
    const cfg = loadCfg();
    cfg[threadId] = JSON.parse(jsonArg);
    saveCfg(cfg);
    tc = cfg[threadId];
  } else {
    tc = await interactiveInit(threadId);
  }

  const runtime = tc.runtime || "claude";
  const purpose = tc.purpose || "accompany";
  const threadDir = path.join(STONE, "runtimes", runtime, purpose, threadId);

  // 创建目录
  fs.mkdirSync(path.join(threadDir, "memory", "archive"), { recursive: true });
  fs.mkdirSync(path.join(threadDir, "memory", "import", "done"), { recursive: true });
  fs.mkdirSync(path.join(threadDir, "memory", "mined", "feelings"), { recursive: true });
  fs.mkdirSync(path.join(threadDir, "rules"), { recursive: true });
  fs.mkdirSync(path.join(threadDir, "logs"), { recursive: true });

  // rules 模板
  const rulesDir = path.join(threadDir, "rules");
  const instructionsFile = path.join(rulesDir, "instructions.md");
  const operationsFile = path.join(rulesDir, "operations.md");
  if (!fs.existsSync(instructionsFile)) {
    fs.writeFileSync(instructionsFile, `<!-- stmem-rule: instructions.md -->
# ${tc.ai} 的系统指令

在此定义 ${tc.ai} 的基础人格、行为规则、回复风格。
每次 rebuild 时这些指令会自动注入到新线程头部。
`, "utf8");
  }
  if (!fs.existsSync(operationsFile)) {
    fs.writeFileSync(operationsFile, `<!-- stmem-rule: operations.md -->
# ${tc.ai} 的操作指令

在此定义 ${tc.ai} 可以使用的工具、API、外部系统。
每次 rebuild 时这些操作指令会自动注入到新线程头部。
`, "utf8");
  }

  // 配置文件
  fs.writeFileSync(path.join(threadDir, "memory", "retain-config.json"), JSON.stringify({ retain: {}, eventAnchors: {} }, null, 2));
  fs.writeFileSync(path.join(threadDir, "memory", "audit-marks.json"), JSON.stringify({ lastCutoffDate: new Date().getFullYear() + "-01-01", retainMarks: {} }));

  // 检查 session 文件是否存在（递归搜索，适配 rollout- 前缀和日期子目录）
  let sessionFound = false;
  function searchSessionFile(dir) {
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir, { withFileTypes: true }).some(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return searchSessionFile(full);
      return entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId) && !entry.name.includes(".rebuilt");
    });
  }
  if (runtime === "codex") {
    sessionFound = searchSessionFile(path.join(os.homedir(), ".codex", "sessions"));
  }
  if (runtime === "claude" && tc.sessionDir) {
    sessionFound = searchSessionFile(tc.sessionDir);
  }
  const sessionWarn = sessionFound ? "" : "\n   ⚠️ 未找到对应 session 文件，请先创建线程或检查 sessionDir 路径";

  console.log(`\n✅ 初始化完成`);
  console.log(`   AI: ${tc.ai}  用户: ${tc.user}`);
  console.log(`   运行时: ${runtime}  用途: ${purpose}`);
  console.log(`   路径: ${threadDir}${sessionWarn}`);

  // 自动启动 watcher
  startWatcher();
}

function startWatcher() {
  const { spawn } = require("child_process");
  const watcherScript = path.join(__dirname, "watcher.js");
  const pidFile = path.join(STONE, "watcher.pid");

  if (!fs.existsSync(watcherScript)) return;

  // systemd (仅 Linux)
  if (process.platform !== "win32") {
    const serviceDir = path.join(os.homedir(), ".config", "systemd", "user");
    const serviceFile = path.join(serviceDir, "stmem-watcher.service");
    try {
      fs.mkdirSync(serviceDir, { recursive: true });
      fs.writeFileSync(serviceFile, `[Unit]
Description=STMEM Memory Watcher
After=default.target

[Service]
Type=simple
ExecStart=${process.execPath} ${watcherScript}
ExecStopPost=/bin/rm -f ${pidFile}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`);
      const { execSync: es } = require("child_process");
      try {
        es("systemctl --user daemon-reload 2>/dev/null", { stdio: "pipe" });
        es("systemctl --user enable stmem-watcher.service 2>/dev/null", { stdio: "pipe" });
        es("systemctl --user start stmem-watcher.service 2>/dev/null", { stdio: "pipe" });
        console.log("   systemd service 已启用");
        return;
      } catch {}
    } catch {}
  } else {
    // Windows: 创建 .bat + 自动后台启动
    const batDir = path.join(os.homedir(), "AppData", "Local", "stmem");
    const batPath = path.join(batDir, "watcher-start.bat");
    const logFile = path.join(STONE, "watcher.log");
    try {
      fs.mkdirSync(batDir, { recursive: true });
      fs.writeFileSync(batPath, `@echo off\r\nstart /B node "${watcherScript}" > "${logFile}" 2>&1\r\n`);
      // 检查是否已在运行
      try {
        const oldPid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
        try { process.kill(oldPid, 0); console.log("   watcher 已在运行"); return; } catch {}
      } catch {}
      // 后台启动
      const w = spawn(process.execPath, [watcherScript], {
        detached: true, stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      w.unref();
      fs.writeFileSync(pidFile, String(w.pid));
      console.log(`   watcher 已启动 (pid ${w.pid})`);
      console.log(`   启动脚本: ${batPath}`);
      console.log("   加入开机自启: 将此快捷方式放入 shell:startup 文件夹");
      return;
    } catch (err) {
      console.log(`   watcher 启动失败: ${err.message}，请手动运行 watcher`);
      return;
    }
  }

  // fallback: 直接后台启动
  try {
    const oldPid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    try { process.kill(oldPid, 0); console.log(`   watcher 已在运行 (pid ${oldPid})`); return; } catch {}
  } catch {}
  const w = spawn(process.execPath, [watcherScript], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
  w.unref();
  fs.writeFileSync(pidFile, String(w.pid));
  console.log(`   watcher 已启动 (pid ${w.pid})`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
