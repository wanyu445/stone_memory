#!/usr/bin/env node
/**
 * stmem import — 手动导入线程文件到 archive
 *
 * 用法:
 *   stmem import --source <path.jsonl> [--thread <id>]
 *   stmem import --dir <path> [--thread <id>]         导入目录下所有 .jsonl
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getCfg, getThreadDir, listThreadIds } = require("../src/config");

function detectFormat(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean).slice(0, 5);
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj.type === "message" || obj.response_item) return "codex";
      if (obj.type === "session_meta" || obj.type === "response_item") return "codex";
    }
  } catch {}
  return "claude";
}

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

function beijingDateKey(ts) {
  const d = new Date(ts);
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}

function getFullLastTimestamp(fullDir, dateKey) {
  const fp = path.join(fullDir, `${dateKey}.jsonl`);
  if (!fs.existsSync(fp)) return null;
  const raw = fs.readFileSync(fp, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  if (!lines.length) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const obj = JSON.parse(lines[i]); if (obj.timestamp) return obj.timestamp; } catch {}
  }
  return null;
}

/** Codex 格式提取：response_item.payload.content[] */
function extractCodexEntries(messages) {
  let imported = 0;
  const seen = new Set();
  const byDate = new Map();

  for (const msg of messages) {
    if (msg.type !== "response_item" || msg.payload?.type !== "message") continue;
    if (msg.payload.role === "developer") continue;
    const ts = msg.timestamp;
    if (!ts) continue;
    const dateKey = beijingDateKey(ts);

    const blocks = Array.isArray(msg.payload.content)
      ? msg.payload.content.filter(b => b.type === "input_text" || b.type === "output_text")
      : [];
    let text = blocks.map(b => b.text || "").join("\n").trim();
    if (!text) continue;
    if (isSystemTemplate(text) || text.includes("<!-- stmem-rule:")) continue;

    const dedupKey = crypto.createHash("md5").update(ts + "|" + text).digest("hex");
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push({
      timestamp: ts,
      type: msg.payload.role === "user" ? "user" : "assistant",
      text: text.slice(0, 2000),
    });
    imported++;
  }

  return { imported, byDate };
}

/** Claude 原格式提取：msg.message.content[] + msg.text 兜底 */
function extractClaudeEntries(messages) {
  let imported = 0;
  const seen = new Set();
  const byDate = new Map();

  for (const msg of messages) {
    const ts = msg.timestamp;
    if (!ts) continue;
    if (msg.type === "system") continue;
    const dateKey = beijingDateKey(ts);

    let text = "";
    const content = msg.message?.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(b => b.type === "text")
        .map(b => b.text || "").join("\n");
    } else if (msg.text) {
      // 支持 weixin.* 等直接用 msg.text 的格式
      text = typeof msg.text === "string" ? msg.text : JSON.stringify(msg.text);
    }
    if (!text.trim()) continue;
    if (isSystemTemplate(text) || text.includes("<!-- stmem-rule:")) continue;

    const dedupKey = crypto.createHash("md5").update(ts + "|" + text).digest("hex");
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push({ timestamp: ts, type: msg.type || "user", text: text.slice(0, 2000) });
    imported++;
  }

  return { imported, byDate };
}

