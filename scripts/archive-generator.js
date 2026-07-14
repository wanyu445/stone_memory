#!/usr/bin/env node
/**
 * Archive Generator — 多线程统一入口
 *
 * 输入: Claude Code + Codex 线程 JSONL 文件列表
 * 输出: archive/YYYY-MM-DD.jsonl (统一格式 {timestamp, type, text})
 *
 * 同一天多个线程的内容合并，timestamp+text 去重
 *
 * 用法:
 *   node scripts/archive-generator.js --claude <path.jsonl> --codex <path.jsonl> ...
 *   node scripts/archive-generator.js --config <config.json>  # 从配置文件读取
 */

const fs = require("fs");
const path = require("path");
const { getThreadDir, listThreadIds } = require("../src/config");

function getArchiveDir(threadId) {
  const tid = threadId || listThreadIds()[0];
  if (!tid) throw new Error("No thread configured");
  return path.join(getThreadDir(tid), "memory", "archive");
}

// ---- Claude Code 线程清洗 ----

function cleanClaudeThread(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
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

  const entries = [];
  for (const msg of messages) {
    if (msg.type === "system") continue;
    let text = "";
    const content = msg.message?.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text || "")
        .join(" ")
        .trim();
    }
    if (!text) continue;
    // 跳过系统注入
    if (/WECHAT SESSION|<memory_context>|你上线了|Trigger:|你从哪来|石头待办清单/.test(text)) continue;

    entries.push({
      timestamp: msg.timestamp || new Date().toISOString(),
      type: msg.type,
      text,
    });
  }
  return entries;
}

// ---- Codex 线程清洗 ----

function cleanCodexThread(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const entries = [];

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    const ts = obj.timestamp || "";

    // response_item with user/assistant messages
    if (obj.type === "response_item" && obj.payload?.type === "message") {
      const role = obj.payload.role;
      const content = obj.payload.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((b) => b.type === "input_text" || b.type === "output_text")
        .map((b) => b.text || "")
        .join(" ")
        .trim();
      if (!text) continue;
      if (role === "developer") continue; // skip system instructions

      entries.push({
        timestamp: ts,
        type: role === "user" ? "user" : "assistant",
        text,
      });
    }
  }
  return entries;
}

// ---- 写入 archive ----

function writeArchive(entries) {
  // 按天分组
  const byDate = {};
  for (const e of entries) {
    const d = e.timestamp.slice(0, 10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(e);
  }

  let total = 0;
  for (const [date, msgs] of Object.entries(byDate)) {
    const filePath = path.join(ARCHIVE_DIR, `${date}.jsonl`);

    // 读已有内容用于去重
    const existing = new Set();
    if (fs.existsSync(filePath)) {
      const old = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      for (const line of old) {
        try {
          const obj = JSON.parse(line);
          existing.add(`${obj.timestamp}|${obj.text?.slice(0, 50)}`);
        } catch {}
      }
    }

    // 追加新条目
    const lines = [];
    for (const m of msgs) {
      const key = `${m.timestamp}|${(m.text || "").slice(0, 50)}`;
      if (existing.has(key)) continue;
      existing.add(key);
      lines.push(JSON.stringify({ timestamp: m.timestamp, type: m.type, text: m.text }));
    }

    if (lines.length > 0) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      fs.appendFileSync(filePath, lines.join("\n") + "\n", "utf8");
      console.log(`  ${date}: +${lines.length} msgs (total: ${existing.size})`);
      total += lines.length;
    }
  }
  return total;
}

// ---- 主流程 ----

function main() {
  const args = process.argv.slice(2);
  let ARCHIVE_DIR;
  const outputIdx = args.indexOf("--output");
  const threadIdx = args.indexOf("--thread");
  if (outputIdx >= 0) {
    ARCHIVE_DIR = args[outputIdx + 1];
  } else if (threadIdx >= 0) {
    ARCHIVE_DIR = getArchiveDir(args[threadIdx + 1]);
  } else {
    try { ARCHIVE_DIR = getArchiveDir(); } catch { ARCHIVE_DIR = null; }
  }
  if (!ARCHIVE_DIR) { console.error("请指定 --output <dir> 或 --thread <id>"); process.exit(1); }
  const configIdx = args.indexOf("--config");
  const claudeIdxs = [];
  const codexIdxs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--claude") claudeIdxs.push(i + 1);
    if (args[i] === "--codex") codexIdxs.push(i + 1);
  }

  let claudeFiles = claudeIdxs.map(i => args[i]).filter(Boolean);
  let codexFiles = codexIdxs.map(i => args[i]).filter(Boolean);

  if (configIdx >= 0) {
    const cfg = JSON.parse(fs.readFileSync(args[configIdx + 1], "utf8"));
    if (cfg.claude) claudeFiles = claudeFiles.concat(cfg.claude);
    if (cfg.codex) codexFiles = codexFiles.concat(cfg.codex);
  }

  if (claudeFiles.length === 0 && codexFiles.length === 0) {
    console.log("用法: node archive-generator.js --claude <file.jsonl> --codex <file.jsonl>");
    console.log("  或:  node archive-generator.js --config <config.json>");
    console.log("");
    console.log("config.json 格式:");
    console.log('  { "claude": ["path/to/thread.jsonl"], "codex": ["path/to/thread.jsonl"] }');
    return;
  }

  const allEntries = [];

  for (const f of claudeFiles) {
    if (!fs.existsSync(f)) { console.log(`SKIP: ${f} (not found)`); continue; }
    console.log(`Processing Claude: ${f}`);
    const e = cleanClaudeThread(f);
    allEntries.push(...e);
    console.log(`  → ${e.length} entries`);
  }

  for (const f of codexFiles) {
    if (!fs.existsSync(f)) { console.log(`SKIP: ${f} (not found)`); continue; }
    console.log(`Processing Codex: ${f}`);
    const e = cleanCodexThread(f);
    allEntries.push(...e);
    console.log(`  → ${e.length} entries`);
  }

  // 排序
  allEntries.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));

  console.log(`\nWriting archive to ${ARCHIVE_DIR}...`);
  const total = writeArchive(allEntries);
  console.log(`\nDone: ${total} new messages across ${[...new Set(allEntries.map(e => e.timestamp.slice(0,10)))].length} days`);
}

main();
