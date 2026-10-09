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
const { execFile, execSync } = require("child_process");

const { getCfg, getThreadDir, listMemoryIds, getMemoryRuntimeConfig, getMemoryContext } = require("../src/config");
const { listJsonlRecursive } = require("../src/lib/archive-paths");
const { requiresRemine, shouldAttempt } = require("../src/services/mining-state");
const { resolveAutoCompactConfig } = require("../src/services/auto-compact-config");
const { ingestThreadFile: ingestSharedThreadFile } = require("../src/services/thread-ingest");
const { resolveAutomaticActions, shouldAutoMineDate } = require("../src/services/automatic-mining-policy");
const { runPostMiningHooks } = require("../src/services/post-mining-hooks");
const { processMatches } = require("../src/lib/process-identity");
const { acquireProcessLock } = require("../src/lib/process-lock");
const { latestContextUsage } = require("../src/lib/thread-context-usage");
const { updateContextUsage } = require("../src/services/rebuild-log");
const { MemoryStore } = require("../src/storage/memory-store");
const { watcherActions, watcherEnabled, watcherPaths, writeWatcherState } = require("../src/services/watcher-runtime");
const { enabledWatcherBindings } = require("../src/services/watcher-bindings");
const LOG_DIR = path.join(os.homedir(), ".stone_memory", "logs");
let workerLockDir = null;
let workerLease = null;
const successorDiscoveryRuns = new Set();

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

function acquireWorkerLock(threadId) {
  const { root, lockDir } = watcherPaths(threadId);
  fs.mkdirSync(root, { recursive: true });
  workerLease = acquireProcessLock(lockDir, { marker: "scripts/watcher.js" });
  if (!workerLease.acquired) return null;
  return lockDir;
}

function releaseWorkerLock() {
  workerLease?.release();
  workerLease = null;
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
      messageCount: row.message_count, archiveFingerprint: row.archive_fingerprint,
      completedAt: row.completed_at,
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

async function runMining(tid, dateStr, { force = false, threadConfig = {} } = {}) {
  const scriptPath = path.join(__dirname, "stmem-mine.js");
  const cmd = `${process.execPath} ${scriptPath} --thread ${tid} --date ${dateStr}${force ? " --force" : ""}`;
  log(`[${tid}] 开始挖掘 ${dateStr} ...`);

  try {
    const output = execSync(cmd, { encoding: "utf8", timeout: 600_000, cwd: path.dirname(__dirname), windowsHide: true });
    const lastLines = output.trim().split("\n").slice(-5).join(" | ");
    log(`[${tid}] 完成 ${dateStr}: ${lastLines}`);

    const store = new MemoryStore({ memoryDir: path.join(getThreadDir(tid), "memory"), threadId: tid });
    let feelingCount;
    let featureCount;
    try {
      feelingCount = store.listFeelings({ date: dateStr }).length;
      featureCount = store.listFeatures({ date: dateStr }).length;
    } finally {
      store.close();
    }
    log(`[${tid}] ${dateStr} 产出: ${feelingCount} feelings, ${featureCount} features`);

    const hookResults = runPostMiningHooks({
      threadId: tid,
      date: dateStr,
      today: beijingToday(),
      force,
      threadConfig,
      projectRoot: path.dirname(__dirname),
    });
    for (const result of hookResults) {
      if (result.attempted && result.ok) {
        log(`[${tid}] ${dateStr} 自动模块 ${result.id} 完成: ${result.output || ""}`);
      } else if (result.attempted) {
        log(`[${tid}] ${dateStr} 自动模块 ${result.id} 失败（不重试）: ${result.error?.message || "unknown error"}`);
      }
    }
    return true;
  } catch (err) {
    log(`[${tid}] 挖掘 ${dateStr} 失败: ${err.message}`);
    return false;
  }
}

function runAutoCompact(tid) {
  const config = resolveAutoCompactConfig(getMemoryRuntimeConfig(tid));
  if (config.error) {
    log(`[${tid}] 自动 compact 未启用：${config.error}`);
    return Promise.resolve(false);
  }
  if (!config.enabled) return Promise.resolve(false);

  const scriptPath = path.join(__dirname, "stmem-compact.js");
  const compactArgs = [scriptPath, "--thread", tid, "--auto", "--apply",
    "--max-chars", String(config.maxChars), "--stop-chars", String(config.stopChars)];
  log(`[${tid}] 检查自动 compact：触发 ${config.maxChars}，停止 ${config.stopChars}`);
  return new Promise(resolve => {
    execFile(process.execPath, compactArgs, {
      encoding: "utf8", cwd: path.dirname(__dirname), windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        log(`[${tid}] 自动 compact 失败: ${(stderr || err.message).trim().slice(0, 500)}`);
        resolve(false);
        return;
      }
      const summary = (stdout || "").trim().split("\n").filter(Boolean).slice(-2).join(" | ");
      log(`[${tid}] 自动 compact 完成${summary ? `: ${summary}` : ""}`);
      resolve(true);
    });
  });
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

function syncFromThread(tid, bindingId) {
  const syncScript = path.join(__dirname, "stmem-sync.js");
  if (!fs.existsSync(syncScript)) return Promise.resolve();
  const args = [syncScript, "--thread", tid];
  if (bindingId) args.push("--binding", bindingId);
  return new Promise(resolve => {
    execFile(process.execPath, args, {
      encoding: "utf8", timeout: 120_000, cwd: path.dirname(__dirname), windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        log(`[${tid}/${bindingId || "primary"}] sync 失败: ${(stderr || err.message).trim().slice(0, 300)}`);
        resolve();
        return;
      }
      const trimmed = (stdout || "").trim();
      if (trimmed && trimmed !== "已是最新" && !trimmed.includes("(no new messages)")) {
        log(`[${tid}/${bindingId || "primary"}] sync: ${trimmed.split("\n").pop()}`);
      }
      resolve();
    });
  });
}