function importFile(filePath, archiveDir, fullDir) {
  const format = detectFormat(filePath);
  const messages = [];
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n").filter(Boolean)) {
    try { messages.push(JSON.parse(line)); } catch {}
  }

  // --- full/ 增量备份（北京时间，全量原始消息，同 rebuild） ---
  fs.mkdirSync(fullDir, { recursive: true });
  const fullByDate = new Map();
  for (const msg of messages) {
    const ts = msg.timestamp;
    if (!ts) continue;
    const bjKey = beijingDateKey(ts);
    if (!fullByDate.has(bjKey)) fullByDate.set(bjKey, []);
    fullByDate.get(bjKey).push(msg);
  }
  let fullCount = 0;
  for (const [dateKey, msgs] of fullByDate) {
    const lastTs = getFullLastTimestamp(fullDir, dateKey);
    const newMsgs = lastTs ? msgs.filter(m => (m.timestamp || "") > lastTs) : msgs;
    if (newMsgs.length > 0) {
      for (const m of newMsgs) {
        fs.appendFileSync(path.join(fullDir, `${dateKey}.jsonl`), JSON.stringify(m) + "\n", "utf8");
        fullCount++;
      }
    }
  }

  // --- archive（清洗格式，去重） ---
  const { imported, byDate } = format === "codex"
    ? extractCodexEntries(messages)
    : extractClaudeEntries(messages);

  fs.mkdirSync(archiveDir, { recursive: true });
  for (const [dateKey, msgs] of byDate) {
    msgs.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
    const archiveFile = path.join(archiveDir, `${dateKey}.jsonl`);
    const existing = new Set();
    if (fs.existsSync(archiveFile)) {
      for (const line of fs.readFileSync(archiveFile, "utf8").split("\n").filter(Boolean)) {
        try { existing.add(JSON.parse(line).timestamp + "|" + (JSON.parse(line).text || "").slice(0, 50)); } catch {}
      }
    }
    const lines = [];
    for (const m of msgs) {
      const key = m.timestamp + "|" + (m.text || "").slice(0, 50);
      if (existing.has(key)) continue;
      existing.add(key);
      lines.push(JSON.stringify(m));
    }
    if (lines.length > 0) fs.appendFileSync(archiveFile, lines.join("\n") + "\n", "utf8");
  }

  return { imported, dates: byDate.size, format, fullBacked: fullCount };
}

function main() {
  const args = process.argv.slice(2);
  const threadIdx = args.indexOf("--thread");
  const sourceIdx = args.indexOf("--source");
  const dirIdx = args.indexOf("--dir");

  // 检查未识别的多余参数
  const knownFlags = new Set(["--thread", "--source", "--dir"]);
  const skipNext = new Set([threadIdx, sourceIdx, dirIdx].filter(i => i >= 0));
  for (let i = 0; i < args.length; i++) {
    if (skipNext.has(i)) { i++; continue; }
    if (args[i].startsWith("--") && !knownFlags.has(args[i])) {
      console.error(`未知参数: ${args[i]}，用法: stmem import --dir <path> [--thread <id>]`);
      process.exit(1);
    }
    if (!args[i].startsWith("--") && !skipNext.has(i - 1)) {
      console.error(`未识别的参数: ${args[i]}。如果要指定线程请用 --thread <id>`);
      process.exit(1);
    }
  }

  const tid = threadIdx >= 0 ? args[threadIdx + 1] : listThreadIds()[0];
  if (!tid) { console.error("未指定线程，请用 --thread <id> 或先 stmem init"); process.exit(1); }

  const threadDir = getThreadDir(tid);
  const archiveDir = path.join(threadDir, "memory", "archive");
  const fullDir = path.join(archiveDir, "full");
  const doneDir = path.join(threadDir, "memory", "import", "done");
  fs.mkdirSync(doneDir, { recursive: true });

  let files = [];
  if (dirIdx >= 0) {
    const dir = args[dirIdx + 1];
    if (!fs.existsSync(dir)) { console.error("目录不存在: " + dir); process.exit(1); }
    files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(f => path.join(dir, f));
  } else if (sourceIdx >= 0) {
    files = [args[sourceIdx + 1]];
  } else {
    // 默认扫描 import/ 目录
    const importDir = path.join(threadDir, "memory", "import");
    try { files = fs.readdirSync(importDir).filter(f => f.endsWith(".jsonl")).map(f => path.join(importDir, f)); } catch {}
  }

  if (!files.length) {
    console.log("无文件可导入。用法: stmem import --source <path.jsonl> 或 --dir <path>");
    process.exit(1);
  }

  console.log(`[import] 线程: ${tid}`);
  console.log(`[import] archive: ${archiveDir}`);
  let total = 0;

  for (const fp of files) {
    if (!fs.existsSync(fp)) { console.log(`  SKIP: ${fp}`); continue; }
    console.log(`  导入: ${path.basename(fp)}`);
    try {
      const r = importFile(fp, archiveDir, fullDir);
      total += r.imported;
      console.log(`    → ${r.imported} messages, ${r.dates} dates (${r.format}), full: +${r.fullBacked}`);
      // 备份已导入的文件到 done/（不移走原始文件）
      const donePath = path.join(doneDir, path.basename(fp).replace(".jsonl", `_${Date.now()}.jsonl`));
      fs.copyFileSync(fp, donePath);
    } catch (err) {
      console.error(`  失败: ${err.message}`);
    }
  }

  console.log(`\n[import] 完成: ${total} messages`);
}

try { main(); } catch (e) { console.error(e.message); process.exit(1); }
