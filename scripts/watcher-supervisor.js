#!/usr/bin/env node
/**
 * SM Watcher Supervisor
 *
 * 只负责进程生命周期：每个已配置 thread 保证恰好一个 watcher worker。
 * sync/mine/compact 均由 worker 自己串行处理，不在 supervisor 内执行。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { listThreadIds } = require("../src/config");

const STONE = path.join(os.homedir(), ".stone_memory");
const LOG_DIR = path.join(STONE, "logs");
const PID_FILE = path.join(STONE, "watcher.pid");
const WORKERS_FILE = path.join(STONE, "watcher-workers.json");
const LOCK_DIR = path.join(STONE, ".watcher-supervisor.lock");
const OFF_FLAG = path.join(STONE, ".watcher-off");
const WORKER_SCRIPT = path.join(__dirname, "watcher.js");
const args = process.argv.slice(2);
const intervalIndex = args.indexOf("--interval");
const intervalSec = intervalIndex >= 0 ? Math.max(2, Number(args[intervalIndex + 1]) || 10) : 10;
const workers = new Map();
let stopping = false;

function log(message) {
  const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const line = `[${timestamp}] [supervisor] ${message}`;
  console.log(line);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, "watcher.log"), `${line}\n`, "utf8");
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
  fs.mkdirSync(STONE, { recursive: true });
  try {
    fs.mkdirSync(LOCK_DIR);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, "owner.json"), "utf8")); } catch {}
    if (owner?.pid && processAlive(owner.pid)) return false;
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    fs.mkdirSync(LOCK_DIR);
  }
  fs.writeFileSync(path.join(LOCK_DIR, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  return true;
}

function writeState() {
  const state = {
    supervisorPid: process.pid,
    updatedAt: new Date().toISOString(),
    workers: Object.fromEntries([...workers].map(([threadId, entry]) => [threadId, {
      pid: entry.child.pid,
      startedAt: entry.startedAt,
    }])),
  };
  const tmp = `${WORKERS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, WORKERS_FILE);
}

function startWorker(threadId) {
  if (workers.has(threadId) || stopping) return;
  const child = spawn(process.execPath, [WORKER_SCRIPT, "--thread", threadId, "--supervisor-pid", String(process.pid)], {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  const entry = { child, startedAt: new Date().toISOString() };
  workers.set(threadId, entry);
  log(`[${threadId}] worker 启动 pid=${child.pid}`);
  writeState();
  child.on("exit", (code, signal) => {
    if (workers.get(threadId)?.child !== child) return;
    workers.delete(threadId);
    writeState();
    if (!stopping) log(`[${threadId}] worker 退出 code=${code ?? "-"} signal=${signal || "-"}，等待 supervisor 重启`);
  });
  child.on("error", error => log(`[${threadId}] worker 启动失败: ${error.message}`));
}

function stopWorker(threadId, reason) {
  const entry = workers.get(threadId);
  if (!entry) return;
  workers.delete(threadId);
  log(`[${threadId}] worker 停止（${reason}）`);
  try { entry.child.kill("SIGTERM"); } catch {}
  writeState();
}

function reconcile() {
  const configured = new Set(listThreadIds());
  for (const threadId of workers.keys()) if (!configured.has(threadId)) stopWorker(threadId, "线程已从配置移除");
  for (const threadId of configured) if (!workers.has(threadId)) startWorker(threadId);
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，停止 ${workers.size} 个 worker`);
  for (const threadId of [...workers.keys()]) stopWorker(threadId, signal);
  try { fs.rmSync(WORKERS_FILE, { force: true }); } catch {}
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(PID_FILE, { force: true }); } catch {}
  process.exit(0);
}

async function main() {
  if (!acquireLock()) {
    log("已有 watcher supervisor 正在运行，本进程退出");
    return;
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("exit", () => {
    if (!stopping) {
      try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
    }
  });
  log(`启动 pid=${process.pid}；配置巡检 ${intervalSec}s`);
  while (!stopping) {
    if (fs.existsSync(OFF_FLAG)) return shutdown("watcher-off");
    try { reconcile(); } catch (error) { log(`配置巡检失败: ${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, intervalSec * 1000));
  }
}

main().catch(error => {
  log(`FATAL: ${error.stack || error.message}`);
  shutdown("fatal");
});
