#!/usr/bin/env node
/**
 * SM Watcher — 实时监听线程文件，增量归档并自动挖掘
 *
 * 策略:
 *   - 线程文件变化后立即触发增量同步（防抖 + 单线程串行）
 *   - 低频巡检作为 fs.watch 丢事件时的兜底
 *   - 发现昨天或更早的日期文件 && 未挖掘 → 跑 Miner (feelings + features)
 *   - 全写 log，不重复挖
 *
 * 用法:
 *   node scripts/watcher.js --thread <id> [--interval 300] [--once]
 *   常驻多线程监听由 watcher-supervisor.js 为每个线程启动本 worker。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile, execSync } = require("child_process");

const { loadConfig, getCfg, getThreadDir, listThreadIds } = require("../src/config");
const { listJsonlRecursive } = require("../src/lib/archive-paths");
const { shouldAttempt } = require("../src/services/mining-state");
const { ingestThreadFile: ingestSharedThreadFile } = require("../src/services/thread-ingest");
const { MemoryStore } = require("../src/storage/memory-store");
const LOG_DIR = path.join(os.homedir(), ".stone_memory", "logs");
let workerLockDir = null;

function log(msg) {
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, "watcher.log"), line + "\n", "utf8");
}

function beijingToday() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireWorkerLock(threadId) {
  const suffix = crypto.createHash("sha256").update(threadId).digest("hex").slice(0, 20);
  const lockDir = path.join(os.homedir(), ".stone_memory", `.watcher-worker-${suffix}.lock`);
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")); } catch {}
    if (owner?.pid && processAlive(owner.pid)) return null;
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
  }
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, threadId, createdAt: new Date().toISOString() }));
  return lockDir;
}

function releaseWorkerLock() {
  if (!workerLockDir) return;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(workerLockDir, "owner.json"), "utf8"));
    if (owner.pid === process.pid) fs.rmSync(workerLockDir, { recursive: true, force: true });
  } catch {}
  workerLockDir = null;
}

// ── 路径 helpers（全部接收 threadId） ──

function getArchiveDir(tid) {
  return path.join(getThreadDir(tid), "memory", "archive");
}

function loadMiningState(tid) {
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(tid), "memory"), threadId: tid });
  try {
    return Object.fromEntries(store.listDayStates().map(row => [`day:${row.source_date}`, {
      status: row.status, attempt: row.attempt, nextRetryAt: row.next_retry_at,
    }]));
  } finally { store.close(); }
}

function readArchiveDay(tid, date) {
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(tid), "memory"), threadId: tid });
  try { return store.listMessages({ date }); }
  finally { store.close(); }
}

function scanArchiveDates(tid) {
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(tid), "memory"), threadId: tid });
  try { return store.listMessageDates(); }
  finally { store.close(); }
}

async function runMining(tid, dateStr) {
  const scriptPath = path.join(__dirname, "stmem-mine.js");
  const cmd = `${process.execPath} ${scriptPath} --thread ${tid} --date ${dateStr}`;
  log(`[${tid}] 开始挖掘 ${dateStr} ...`);

  try {
    const output = execSync(cmd, { encoding: "utf8", timeout: 600_000, cwd: path.dirname(__dirname), windowsHide: true });
    const lastLines = output.trim().split("\n").slice(-5).join(" | ");
    log(`[${tid}] 完成 ${dateStr}: ${lastLines}`);

    const store = new MemoryStore({ memoryDir: path.join(getThreadDir(tid), "memory"), threadId: tid });
    const feelingCount = store.listFeelings({ date: dateStr }).length;
    const featureCount = store.listFeatures({ date: dateStr }).length;
    store.close();
    log(`[${tid}] ${dateStr} 产出: ${feelingCount} feelings, ${featureCount} features`);
    return true;
  } catch (err) {
    log(`[${tid}] 挖掘 ${dateStr} 失败: ${err.message}`);
    return false;
  }
}

function detectThreadFormat(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const firstLine = raw.split("\n").filter(Boolean)[0] || "";
    const obj = JSON.parse(firstLine);
    if (obj.type === "message" || obj.response_item) return "codex";
    return "claude";
  } catch { return "claude"; }
}

function importThreadFile(tid, filePath, fileName) {
  const memoryDir = path.join(getThreadDir(tid), "memory");
  const store = new MemoryStore({ memoryDir, threadId: tid });
  let result;
  try { result = ingestSharedThreadFile(filePath, { memoryStore: store, fullDir: path.join(memoryDir, "archive", "full") }); }
  finally { store.close(); }

  const doneDir = path.join(getThreadDir(tid), "memory", "import", "done");
  fs.mkdirSync(doneDir, { recursive: true });
  const donePath = path.join(doneDir, fileName.replace(".jsonl", `_${Date.now()}.jsonl`));
  fs.renameSync(filePath, donePath);

  log(`[${tid}] import: ${fileName} (${result.format}) → ${result.imported} messages, ${result.dates} dates, full: +${result.fullBacked}`);
  return result.imported;
}

async function checkImports(tid) {
  const importDir = path.join(getThreadDir(tid), "memory", "import");
  const doneDir = path.join(importDir, "done");
  const files = listJsonlRecursive(importDir).filter(f => !f.startsWith(doneDir + path.sep));

  for (const fpath of files) {
    const f = path.basename(fpath);
    if (!fs.statSync(fpath).isFile()) continue;
    try { importThreadFile(tid, fpath, f); } catch (err) {
      log(`[${tid}] import ${f} 失败: ${err.message}`);
    }
  }
}

function syncFromThread(tid) {
  const syncScript = path.join(__dirname, "stmem-sync.js");
  if (!fs.existsSync(syncScript)) return Promise.resolve();
  return new Promise(resolve => {
    execFile(process.execPath, [syncScript, "--thread", tid], {
      encoding: "utf8", timeout: 120_000, cwd: path.dirname(__dirname), windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        log(`[${tid}] sync 失败: ${(stderr || err.message).trim().slice(0, 300)}`);
        resolve();
        return;
      }
      const trimmed = (stdout || "").trim();
      if (trimmed && trimmed !== "已是最新" && !trimmed.includes("(no new messages)")) {
        log(`[${tid}] sync: ${trimmed.split("\n").pop()}`);
      }
      resolve();
    });
  });
}

// 同一线程同一时间只跑一个 sync；运行期间再次变化则结束后立刻补跑一次。
const syncStates = new Map();

function getSyncState(tid) {
  if (!syncStates.has(tid)) syncStates.set(tid, { running: false, dirty: false, timer: null });
  return syncStates.get(tid);
}

async function flushSync(tid) {
  const state = getSyncState(tid);
  state.dirty = true;
  if (state.running) return;
  state.running = true;
  try {
    while (state.dirty) {
      state.dirty = false;
      if (!fs.existsSync(path.join(os.homedir(), ".stone_memory", ".archive-off"))) {
        await syncFromThread(tid);
      }
    }
  } finally {
    state.running = false;
  }
}

function scheduleSync(tid, debounceMs = 300) {
  const state = getSyncState(tid);
  state.dirty = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    flushSync(tid).catch(err => log(`[${tid}] 实时同步失败: ${err.message}`));
  }, debounceMs);
}

function watchThreadFile(tid) {
  const sessionDir = getCfg("sessionDir", tid);
  if (!sessionDir || !fs.existsSync(sessionDir)) {
    log(`[${tid}] 无法实时监听：sessionDir 不存在 (${sessionDir || "未配置"})`);
    return null;
  }
  const targetName = `${tid}.jsonl`;
  try {
    // 监听父目录而不是文件本身，兼容 rebuild/编辑器用 rename 原子替换文件。
    const watcher = fs.watch(sessionDir, { persistent: true }, (_eventType, filename) => {
      if (!filename || path.basename(String(filename)) === targetName) scheduleSync(tid);
    });
    watcher.on("error", err => log(`[${tid}] 文件监听异常，将依靠巡检兜底: ${err.message}`));
    log(`[${tid}] 实时监听: ${path.join(sessionDir, targetName)}`);
    return watcher;
  } catch (err) {
    log(`[${tid}] 文件监听启动失败，将依靠巡检兜底: ${err.message}`);
    return null;
  }
}

async function checkAndMine(tid) {
  const STOP = path.join(os.homedir(), ".stone_memory");

  await checkImports(tid);
  const archiveDates = scanArchiveDates(tid);
  if (!archiveDates.length) return;
  const miningState = loadMiningState(tid);
  const bjToday = beijingToday();

  const minerOff = fs.existsSync(path.join(STOP, ".miner-off"));

  const pending = archiveDates.filter(d => d < bjToday && shouldAttempt(miningState, d, readArchiveDay(tid, d)));

  if (pending.length > 0 && !minerOff) {
    log(`[${tid}] 发现 ${pending.length} 天待挖掘: ${pending.join(", ")}`);
    for (const dateStr of pending) {
      await runMining(tid, dateStr);
    }
  }

}

async function main() {
  const args = process.argv.slice(2);
  const intervalIdx = args.indexOf("--interval");
  const intervalSec = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) || 300 : 300;
  const once = args.includes("--once");
  const threadFlag = args.includes("--thread") ? args[args.indexOf("--thread") + 1] : null;
  const supervisorPid = args.includes("--supervisor-pid") ? Number(args[args.indexOf("--supervisor-pid") + 1]) : null;

  if (!threadFlag && !once) {
    throw new Error("watcher worker 必须指定 --thread；多线程请启动 watcher-supervisor.js");
  }
  const threadIds = threadFlag ? [threadFlag] : listThreadIds();
  if (!threadIds.length) {
    log("没有配置任何线程，请先运行 stmem init --thread <id>");
    process.exit(1);
  }
  if (threadFlag) {
    workerLockDir = acquireWorkerLock(threadFlag);
    if (!workerLockDir) {
      log(`[${threadFlag}] 已有 worker 正在运行，本进程退出`);
      return;
    }
    process.once("exit", releaseWorkerLock);
    process.once("SIGTERM", () => { releaseWorkerLock(); process.exit(0); });
    process.once("SIGINT", () => { releaseWorkerLock(); process.exit(0); });
    if (supervisorPid) {
      const parentCheck = setInterval(() => {
        if (!processAlive(supervisorPid)) {
          log(`[${threadFlag}] supervisor ${supervisorPid} 已消失，worker 退出等待接管`);
          releaseWorkerLock();
          process.exit(0);
        }
      }, 5000);
      parentCheck.unref();
    }
  }

  for (const tid of threadIds) {
    fs.mkdirSync(getArchiveDir(tid), { recursive: true });
  }

  log(`===== SM Watcher 启动 =====`);
  log(`线程: ${threadIds.join(", ")}`);
  log(`归档模式: 文件变化实时同步；兜底巡检: ${intervalSec}s`);

  const fileWatchers = once ? [] : threadIds.map(watchThreadFile).filter(Boolean);

  while (true) {
    // 暂停标志检查
    if (fs.existsSync(path.join(os.homedir(), ".stone_memory", ".watcher-off"))) {
      log("watcher 已暂停（检测到 .watcher-off 标志），退出");
      process.exit(0);
    }
    for (const tid of threadIds) {
      try {
        // 启动时同步一次，之后这里只承担低频漏事件兜底。
        await flushSync(tid);
        await checkAndMine(tid);
      } catch (err) {
        log(`[${tid}] 轮询出错: ${err.message}`);
      }
    }
    if (once) break;
    await new Promise(r => setTimeout(r, intervalSec * 1000));
  }

  for (const watcher of fileWatchers) watcher.close();
  if (once) log("--once 模式，退出。");
}

// Windows 自愈：崩溃后自动重启（代替 systemd）
if (process.platform === "win32") {
  process.on("uncaughtException", (err) => {
    log(`FATAL: ${err.message}`);
    log("自愈: 10s 后自动重启...");
    setTimeout(() => {
      const { spawn } = require("child_process");
      const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true, stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      child.unref();
      process.exit(1);
    }, 10000).unref();
  });
}

main().catch(e => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
