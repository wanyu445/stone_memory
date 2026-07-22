#!/usr/bin/env node
/**
 * stmem delete — 删除线程配置及数据目录
 *
 * 用法:
 *   stmem delete --thread <id>            删除指定线程
 *   stmem delete --thread <id> --dry-run  预览
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const Database = require("better-sqlite3");
const { loadConfig, getThreadDir, listThreadIds } = require("../src/config");
const { resolveDatabasePath } = require("../src/storage/database-location");

const STONE = path.join(os.homedir(), ".stone_memory");
const cfgFile = path.join(STONE, "stmem.json");

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const threadIdx = args.indexOf("--thread");
  const tid = threadIdx >= 0 ? args[threadIdx + 1] : null;

  if (!tid) {
    console.log("用法: stmem delete --thread <id> [--dry-run]");
    process.exit(1);
  }

  const cfg = loadConfig();
  if (!cfg[tid]) {
    console.error("线程不存在: " + tid);
    process.exit(1);
  }

  const threadDir = getThreadDir(tid);
  const threadName = cfg[tid].ai + " × " + cfg[tid].user;

  console.log("线程: " + tid);
  console.log("名称: " + threadName);
  console.log("目录: " + threadDir);

  if (dryRun) {
    let dirSize = 0;
    try {
      const { execSync } = require("child_process");
      dirSize = execSync(`du -sh "${threadDir}" 2>/dev/null | cut -f1`, { encoding: "utf8" }).trim();
    } catch {}
    console.log("大小: " + (dirSize || "未知"));
    console.log("\n[DRY RUN] 将删除此线程的配置和数据。使用 --apply 实际执行。");
    return;
  }

  // 删除数据目录
  if (fs.existsSync(threadDir)) {
    fs.rmSync(threadDir, { recursive: true, force: true });
    console.log("已删除目录: " + threadDir);
  }

  // SQLite 已是所有线程共享的正式数据源；删除记忆库时必须同步清理该线程的行。
  const dbPath = resolveDatabasePath(path.join(threadDir, "memory"));
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath);
    try {
      db.transaction(() => {
        db.prepare("UPDATE threads SET parent_thread_id=NULL WHERE parent_thread_id=?").run(tid);
        for (const table of ["messages", "mining_day_state", "notifications", "feelings", "features", "mining_jobs", "term_daily_stats"])
          db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(tid);
        db.prepare("DELETE FROM threads WHERE id=?").run(tid);
      })();
      console.log("已从共享数据库移除线程数据");
    } finally { db.close(); }
  }

  // 从 config 移除
  delete cfg[tid];
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf8");
  console.log("已从配置移除");
  console.log("\n✅ 线程 " + tid + " 已删除");
}

try { main(); } catch (e) { console.error(e.message); process.exit(1); }
