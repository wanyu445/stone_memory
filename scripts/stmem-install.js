#!/usr/bin/env node
/**
 * stmem install — Stone Memory 安装脚本（跨平台）
 *
 * 用法:
 *   node stmem-install.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { execSync, spawn } = require("child_process");

const PROJECT = path.resolve(__dirname, "..");
const DATA = path.join(os.homedir(), ".stone_memory");
const IS_WIN = process.platform === "win32";

function log(msg) { console.log("  " + msg); }

async function ask(rl, q, def) {
  const d = def ? ` [${def}]` : "";
  const a = await new Promise(r => rl.question(`${q}${d}: `, r));
  return a.trim() || def || "";
}

function linkCLI() {
  const binFile = path.join(PROJECT, "bin", "stmem");
  if (IS_WIN) {
    // Windows: copy .cmd 到 PATH 目录
    const targetDir = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WindowsApps");
    if (fs.existsSync(targetDir)) {
      fs.copyFileSync(path.join(PROJECT, "bin", "stmem.cmd"), path.join(targetDir, "stmem.cmd"));
      log("CLI 已安装 (stmem.cmd → WindowsApps)");
    } else {
      log("请手动将 bin/ 目录添加到 PATH，或运行: node bin/stmem");
    }
  } else {
    // Linux/Mac: 软链到 ~/.local/bin
    const linkPath = path.join(os.homedir(), ".local", "bin", "stmem");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try { fs.unlinkSync(linkPath); } catch {}
    fs.symlinkSync(binFile, linkPath);
    log(`CLI 已链接 (stmem → ${linkPath})`);
  }
}

function startBackgroundWatcher() {
  const watcherScript = path.join(PROJECT, "scripts", "watcher.js");
  if (!fs.existsSync(watcherScript)) return false;

  if (IS_WIN) {
    // Windows: 创建 .bat + 自动后台启动
    const batDir = path.join(os.homedir(), "AppData", "Local", "stmem");
    const batPath = path.join(batDir, "watcher-start.bat");
    const pidFile = path.join(DATA, "watcher.pid");
    const logFile = path.join(DATA, "watcher.log");
    try {
      fs.mkdirSync(batDir, { recursive: true });
      fs.writeFileSync(batPath, `@echo off\r\nstart /B node "${watcherScript}" > "${logFile}" 2>&1\r\n`);
      // 后台启动
      const w = spawn(process.execPath, [watcherScript], {
        detached: true, stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      w.unref();
      fs.writeFileSync(pidFile, String(w.pid));
      log(`watcher 已启动 (pid ${w.pid})`);
      log(`  启动脚本: ${batPath}`);
      log("  加入开机自启: 用 shell:startup 或 schtasks");
      return true;
    } catch (err) {
      log(`watcher 启动失败: ${err.message}，可手动运行: ${batPath}`);
      return false;
    }
  } else {
    // Linux: systemd 或直接 spawn
    const pidFile = path.join(DATA, "watcher.pid");
    try {
      const serviceDir = path.join(os.homedir(), ".config", "systemd", "user");
      const serviceFile = path.join(serviceDir, "stmem-watcher.service");
      fs.mkdirSync(serviceDir, { recursive: true });
      fs.writeFileSync(serviceFile, `[Unit]
Description=STMEM Memory Watcher
After=default.target

[Service]
Type=simple
ExecStart=${process.execPath} ${watcherScript}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`);
      execSync("systemctl --user daemon-reload 2>/dev/null", { stdio: "pipe" });
      execSync("systemctl --user enable stmem-watcher.service 2>/dev/null", { stdio: "pipe" });
      execSync("systemctl --user start stmem-watcher.service 2>/dev/null", { stdio: "pipe" });
      log("watcher systemd service 已启动");
      return true;
    } catch {}
    // fallback: 直接后台
    const w = spawn(process.execPath, [watcherScript], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
    w.unref();
    fs.writeFileSync(pidFile, String(w.pid));
    log(`watcher 已后台启动 (pid ${w.pid})`);
    return true;
  }
}

async function main() {
  console.log(`\n=== Stone Memory 安装 (${IS_WIN ? "Windows" : "Linux"}) ===\n`);

  // Step 1: npm install
  log("安装依赖...");
  try {
    execSync("npm install --production", { cwd: PROJECT, stdio: "pipe" });
    log("依赖就绪");
  } catch {
    log("npm install 失败，请手动在项目目录下运行 npm install");
  }

  // Step 2: CLI 链接
  linkCLI();

  // Step 3: 数据目录
  fs.mkdirSync(DATA, { recursive: true });

  // Step 4: 配置向导
  console.log("\n--- 首次配置 ---");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const cfg = {};
  cfg.apiKeys = {};

  const hasApi = await ask(rl, "是否配置 API key（挖掘用，可跳过）(y/n)", "n");
  if (hasApi.toLowerCase() === "y") {
    const provider = await ask(rl, "厂商 (deepseek/openai/anthropic)", "deepseek");
    const key = await ask(rl, "API Key");
    if (key) {
      const baseUrl = await ask(rl, "Base URL", provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com");
      const model = await ask(rl, "Model", provider === "deepseek" ? "deepseek-v4-flash" : "gpt-4o");
      cfg.apiKeys[provider] = { key, baseUrl, model };
    }
  }

  cfg.runtimes = {
    claude: { command: "claude -p --bare", flags: { systemPrompt: "--system-prompt-file", mcpConfig: "--mcp-config", model: "--model" } },
  };

  // Step 5: 初始化第一个线程（可选）
  const doInit = await ask(rl, "是否初始化第一个线程 (y/n)", "y");
  rl.close();

  if (doInit.toLowerCase() === "y") {
    fs.writeFileSync(path.join(DATA, "stmem.json"), JSON.stringify(cfg, null, 2));
    execSync(`${process.execPath} ${path.join(PROJECT, "bin", "stmem")} init --thread welcome`, {
      cwd: PROJECT, stdio: "inherit",
    });
  } else {
    fs.writeFileSync(path.join(DATA, "stmem.json"), JSON.stringify(cfg, null, 2));
  }

  // Step 6: 启动 watcher
  console.log("\n--- watcher ---");
  startBackgroundWatcher();

  console.log("\n✅ 安装完成\n");
  console.log("快速开始:");
  console.log("  stmem init --thread <线程ID>           # 初始化新线程");
  console.log("  stmem import --dir <目录> --thread ID   # 预览旧对话导入");
  console.log("  stmem import --dir <目录> --thread ID --apply  # 确认并写入");
  console.log("  stmem mine --thread ID --all           # 挖掘记忆");
  console.log("  stmem rebuild --thread ID --apply      # 线程重建");
  console.log("");
  console.log("配置: " + DATA + "/stmem.json");
}

main().catch(e => { console.error("\n安装失败: " + e.message); process.exit(1); });