// 同一记忆体只运行一个写入队列；各窗口可同时报告变化，但顺序写入共享归档与 SQLite。
const syncStates = new Map();

function getSyncState(tid) {
  if (!syncStates.has(tid)) syncStates.set(tid, { running: false, allDirty: false, dirtyBindings: new Set(), timer: null, latestArchiveDate: null });
  return syncStates.get(tid);
}

async function flushSync(tid, bindingId = null) {
  const state = getSyncState(tid);
  if (bindingId) state.dirtyBindings.add(bindingId);
  else state.allDirty = true;
  if (state.running) return;
  state.running = true;
  try {
    while (state.allDirty || state.dirtyBindings.size) {
      const requestedIds = state.allDirty ? null : [...state.dirtyBindings];
      state.allDirty = false;
      state.dirtyBindings.clear();
      const config = getMemoryRuntimeConfig(tid);
      const actions = resolveAutomaticActions(config);
      if (actions.sync) {
        const targets = enabledWatcherBindings(tid)
          .filter(binding => !requestedIds || requestedIds.includes(binding.id));
        for (const binding of targets) await syncFromThread(tid, binding.id);
      }
      const latestArchiveDate = scanArchiveDates(tid).at(-1) || null;
      const dateChanged = state.latestArchiveDate && latestArchiveDate && state.latestArchiveDate !== latestArchiveDate;
      state.latestArchiveDate = latestArchiveDate;
      if (dateChanged && actions.mine) {
        log(`[${tid}] SQLite 对话日期已推进到 ${latestArchiveDate}，按 mining state 检查待挖日期`);
        await checkAndMine(tid);
      }
      if (actions.sync) {
        for (const binding of enabledWatcherBindings(tid)) {
          const usage = latestContextUsage(binding.threadFile, binding.provider || config.runtime || "claude");
          if (usage) updateContextUsage(tid, { ...usage, bindingId: binding.id });
        }
      }
    }
  } finally {
    state.running = false;
  }
}

function scheduleSync(tid, bindingId, debounceMs = 300) {
  const state = getSyncState(tid);
  state.dirtyBindings.add(bindingId);
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    flushSync(tid, bindingId).catch(err => log(`[${tid}/${bindingId}] 实时同步失败: ${err.message}`));
  }, debounceMs);
}

function discoverBindingSuccessors(tid) {
  if (successorDiscoveryRuns.has(tid)) return;
  try { if (getMemoryContext(tid).layout !== "memory-v1") return; } catch { return; }
  successorDiscoveryRuns.add(tid);
  execFile(process.execPath, [path.join(__dirname, "..", "bin", "stmem"), "binding", "discover-successors", "--memory", tid, "--apply"], {
    cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 30_000, maxBuffer: 5 * 1024 * 1024, windowsHide: true,
  }, (error, stdout, stderr) => {
    successorDiscoveryRuns.delete(tid);
    if (error) {
      log(`[${tid}] fork 后继自动绑定失败: ${String(stderr || error.message).trim().slice(0, 300)}`);
      return;
    }
    try {
      const result = JSON.parse(stdout);
      if (result.changed) log(`[${tid}] 已自动绑定 ${result.added.length} 个 fork 后继窗口${result.stoppedBindingIds.length ? `，并停止 ${result.stoppedBindingIds.length} 个最久未活动监听` : ""}`);
    } catch (parseError) {
      log(`[${tid}] fork 后继自动绑定结果无法解析: ${parseError.message}`);
    }
  });
}

