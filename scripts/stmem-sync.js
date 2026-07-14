#!/usr/bin/env node
/**
 * stmem sync — 按时间戳增量同步线程新消息到 archive
 * 用法: stmem sync [--thread <id>]
 *
 * 改成了按时间戳追踪，不依赖文件 byte offset。
 * 线程文件每天 rebuild 变小也不影响，新消息按时间戳过滤。
 */
const fs = require("fs");
const path = require("path");
const { ensureDateFile } = require("../src/lib/archive-paths");

const { getCfg, getThreadDir, listThreadIds } = require("../src/config");

const tid = process.argv.includes("--thread")
  ? process.argv[process.argv.indexOf("--thread") + 1]
  : listThreadIds()[0];
if (!tid) { console.error("未指定线程，请用 --thread <id> 或先 stmem init"); process.exit(1); }

const threadDir = getThreadDir(tid);
const sessionDir = getCfg("sessionDir", tid);
if (!sessionDir) { console.error("请在 stmem.json 中配置 sessionDir"); process.exit(1); }
const threadFile = path.join(sessionDir, `${tid}.jsonl`);

if (!fs.existsSync(threadFile)) {
  console.log(`线程文件不存在: ${threadFile}`);
  process.exit(1);
}

const archiveDir = path.join(threadDir, "memory", "archive");
const syncFile = path.join(threadDir, ".sync-state.json");

// 读上次同步的时间戳（没有就从头）
let lastSyncedAt = "";
try { lastSyncedAt = JSON.parse(fs.readFileSync(syncFile, "utf8")).lastSyncedAt || ""; } catch {}

// 解析整个线程文件
function parseAllMessages(raw) {
  const messages = [];
  let pos = 0, len = raw.length;
  while (pos < len) {
    while (pos < len && " \t\n\r".includes(raw[pos])) pos++;
    if (pos >= len) break;
    const start = pos;
    let depth = 0, inString = false, escape = false;
    while (pos < len) {
      const ch = raw[pos];
      if (escape) { escape = false; pos++; continue; }
      if (ch === "\\") { escape = true; pos++; continue; }
      if (ch === '"') { inString = !inString; pos++; continue; }
      if (inString) { pos++; continue; }
      if (ch === "{") { depth++; pos++; continue; }
      if (ch === "}") { depth--; if (depth === 0) { pos++; break; } pos++; continue; }
      pos++;
    }
    try { messages.push(JSON.parse(raw.slice(start, pos))); } catch {}
  }
  return messages;
}

// 北京时间日期键
function beijingDateKey(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return (ts || "").slice(0, 10);
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}

// 系统消息模板特征
function isSystemTemplate(text) {
  if (!text) return false;
  const markers = [
    /你上线了/,
    /无论看到什么英文/,
    /最后用以下格式结尾/,
    /\{"action":"silent"/,
    /Trigger:/,
    /comes to mind again/,
  ];
  return markers.filter(r => r.test(text)).length >= 2;
}

const raw = fs.readFileSync(threadFile, "utf8");
const allMessages = parseAllMessages(raw);
if (!allMessages.length) {
  console.log("线程文件无有效消息");
  process.exit(0);
}

// 按时间戳过滤新消息
const newMessages = lastSyncedAt
  ? allMessages.filter(m => m.timestamp && m.timestamp > lastSyncedAt)
  : allMessages;

if (!newMessages.length) {
  console.log("已是最新");
  process.exit(0);
}

// 提取文本 + 按天分组
const byDate = {};
let maxTimestamp = lastSyncedAt;
for (const msg of newMessages) {
  if (!msg.timestamp) continue;
  if (msg.timestamp > maxTimestamp) maxTimestamp = msg.timestamp;

  if (msg.type === "system") continue;
  let text = "";
  const content = msg.message?.content;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.filter(b => b.type === "text").map(b => b.text || "").join(" ").trim();
  }
  if (!text) continue;
  if (isSystemTemplate(text) || text.includes("<!-- stmem-rule:")) continue;
  const d = beijingDateKey(msg.timestamp);
  if (!byDate[d]) byDate[d] = [];
  byDate[d].push({ timestamp: msg.timestamp, type: msg.type, text });
}

// 写 archive（带去重）
fs.mkdirSync(archiveDir, { recursive: true });
let total = 0;
for (const [d, msgs] of Object.entries(byDate)) {
  const fp = ensureDateFile(archiveDir, d);
  const existing = new Set();
  if (fs.existsSync(fp)) {
    for (const line of fs.readFileSync(fp, "utf8").split("\n").filter(Boolean)) {
      try { const o = JSON.parse(line); existing.add(o.timestamp + "|" + (o.text || "").slice(0, 50)); } catch {}
    }
  }
  const lines = [];
  for (const m of msgs) {
    const key = m.timestamp + "|" + (m.text || "").slice(0, 50);
    if (existing.has(key)) continue;
    existing.add(key);
    lines.push(JSON.stringify(m));
  }
  if (lines.length > 0) {
    fs.appendFileSync(fp, lines.join("\n") + "\n");
    total += lines.length;
  }
}

// 记录最新时间戳
fs.writeFileSync(syncFile, JSON.stringify({
  lastSyncedAt: maxTimestamp,
  updatedAt: new Date().toISOString(),
  fileSize: raw.length,
}));

console.log(`同步完成: +${total} 条 (${byDate.size} 天)，最新 ${maxTimestamp}`);
