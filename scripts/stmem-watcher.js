#!/usr/bin/env node
/**
 * stmem watcher — watcher 开关管理
 * 用法:
 *   stmem watcher              查看状态
 *   stmem watcher off          完全暂停（下次轮询自动退出）
 *   stmem watcher on           完全启用
 *   stmem watcher archive off  关掉 archive 同步
 *   stmem watcher archive on   打开 archive 同步
 *   stmem watcher miner off    关掉自动挖掘
 *   stmem watcher miner on     打开自动挖掘
 *
 * 默认 init 后全部开启。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const STONE = path.join(os.homedir(), ".stone_memory");
const OFF_FLAG = path.join(STONE, ".watcher-off");
const ARCHIVE_OFF_FLAG = path.join(STONE, ".archive-off");
const MINER_OFF_FLAG = path.join(STONE, ".miner-off");
const PID_FILE = path.join(STONE, "watcher.pid");
const WORKERS_FILE = path.join(STONE, "watcher-workers.json");
const WATCHER_SCRIPT = path.join(__dirname, "watcher-supervisor.js");

function getWatcherPid() {
  try { return parseInt(fs.readFileSync(PID_FILE, "utf8"), 10); } catch { return null; }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const subcmd = process.argv[3] || "status";
const target = process.argv[4]; // on/off for sub-targets

function setFlag(flagPath, state) {
  if (state === "off") {
    fs.writeFileSync(flagPath, new Date().toISOString());
    return "已关闭";
  } else {
    try { fs.unlinkSync(flagPath); } catch {}
    return "已开启";
  }
}

function flagStatus(flagPath, label) {
  const exists = fs.existsSync(flagPath);
  const since = exists ? ` (自 ${fs.readFileSync(flagPath, "utf8").slice(0, 19)})` : "";
  return `${label}: ${exists ? "关闭" + since : "开启"}`;
}

if (subcmd === "archive") {
  console.log(`archive 同步 ${setFlag(ARCHIVE_OFF_FLAG, target)}`);
  process.exit(0);
}

if (subcmd === "miner") {
  console.log(`自动挖掘 ${setFlag(MINER_OFF_FLAG, target)}`);
  process.exit(0);
}

switch (subcmd) {
  case "on":
    [OFF_FLAG, ARCHIVE_OFF_FLAG, MINER_OFF_FLAG].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    const existingPid = getWatcherPid();
    if (existingPid && isRunning(existingPid)) {
      console.log(`watcher 已在运行 (pid ${existingPid})，所有功能已开启`);
    } else if (fs.existsSync(WATCHER_SCRIPT)) {
      const w = spawn(process.execPath, [WATCHER_SCRIPT], {
        detached: true, stdio: ["ignore", "ignore", "ignore"],
      });
      w.unref();
      fs.writeFileSync(PID_FILE, String(w.pid));
      console.log(`watcher 已启动 (pid ${w.pid})，所有功能已开启`);
    }
    break;

  case "off":
    fs.writeFileSync(OFF_FLAG, new Date().toISOString());
    console.log("watcher 已标记暂停（下次轮询退出）");
    break;

  default:
    const pid = getWatcherPid();
    const alive = pid && isRunning(pid);
    const lines = [];
    lines.push(`watcher: ${alive ? `运行中 (pid ${pid})` : "未运行"}`);
    lines.push(flagStatus(OFF_FLAG, "  总开关"));
    lines.push(flagStatus(ARCHIVE_OFF_FLAG, "  archive 同步"));
    lines.push(flagStatus(MINER_OFF_FLAG, "  自动挖掘"));
    if (alive) {
      try {
        const state = JSON.parse(fs.readFileSync(WORKERS_FILE, "utf8"));
        const workers = Object.entries(state.workers || {});
        lines.push(`  线程 workers: ${workers.length}`);
        for (const [threadId, worker] of workers) lines.push(`    ${threadId}: pid ${worker.pid}`);
      } catch { lines.push("  线程 workers: 正在启动"); }
    }
    console.log(lines.join("\n"));
}
