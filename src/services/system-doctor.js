const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { loadConfig, getThreadDir } = require("../config");
const { findThreadSessionFile } = require("../lib/thread-session-file");
const { MemoryStore } = require("../storage/memory-store");
const { processMatches } = require("../lib/process-identity");
const { readWatcherState, watcherActions, watcherEnabled } = require("./watcher-runtime");
const { windowsWatcherServiceStatus } = require("./windows-watcher-service");

const REQUIRED_CONFIG = ["label", "ai", "user", "runtime", "purpose", "sessionDir", "minerMode"];

function watcherStatus(threadId = null, threadConfig = {}) {
  const root = path.join(os.homedir(), ".stone_memory");
  let pid = null;
  try { pid = Number(fs.readFileSync(path.join(root, "watcher.pid"), "utf8")); } catch {}
  const running = !!pid && processMatches(pid, "watcher-supervisor.js");
  const state = threadId ? readWatcherState(threadId) : null;
  const service = process.platform === "win32"
    ? windowsWatcherServiceStatus({ projectDir: path.resolve(__dirname, "..", "..") })
    : null;
  return {
    running,
    pid: running ? pid : null,
    enabledForThread: threadId ? watcherEnabled(threadConfig) : null,
    actions: threadId ? watcherActions(threadConfig) : null,
    worker: state,
    service,
  };
}

function sourceStatus(projectDir) {
  if (!fs.existsSync(path.join(projectDir, ".git"))) return { repository: false, dirty: null };
  try {
    const output = execFileSync("git", ["status", "--short"], {
      cwd: projectDir, encoding: "utf8", timeout: 5000, windowsHide: true,
    }).trim();
    return { repository: true, dirty: !!output, changedFileCount: output ? output.split(/\r?\n/).length : 0 };
  } catch (error) {
    return { repository: true, dirty: null, error: error.message };
  }
}

function failure(threadId, code, reason, nextCommand, checks = {}) {
  return {
    ok: false,
    code,
    threadId: threadId || null,
    reason,
    nextCommand,
    sourceModificationRequired: false,
    forbiddenActions: [
      "不要直接编辑 stmem.json",
      "不要虚构配置字段或另写导入、清洗、rebuild 脚本",
      "不要修改源码、禁用按钮或绕过 dry-run",
    ],
    checks,
  };
}

