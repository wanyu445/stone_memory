#!/usr/bin/env node
/**
 * stmem adapt — 适配第三方记忆系统 → Stone Memory archive
 *
 * 用法:
 *   stmem adapt --from sqlite --db <path> --table memories
 *   stmem adapt --from json    --file <path>
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const STONE = path.join(os.homedir(), ".stone_memory");

function guessTimeFromDate(dateStr) {
  // 只有日期没有时间 → 默认中午
  if (!dateStr) return "";
  if (dateStr.includes("T")) return dateStr;
  return `${dateStr}T12:00:00.000Z`;
}

function addTimestampToContent(content, timestamp) {
  // 已有自然语言时间戳 "4月18日，晚上六点十五" → 不动
  if (/^\d+月\d+日/.test(content)) return content;

  // 没有 → 用记录时间戳补
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return content;

  const month = d.getMonth() + 1;  // JS month is 0-indexed
  const day = d.getDate();
  const hour = d.getHours();
  const minute = d.getMinutes();
  const periods = [
    [0, 5, "凌晨"], [6, 8, "早上"], [9, 11, "上午"],
    [12, 13, "中午"], [14, 17, "下午"], [18, 19, "傍晚"],
    [20, 23, "晚上"],
  ];
  let period = "";
  for (const [start, end, p] of periods) {
    if (hour >= start && hour <= end) { period = p; break; }
  }
  const timeStr = minute > 0 ? `${hour}点${String(minute).padStart(2, "0")}分` : `${hour}点`;
  return `${month}月${day}日，${period}${timeStr}。${content}`;
}

function adaptSQLite(dbPath, table) {
  // 尝试加载 sqlite3 模块
  let Database;
  try { Database = require("better-sqlite3"); } catch {
    try { Database = require("sqlite3"); } catch {
      console.log("需要安装 sqlite3: npm install better-sqlite3");
      process.exit(1);
    }
  }

  const db = new Database(dbPath);
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  db.close();

  const entries = [];
  for (const row of rows) {
    // 尝试常见字段名: content/text/message + created_at/timestamp/date
    const content = row.content || row.text || row.message || row.summary || "";
    const ts = row.created_at || row.timestamp || row.date || row.createdAt || "";
    if (!content) continue;

    const timestamp = guessTimeFromDate(ts);
    entries.push({
      timestamp: timestamp || new Date().toISOString(),
      type: row.role || row.type || "assistant",
      text: addTimestampToContent(content, timestamp),
    });
  }
  return entries;
}

function adaptJSON(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  let data;
  try { data = JSON.parse(raw); } catch { console.log("JSON 解析失败"); process.exit(1); }

  const arr = Array.isArray(data) ? data : (data.memories || data.entries || data.data || [data]);
  const entries = [];
  for (const row of arr) {
    const content = row.content || row.text || row.message || row.summary || "";
    const ts = row.created_at || row.timestamp || row.date || row.createdAt || "";
    if (!content) continue;

    const timestamp = guessTimeFromDate(ts);
    entries.push({
      timestamp: timestamp || new Date().toISOString(),
      type: row.role || row.type || "assistant",
      text: addTimestampToContent(content, timestamp),
    });
  }
  return entries;
}

async function main() {
  const args = process.argv.slice(3);
  const fromIdx = args.indexOf("--from");
  const from = fromIdx >= 0 ? args[fromIdx + 1] : "";

  let entries = [];
  if (from === "sqlite") {
    const dbIdx = args.indexOf("--db");
    const tableIdx = args.indexOf("--table");
    const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "";
    const table = tableIdx >= 0 ? args[tableIdx + 1] : "memories";
    if (!dbPath) { console.log("需要 --db <path>"); process.exit(1); }
    entries = adaptSQLite(dbPath, table);
  } else if (from === "json") {
    const fileIdx = args.indexOf("--file");
    const filePath = fileIdx >= 0 ? args[fileIdx + 1] : "";
    if (!filePath) { console.log("需要 --file <path>"); process.exit(1); }
    entries = adaptJSON(filePath);
  } else {
    console.log("用法: stmem adapt --from sqlite --db <path> --table memories");
    console.log("      stmem adapt --from json   --file <path>");
    process.exit(1);
  }

  if (entries.length === 0) {
    console.log("未提取到任何条目");
    process.exit(1);
  }

  // 写入 archive
  const cfgPath = path.join(STONE, "stmem.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const archiveDir = path.join(
    STONE, "runtimes", cfg.runtime || "claude",
    cfg.purpose || "accompany", cfg.threadId, "memory", "archive"
  );
  fs.mkdirSync(archiveDir, { recursive: true });

  const byDate = {};
  for (const e of entries) {
    const d = (e.timestamp || "").slice(0, 10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(e);
  }
  for (const [d, msgs] of Object.entries(byDate)) {
    const lines = msgs.map(m => JSON.stringify(m));
    fs.appendFileSync(path.join(archiveDir, `${d}.jsonl`), lines.join("\n") + "\n");
  }

  console.log(`适配完成: ${entries.length} 条, ${Object.keys(byDate).length} 天`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
