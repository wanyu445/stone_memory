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
const { normalizeThreadMessage } = require("../src/lib/thread-message");
const { parseThreadMessages, ingestMessages } = require("../src/services/thread-ingest");

const { getCfg, getThreadDir, listThreadIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");

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

const memoryDir = path.join(threadDir, "memory");
let lastSyncedAt = "";

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
const allMessages = parseThreadMessages(raw);
if (!allMessages.length) {
  console.log("线程文件无有效消息");
  process.exit(0);
}

function timestampMs(value) {
  const ms = new Date(value || "").getTime();
  return Number.isFinite(ms) ? ms : null;
}

// 按时间戳过滤新消息。转成 epoch 比较，避免不同时区偏移的 ISO 字符串字典序失真。
const lastSyncedMs = timestampMs(lastSyncedAt);
// 每次都把完整线程交给幂等 ingest。水位只用于状态展示，不能用于过滤，
// 否则后来补入、但时间早于水位的迟到消息会永久丢失。
const newMessages = allMessages;

// 提取文本 + 按天分组
const byDate = {};
let maxTimestamp = lastSyncedAt;
let maxTimestampMs = lastSyncedMs ?? -Infinity;
for (const msg of newMessages) {
  if (!msg.timestamp) continue;
  const msgMs = timestampMs(msg.timestamp);
  if (msgMs !== null && msgMs > maxTimestampMs) {
    maxTimestampMs = msgMs;
    maxTimestamp = msg.timestamp;
  }

  const normalized = normalizeThreadMessage(msg);
  if (!normalized) continue;
  const { text } = normalized;
  if (isSystemTemplate(text) || text.includes("<!-- stmem-rule:")) continue;
  const d = beijingDateKey(msg.timestamp);
  if (!byDate[d]) byDate[d] = [];
  byDate[d].push(normalized);
}

// 统一 ingest 服务负责格式解析、北京时间分日、稳定哈希去重和乱序重排。
const store = new MemoryStore({ memoryDir, threadId: tid });
const ingestResult = ingestMessages(allMessages, { memoryStore: store, fullDir: path.join(memoryDir, "archive", "full") });
store.close();
const total = ingestResult.imported;

console.log(`同步完成: +${total} 条 (${ingestResult.dates} 天)，最新 ${maxTimestamp}`);