function diagnoseThread(threadId, { projectDir = path.resolve(__dirname, "..", "..") } = {}) {
  const config = loadConfig();
  const checks = { configuration: {}, session: {}, database: {}, watcher: watcherStatus(threadId, config[threadId] || {}), source: sourceStatus(projectDir) };
  if (!threadId || !config[threadId] || typeof config[threadId] !== "object") {
    return failure(
      threadId,
      "THREAD_NOT_CONFIGURED",
      `配置中不存在真实线程 ID：${threadId || "(未提供)"}`,
      "stmem memory create --name <名称>",
      checks,
    );
  }

  const entry = config[threadId];
  const missing = REQUIRED_CONFIG.filter(key => !String(entry[key] ?? "").trim());
  checks.configuration = { valid: !missing.length, missingFields: missing };
  if (missing.length) {
    return failure(
      threadId,
      "CONFIG_INVALID",
      `线程配置缺少字段：${missing.join(", ")}`,
      `stmem memory migrate-layout --memory ${threadId}`,
      checks,
    );
  }
  if (!["claude", "codex"].includes(entry.runtime)) {
    return failure(threadId, "RUNTIME_INVALID", `不支持的 runtime：${entry.runtime}`, `stmem memory migrate-layout --memory ${threadId}`, checks);
  }
  if (!fs.existsSync(entry.sessionDir)) {
    checks.session = { rootExists: false, root: entry.sessionDir, fileFound: false };
    return failure(
      threadId,
      "SESSION_DIR_NOT_FOUND",
      `线程文件搜索目录不存在：${entry.sessionDir}`,
      `stmem memory migrate-layout --memory ${threadId}`,
      checks,
    );
  }

  const sessionFile = findThreadSessionFile(entry.sessionDir, threadId);
  checks.session = { rootExists: true, root: entry.sessionDir, fileFound: !!sessionFile, file: sessionFile || null };
  if (!sessionFile) {
    return failure(
      threadId,
      "SESSION_FILE_NOT_FOUND",
      `sessionDir 中找不到文件名包含真实 threadId “${threadId}” 的 JSONL`,
      `stmem memory migrate-layout --memory ${threadId}`,
      checks,
    );
  }

  const memoryDir = path.join(getThreadDir(threadId), "memory");
  try {
    const store = new MemoryStore({ memoryDir, threadId });
    const threadRow = store.db.prepare("SELECT id FROM threads WHERE id=?").get(threadId);
    const counts = store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM messages WHERE thread_id=?) messages,
      (SELECT COUNT(*) FROM feelings WHERE thread_id=?) feelings,
      (SELECT COUNT(*) FROM features WHERE thread_id=?) features`).get(threadId, threadId, threadId);
    const latestMining = store.db.prepare(`SELECT source_date,status,message_count,feeling_count,feature_count,error_code,error_message
      FROM mining_day_state WHERE thread_id=? ORDER BY source_date DESC LIMIT 1`).get(threadId) || null;
    store.close();
    checks.database = { accessible: true, threadRegistered: !!threadRow, ...counts, latestMining };
    if (!threadRow) {
      return failure(threadId, "DATABASE_THREAD_MISSING", "共享 SQLite 中没有该线程的登记记录", "stmem db migrate-all", checks);
    }
  } catch (error) {
    checks.database = { accessible: false, error: error.message };
    return failure(threadId, "DATABASE_UNAVAILABLE", `无法读取 Stone Memory SQLite：${error.message}`, "stmem db status", checks);
  }

  const warnings = [];
  if (checks.watcher.enabledForThread && !checks.watcher.running) warnings.push({ code: "WATCHER_NOT_RUNNING", reason: "该记忆体 watcher 期望状态为 ON，但 supervisor 当前未运行；请修复后台服务，而不是重复启动裸进程", nextCommand: process.platform === "win32" ? "stmem watcher service repair" : "stmem doctor --thread " + threadId });
  if (checks.watcher.service && !checks.watcher.service.expected) warnings.push({
    code: "WATCHER_SERVICE_DRIFT",
    reason: checks.watcher.service.installed ? "Windows watcher 计划任务定义与当前安装不一致" : "Windows watcher 计划任务未安装",
    nextCommand: "stmem watcher service repair",
  });
  if (checks.watcher.enabledForThread && checks.watcher.running && checks.watcher.worker?.status !== "running") warnings.push({
    code: "WATCHER_WORKER_NOT_RUNNING",
    reason: `该记忆体 watcher worker 当前状态：${checks.watcher.worker?.status || "等待启动"}`,
    nextCommand: "stmem watcher status --thread " + threadId,
  });
  if (checks.database.latestMining?.status === "blocked") warnings.push({
    code: "MINING_BLOCKED",
    reason: `最近日期 ${checks.database.latestMining.source_date} 挖掘已阻塞：${checks.database.latestMining.error_message || checks.database.latestMining.error_code || "未知错误"}`,
    nextCommand: `stmem mine --thread ${threadId} --date ${checks.database.latestMining.source_date} --force`,
  });
  if (checks.source.dirty) warnings.push({
    code: "SOURCE_MODIFIED",
    reason: `项目工作区存在 ${checks.source.changedFileCount} 项未提交改动；这不是配置修复手段`,
    nextCommand: "git status --short",
  });

  return {
    ok: true,
    code: warnings.length ? "OK_WITH_WARNINGS" : "OK",
    threadId,
    reason: warnings.length ? "核心配置、线程文件和数据库可用，但存在非阻塞提醒" : "核心配置、线程文件和数据库均可用",
    nextCommand: warnings[0]?.nextCommand || `stmem rebuild --thread ${threadId}`,
    sourceModificationRequired: false,
    warnings,
    checks,
  };
}

module.exports = { diagnoseThread, watcherStatus, sourceStatus };