function watchMemoryBindings(tid) {
  const watchers = new Map();
  const reconcile = () => {
    discoverBindingSuccessors(tid);
    const active = new Set();
    for (const binding of enabledWatcherBindings(tid)) {
      active.add(binding.id);
      const signature = `${binding.sessionRoot || ""}\0${binding.externalThreadId || ""}\0${binding.threadFile || ""}`;
      if (watchers.get(binding.id)?.signature === signature) continue;
      watchers.get(binding.id)?.watcher?.close();
      if (!binding.threadFile) {
        if (!watchers.has(binding.id)) log(`[${tid}/${binding.id}] 找不到绑定线程文件，将等待巡检重新发现`);
        watchers.set(binding.id, { signature, watcher: null });
        continue;
      }
      const targetDir = path.dirname(binding.threadFile), targetName = path.basename(binding.threadFile);
      try {
        const watcher = fs.watch(targetDir, { persistent: true }, (_eventType, filename) => {
          if (!filename || path.basename(String(filename)) === targetName) scheduleSync(tid, binding.id);
        });
        watcher.on("error", err => log(`[${tid}/${binding.id}] 文件监听异常，将依靠巡检兜底: ${err.message}`));
        watchers.set(binding.id, { signature, watcher });
        log(`[${tid}/${binding.id}] 实时监听: ${binding.threadFile}`);
        scheduleSync(tid, binding.id, 0);
      } catch (err) {
        watchers.set(binding.id, { signature, watcher: null });
        log(`[${tid}/${binding.id}] 文件监听启动失败，将依靠巡检兜底: ${err.message}`);
      }
    }
    for (const [bindingId, entry] of watchers) {
      if (active.has(bindingId)) continue;
      entry.watcher?.close();
      watchers.delete(bindingId);
      log(`[${tid}/${bindingId}] 已停止监听`);
    }
  };
  reconcile();
  const timer = setInterval(reconcile, 5000);
  timer.unref();
  return { close() { clearInterval(timer); for (const entry of watchers.values()) entry.watcher?.close(); } };
}

async function checkAndMine(tid) {
  await checkImports(tid);
  const archiveDates = scanArchiveDates(tid);
  if (!archiveDates.length) return false;
  const miningState = loadMiningState(tid);
  const bjToday = beijingToday();
  const threadConfig = getMemoryRuntimeConfig(tid);
  const actions = resolveAutomaticActions(threadConfig);
  if (!actions.mine) return false;

  const messagesByDate = new Map();
  const messagesFor = date => {
    if (!messagesByDate.has(date)) messagesByDate.set(date, readArchiveDay(tid, date));
    return messagesByDate.get(date);
  };
  const pending = archiveDates.filter(d => d < bjToday
    && shouldAutoMineDate(d, {
      today: bjToday,
      automaticMemoryMaintenance: actions.mine,
    })
    && (shouldAttempt(miningState, d, messagesFor(d)) || requiresRemine(miningState, d, messagesFor(d))));

  let minedAny = false;
  if (pending.length > 0) {
    log(`[${tid}] 发现 ${pending.length} 天待挖掘: ${pending.join(", ")}`);
    for (const dateStr of pending) {
      const force = requiresRemine(miningState, dateStr, messagesFor(dateStr));
      if (await runMining(tid, dateStr, { force, threadConfig })) minedAny = true;
    }
  }

  return minedAny;

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
  const threadIds = threadFlag ? [threadFlag] : listMemoryIds();
  if (!threadIds.length) {
    log("没有配置任何记忆体，请先运行 stmem memory create");
    process.exit(1);
  }
  if (threadFlag) {
    workerLockDir = acquireWorkerLock(threadFlag);
    if (!workerLockDir) {
      log(`[${threadFlag}] 已有 worker 正在运行，本进程退出`);
      return;
    }
    const initialConfig = getMemoryRuntimeConfig(threadFlag);
    if (!watcherEnabled(initialConfig) && !once) {
      log(`[${threadFlag}] 自动化已全部关闭，worker 不启动`);
      releaseWorkerLock();
      return;
    }
    writeWatcherState(threadFlag, {
      status: "running", pid: process.pid, supervisorPid: supervisorPid || null,
      startedAt: new Date().toISOString(), actions: watcherActions(initialConfig),
    });
    process.once("exit", releaseWorkerLock);
    process.once("SIGTERM", () => { releaseWorkerLock(); process.exit(0); });
    process.once("SIGINT", () => { releaseWorkerLock(); process.exit(0); });
    if (supervisorPid) {
      const parentCheck = setInterval(() => {
      if (!processMatches(supervisorPid, "watcher-supervisor.js")) {
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

  const fileWatchers = once ? [] : threadIds.map(watchMemoryBindings).filter(Boolean);
  const compactChecked = new Set();

  while (true) {
    for (const tid of threadIds) {
      try {
        // 启动时同步一次，之后这里只承担低频漏事件兜底。
        await flushSync(tid);
        // Mining is triggered by flushSync only when the archive advances to a
        // new conversation date. Starting/restarting a worker must not turn
        // historical gaps into an immediate catch-up job.
        const minedAny = false;
        const actions = resolveAutomaticActions(getMemoryRuntimeConfig(tid));
        if (actions.compact && (!compactChecked.has(tid) || minedAny)) {
          compactChecked.add(tid);
          await runAutoCompact(tid);
        }
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

main().catch(e => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
