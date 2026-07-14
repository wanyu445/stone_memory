#!/usr/bin/env node
/**
 * STMEM MCP Server — stdio JSON-RPC
 *
 * 工具: stmem_memory_rebuild, _mine, _status, _search, _deep_search,
 *       _audit_list, _audit_mark, _audit_query, _summarize, _triggers_check
 * 订阅用户无 API key 时自动用 claude -p（OAuth token）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawnSync } = require("child_process");
const { getCfg, getThreadDir, listThreadIds } = require("./src/config");
const { runSubagent } = require("./src/services/subagent-runner");
const { parseFeelingTime, feelingToUtc } = require("./src/services/thread-rebuilder");
const { parseJsonlFile, readFeelings } = require("./src/lib/jsonl");
const { parseJsonArray, parseJsonObject } = require("./src/lib/json-parse");

const CONFIG_PATH = path.join(os.homedir(), ".stone_memory", "stmem.json");
const PROJECT_ROOT = path.resolve(__dirname);
const SCRIPTS_DIR = path.join(PROJECT_ROOT, "scripts");
const OPS_DIR = path.join(PROJECT_ROOT, "operations");
const LOG_FILE = path.join(os.homedir(), ".stone_memory", "logs", "mcp.log");
const PENDING_REBUILD_FILE = path.join(os.homedir(), ".stone_memory", "rebuild-pending.json");

/** 获取 feeling 的完整日期字符串，优先从 createdAt 取年份，无 createdAt 时从月份推断（跨年保护） */
function feelingDate(month, day, feeling) {
  let year;
  if (feeling && feeling.createdAt) { const y = new Date(feeling.createdAt).getFullYear(); if (!isNaN(y)) year = y; }
  if (!year) { const now = new Date(); year = parseInt(month) > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear(); }
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
function feelingYM(month, feeling) { const d = feelingDate(month, 1, feeling); return d.slice(0, 7); }

// 启动时检查触发器，注入提醒到线程文件尾部
checkPendingTriggers();

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return null; }
}

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, "utf8"); } catch {}
}

function respond(id, result) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  const byteLength = Buffer.byteLength(body, "utf8");

  if (rpcMode === "jsonl") {
    process.stdout.write(`${body}\n`);
    return;
  }

  process.stdout.write(`Content-Length: ${byteLength}\r\n\r\n${body}`);
}

function subagentCall(prompt, opts = {}) {
  try {
    return runSubagent(prompt, opts);
  } catch (err) {
    const msg = err.stdout || err.stderr || err.message || String(err);
    log(`subagent error: ${msg.slice(0, 300)}`);
    return `Error: ${msg.slice(0, 500)}`;
  }
}

function resolveThread(args, cfg) {
  const sessionId = args.thread || process.env.CLAUDE_CODE_SESSION_ID || listThreadIds()[0];
  if (!sessionId) return null;
  const tc = cfg[sessionId] || {};
  return {
    threadId: sessionId,
    windowDays: args.window || tc.windowDays || 3,
    toolPairs: args.toolPairs ?? tc.keepToolPairs ?? 30,
  };
}

// ── 触发器 ──

function checkPendingTriggers() {
  const cfg = loadConfig();
  if (!cfg) return;
  const triggers = [];
  const now = new Date().toISOString();

  // 1. 待重建 — 直接执行，不注入文本提醒
  if (fs.existsSync(PENDING_REBUILD_FILE)) {
    let queue;
    try {
      queue = JSON.parse(fs.readFileSync(PENDING_REBUILD_FILE, "utf8"));
      const threadId = queue.threadId;
      const tc = cfg[threadId] || {};
      const runtime = tc.runtime || "claude";
      const scriptName = runtime === "codex" ? "rebuild-codex-thread.js" : "rebuild-thread.js";
      const script = path.join(SCRIPTS_DIR, scriptName);
      if (fs.existsSync(script)) {
        const windowFlag = queue.window ? `--window ${queue.window}` : "";
        const cmd = `${process.execPath} ${script} --thread ${threadId} --apply ${windowFlag}`.trim();
        log(`pending rebuild: ${cmd}`);
        try {
          execSync(cmd, { encoding: "utf8", timeout: 120000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
          log(`pending rebuild done: ${threadId}`);
        } catch (e) {
          log(`pending rebuild failed: ${e.stderr || e.message}`);
        }
      }
    } catch {}
    try { fs.unlinkSync(PENDING_REBUILD_FILE); } catch {}
  }

  // 2. 待月摘要
  for (const tid of listThreadIds()) {
    const summaryTriggerDays = getCfg("summaryTriggerDays", tid, 60);
    const summaryWindowDays = getCfg("summaryWindowDays", tid, 30);
    const feelDir = path.join(getThreadDir(tid), "memory", "mined", "feelings");
    const daysFile = path.join(feelDir, "days.jsonl");
    const monthsFile = path.join(feelDir, "months.jsonl");
    if (!fs.existsSync(daysFile)) continue;
    const uniqueDates = new Set();
    try {
      for (const line of fs.readFileSync(daysFile, "utf8").split("\n").filter(Boolean)) {
        const obj = JSON.parse(line);
        if (obj.type === "feeling") {
          const m = (obj.content || "").match(/^(\d+)月(\d+)日/);
          if (m) uniqueDates.add(feelingDate(m[1], m[2], obj));
        }
      }
    } catch {}
    if (uniqueDates.size < summaryTriggerDays) continue;
    const sorted = [...uniqueDates].sort();
    const start = sorted[0];
    const end = sorted[Math.min(summaryWindowDays - 1, sorted.length - 1)];
    const monthKey = start.slice(0, 7);
    let covered = false;
    try {
      if (fs.existsSync(monthsFile)) {
        for (const line of fs.readFileSync(monthsFile, "utf8").split("\n").filter(Boolean)) {
          const obj = JSON.parse(line);
          if (obj.monthStart && obj.monthStart.startsWith(monthKey)) { covered = true; break; }
        }
      }
    } catch {}
    if (!covered) triggers.push({ type: "summary", threadId: tid, start, end, totalDays: uniqueDates.size });
  }

  // 注入到线程文件尾部
  for (const t of triggers) {
    const sessionDir = getCfg("sessionDir", t.threadId);
    if (!sessionDir) continue;
    const threadFile = path.join(sessionDir, `${t.threadId}.jsonl`);
    if (!fs.existsSync(threadFile)) continue;
    let text = "";
    if (t.type === "summary") text = `📋 待办：月摘要待生成（${t.start} ~ ${t.end}），已满 ${t.totalDays} 天，需要时请调用 summarize 工具。`;
    if (!text) continue;
    const tc = cfg[t.threadId] || {};
    const line = tc.runtime === "codex"
      ? JSON.stringify({ timestamp: now, type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text }] } })
      : JSON.stringify({ type: "system", subtype: "stmem-trigger", timestamp: now, message: { content: text } });
    try { fs.appendFileSync(threadFile, "\n" + line, "utf8"); log(`trigger injected: ${t.type} → ${t.threadId}`); } catch (e) { log(`trigger inject failed: ${e.message}`); }
  }
}

/** 手动检查当前待办 */
function toolTriggersCheck(args) {
  try {
  const cfg = loadConfig();
  if (!cfg) return "未配置 stmem.json";
  const lines = ["📋 系统待办检查", ""];
  let found = false;
  for (const tid of listThreadIds()) {
    const summaryTriggerDays = getCfg("summaryTriggerDays", tid, 60);
    const summaryWindowDays = getCfg("summaryWindowDays", tid, 30);
    const feelDir = path.join(getThreadDir(tid), "memory", "mined", "feelings");
    const daysFile = path.join(feelDir, "days.jsonl");
    const monthsFile = path.join(feelDir, "months.jsonl");
    // 待重建
    const windowDays = getCfg("windowDays", tid, 3);
    let lastArchiveDate = null;
    try {
      const files = fs.readdirSync(path.join(getThreadDir(tid), "memory", "archive")).filter(f => f.endsWith(".jsonl")).sort();
      if (files.length > 0) lastArchiveDate = files.pop().replace(".jsonl", "");
    } catch {}
    if (lastArchiveDate) {
      const d = Math.floor((Date.now() - new Date(lastArchiveDate).getTime()) / 86400000);
      if (d >= windowDays) { lines.push(`1️⃣  线程重建待执行 — ${tid}，上次存档 ${d} 天前，窗口 ${windowDays} 天`); lines.push(`   → stmem_memory_rebuild(thread: "${tid}")`); lines.push(""); found = true; }
    }
    // 待月摘要
    if (!fs.existsSync(daysFile)) continue;
    const uniqueDates = new Set();
    try {
      for (const line of fs.readFileSync(daysFile, "utf8").split("\n").filter(Boolean)) {
        const obj = JSON.parse(line);
        if (obj.type === "feeling") {
          const m = (obj.content || "").match(/^(\d+)月(\d+)日/);
          if (m) uniqueDates.add(feelingDate(m[1], m[2], obj));
        }
      }
    } catch {}
    if (uniqueDates.size < summaryTriggerDays) continue;
    const sorted = [...uniqueDates].sort();
    const start = sorted[0];
    const end = sorted[Math.min(summaryWindowDays - 1, sorted.length - 1)];
    const monthKey = start.slice(0, 7);
    let covered = false;
    try {
      if (fs.existsSync(monthsFile)) for (const line of fs.readFileSync(monthsFile, "utf8").split("\n").filter(Boolean)) {
        const obj = JSON.parse(line);
        if (obj.monthStart && obj.monthStart.startsWith(monthKey)) { covered = true; break; }
      }
    } catch {}
    if (!covered) { lines.push(`2️⃣  月摘要待生成 — ${tid}，${start} ~ ${end}（累计 ${uniqueDates.size} 天，前 ${summaryWindowDays} 天可压缩）`); lines.push(`   → stmem_memory_summarize(thread: "${tid}", date: "${monthKey}")`); lines.push(""); found = true; }
  }
  if (!found) lines.push("暂无待办，一切正常 ✅");
  return lines.join("\n");
  } catch (err) {
    return `待办检查失败: ${err.message}`;
  }
}

/** 读 archive 中指定时间窗口的对话原文 */
function readArchiveWindow(archiveDir, startUtc, endUtc) {
  const msgs = [];
  for (const d of [startUtc.slice(0, 10), endUtc.slice(0, 10)]) {
    const fp = path.join(archiveDir, `${d}.jsonl`);
    if (!fs.existsSync(fp)) continue;
    try {
      for (const line of fs.readFileSync(fp, "utf8").split("\n").filter(Boolean)) {
        const obj = JSON.parse(line);
        if (!obj.timestamp) continue;
        const tMs = new Date(obj.timestamp).getTime();
        if (tMs < new Date(startUtc).getTime() || tMs >= new Date(endUtc).getTime()) continue;
        const label = obj.type === "user" ? (getCfg("user", "") || "用户") : (getCfg("ai", "") || "AI");
        const text = (obj.text || "").replace(/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/gm, "").trim();
        if (text && !text.startsWith("{")) msgs.push(`${label}: ${text}`);
      }
    } catch {}
  }
  return msgs;
}

/** 合成月摘要 — 读某月 feelings + 事件锚点原文 → 调 AI → 写入 months.jsonl */
function toolSummarize(args) {
  try {
    const cfg = loadConfig();
    if (!cfg) return "未配置 stmem.json";
    const tid = (resolveThread(args, cfg) || {}).threadId || args.thread;
    if (!tid) return "请指定线程 ID";
    const dateStr = args.date || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
    const feelDir = path.join(getThreadDir(tid), "memory", "mined", "feelings");
    const daysFile = path.join(feelDir, "days.jsonl");
    const targetFile = path.join(feelDir, "months.jsonl");
    const archiveDir = path.join(getThreadDir(tid), "memory", "archive");
    if (!fs.existsSync(daysFile)) return "没有日摘要数据";
    let rc = { eventAnchors: {} };
    const rcFile = path.join(getThreadDir(tid), "memory", "retain-config.json");
    try { rc = JSON.parse(fs.readFileSync(rcFile, "utf8")); } catch {}
    const eventAnchors = rc.eventAnchors || {};
    const retainIds = new Set(Object.keys(rc.retain || {}));
    const allFeelings = [], anchorFeelings = [];
    const rawLines = fs.readFileSync(daysFile, "utf8").split("\n").filter(Boolean);
    for (let i = 0; i < rawLines.length; i++) {
      try {
        const obj = JSON.parse(rawLines[i]);
        if (obj.type !== "feeling") continue;
        const m = (obj.content || "").match(/^(\d+)月(\d+)日/);
        if (!m || feelingYM(m[1], obj) !== dateStr) continue;
        allFeelings.push(obj);
        if (eventAnchors[obj.id]) anchorFeelings.push({ obj, idx: allFeelings.length - 1 });
      } catch {}
    }
    if (!allFeelings.length) return `${dateStr} 没有日摘要`;
    let anchorContext = "";
    for (const af of anchorFeelings) {
      const parsed = parseFeelingTime(af.obj.content || "");
      if (!parsed || parsed.hour === null) continue;
      const startMs = new Date(feelingToUtc(parsed)).getTime() - 30 * 60 * 1000;
      const startUtc = new Date(startMs).toISOString();
      const ni = af.idx + 1 < allFeelings.length ? af.idx + 1 : null;
      let endUtc;
      if (ni !== null) {
        const np = parseFeelingTime(allFeelings[ni].content || "");
        endUtc = np ? feelingToUtc(np) : new Date(startMs + 6 * 3600000).toISOString();
      } else {
        endUtc = new Date(startMs + 6 * 3600000).toISOString();
      }
      const msgs = readArchiveWindow(archiveDir, startUtc, endUtc);
      const also = retainIds.has(af.obj.id) ? " [同时是原文锚点]" : "";
      anchorContext += `\n--- ${parsed.date} ${af.obj.content.slice(0, 40)}...${also} ---\n${msgs.join("\n")}\n`;
    }
    let opsContent = "";
    try { opsContent = fs.readFileSync(path.join(OPS_DIR, "memory-summary-operations.md"), "utf8"); } catch {}
    const feelingList = allFeelings.map(f => `- ${f.content}`).join("\n");
    const ym = parseInt(dateStr.slice(5, 7));
    const lastDay = new Date(parseInt(dateStr.slice(0, 4)), ym, 0).getDate();
    const prompt = `${opsContent ? opsContent + "\n\n" : ""}## 数据\n时间段：${dateStr}-01 ~ ${dateStr}-${lastDay}\n总计 ${allFeelings.length} 条日摘要\n\n${feelingList}${anchorContext ? `\n\n## ⭐ 事件锚点原文\n以下是为标记为重要事件的对话原文，月摘要中需要展开写：\n${anchorContext}` : ""}\n\n请合成月摘要，输出 JSON。`;
    const result = runSubagent(prompt, { opsFile: path.join(OPS_DIR, "memory-summary-operations.md"), threadId: tid });
    let entry = parseJsonObject(result);
    if (!entry) return `AI 返回无法解析:\n${result.slice(0, 300)}`;
    let seq = 1;
    if (fs.existsSync(targetFile)) for (const line of fs.readFileSync(targetFile, "utf8").split("\n").filter(Boolean)) {
      try { const o = JSON.parse(line); if (typeof o.seq === "number" && o.seq >= seq) seq = o.seq + 1; } catch {}
    }
    entry.seq = seq; entry.type = "feeling_month"; entry.monthStart = `${dateStr}-01`; entry.createdAt = new Date().toISOString();
    fs.appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
    return `✅ 月摘要已写入 months.jsonl（#${seq}，${allFeelings.length} 条 feelings${anchorFeelings.length ? `，${anchorFeelings.length} 个事件锚点已展开` : ""}）`;
  } catch (err) { return `摘要失败: ${err.message}`; }
}

// ── 工具实现 ──

function toolRebuild(args) {
  const cfg = loadConfig();
  if (!cfg) return "未配置 stmem.json";
  const resolved = resolveThread(args, cfg);
  if (!resolved) return "无法确定线程 ID";
  const queue = {
    threadId: resolved.threadId,
    window: args.window || resolved.windowDays,
    requestedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(PENDING_REBUILD_FILE, JSON.stringify(queue, null, 2) + "\n", "utf8");
    return "已插入 rebuild 队列，下次 MCP 服务器启动或 /switch 时自动执行。";
  } catch (err) {
    return `写入队列失败: ${err.message}`;
  }
}

function toolMine(args) {
  const cfg = loadConfig();
  const resolved = resolveThread(args, cfg);
  const tid = resolved?.threadId || args.thread;
  const script = path.join(SCRIPTS_DIR, "stmem-mine.js");
  if (!fs.existsSync(script)) return `找不到 stmem-mine.js`;
  const dateArg = args.date ? ` --date ${args.date}` : "";
  const threadArg = tid ? ` --thread ${tid}` : "";
  try {
    const out = execSync(`${process.execPath} ${script}${dateArg}${threadArg}`, {
      encoding: "utf8", timeout: 600_000, cwd: path.dirname(SCRIPTS_DIR), windowsHide: true,
    });
    return out.trim().slice(-1000) || "挖掘完成";
  } catch (err) {
    return `挖掘失败: ${err.message}`;
  }
}

function toolStatus() {
  try {
  const cfg = loadConfig();
  if (!cfg || listThreadIds().length === 0) return "未配置 stmem.json 或无线程";

  const lines = [];
  for (const tid of listThreadIds()) {
    const dir = getThreadDir(tid);
    let archiveCount = 0, feelingCount = 0, featureCount = 0;
    try {
      archiveCount = fs.readdirSync(path.join(dir, "memory", "archive")).filter(f => f.endsWith(".jsonl")).length;
      const ff = path.join(dir, "memory", "mined", "feelings", "days.jsonl");
      if (fs.existsSync(ff)) feelingCount = fs.readFileSync(ff, "utf8").split("\n").filter(l => {
        try { return JSON.parse(l).type === "feeling"; } catch { return false; }
      }).length;
      const fdir = path.join(dir, "memory", "mined", "features");
      for (const cat of ["eat","body","sleep","work","relation","habit","location","preference","misc"]) {
        const cf = path.join(fdir, `${cat}.jsonl`);
        if (fs.existsSync(cf)) featureCount += fs.readFileSync(cf, "utf8").split("\n").filter(Boolean).length;
      }
    } catch {}

    const label = getCfg("label", tid, tid);
    lines.push(`stmem — ${getCfg("ai", tid)} × ${getCfg("user", tid)}${label !== tid ? ` (${label})` : ""}`);
    lines.push(`线程: ${tid} (${getCfg("runtime", tid)}/${getCfg("purpose", tid)})`);
    lines.push(`archive: ${archiveCount} 天 | feelings: ${feelingCount} | features: ${featureCount}`);
  }
  return lines.join("\n");
  } catch (err) {
    return `状态查询失败: ${err.message}`;
  }
}

function toolMemorySearch(args) {
  try {
    const cfg = loadConfig();
    const resolved = resolveThread(args, cfg);
    const { searchByKeyword } = require("./src/services/memory-keyword-search");
    const result = searchByKeyword(args.query || "", { threadId: resolved?.threadId });
    return typeof result === "string" ? result : result.text || JSON.stringify(result);
  } catch (err) {
    return `搜索失败: ${err.message}`;
  }
}

function toolDeepSearch(args) {
  try {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return "请输入搜索内容。";

  const cfg = loadConfig();
  const resolved = resolveThread(args, cfg);
  const { searchByKeyword, searchArchiveContext } = require("./src/services/memory-keyword-search");

  // 先用 keyword search 找到相关 feelings + archive 上下文
  const kwResult = searchByKeyword(query, { maxResults: 3, threadId: resolved?.threadId });
  const archiveHits = [];
  if (kwResult.hits?.length) {
    for (const hit of kwResult.hits.slice(0, 3)) {
      if (hit.utcTime) {
        const startMs = new Date(hit.utcTime).getTime() - 30 * 60 * 1000;
        const ctx = searchArchiveContext(new Date(startMs).toISOString().slice(0, 10), query.split(/\s+/).filter(w => w.length >= 2), {
          maxDays: 3, mode: "event",
        });
        if (ctx.text) archiveHits.push(ctx.text);
      }
    }
  }

  // 构造 prompt，把搜索结果直接喂给 sub-agent
  const searchContext = [
    kwResult.text ? `## 关键词匹配\n\n${kwResult.text}` : "",
    archiveHits.length ? `## 原文上下文\n\n${archiveHits.slice(0, 2).join("\n\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = searchContext
    ? `你是一个记忆检索助手。以下是关键词搜索结果和相关对话原文，请基于这些信息用第一人称叙事回答用户的查询。\n\n${searchContext}\n\n---\n\n用户查询：${query}`
    : `你是一个记忆检索助手。用户的查询是：${query}`;

  const result = subagentCall(prompt, { threadId: resolved?.threadId });

  // 保存 topic 文件（handler 兜底，存到线程 memory 下）
  try {
    const stopWords = new Set(["小鱼","她","我","的","了","是","在","和","跟","与","有","不","也","都","就","还","要","会","能","去","来","这","那","什么","怎么","为什么","一个","赛博"]);
    const kws = query.split(/[\s，,。！？]+/).filter(w => w.length >= 2 && !stopWords.has(w));
    const mainKw = kws[0] || query.split(/[\s，,。]+/)[0];
    if (mainKw && mainKw.length >= 2 && result && result.length > 200) {
      const tid = resolved?.threadId;
      if (!tid) return;
      const topicDir = path.join(getThreadDir(tid), "memory", "topics");
      const topicFile = path.join(topicDir, `topic_${mainKw}.md`);
      fs.mkdirSync(topicDir, { recursive: true });
      const header = `# ${mainKw}\ncreatedAt: ${new Date().toISOString()}\nupdatedAt: ${new Date().toISOString()}\n\n## 总结\n\n`;
      fs.writeFileSync(topicFile, header + result, "utf8");
      log(`topic saved: ${topicFile}`);
    }
  } catch {}

  return result;
  } catch (err) {
    log(`deep search error: ${err.message}`);
    return `深度搜索失败: ${err.message}`;
  }
}

// ── audit 工具 ──

function auditResolvePaths(args) {
  const cfg = loadConfig();
  const resolved = resolveThread(args, cfg);
  const tid = resolved?.threadId || args.thread;
  if (!tid) throw new Error("无法确定线程 ID");
  const dir = getThreadDir(tid);
  const feelDir = path.join(dir, "memory", "mined", "feelings");
  return {
    threadId: tid,
    feelingsFile: path.join(feelDir, "days.jsonl"),
    auditMarksFile: path.join(dir, "memory", "audit-marks.json"),
    retainConfigFile: path.join(dir, "memory", "retain-config.json"),
  };
}

function auditLoadMarks(p) {
  try { return JSON.parse(fs.readFileSync(p.auditMarksFile, "utf8")); }
  catch { return { lastCutoffDate: new Date().getFullYear() + "-01-01", retainMarks: {} }; }
}

function auditSaveMarks(p, data) {
  fs.writeFileSync(p.auditMarksFile, JSON.stringify(data, null, 2), "utf8");
}

function toolAuditList(args) {
  try {
    const p = auditResolvePaths(args);
    const marks = auditLoadMarks(p);
    const lastCutoff = marks.lastCutoffDate || `${new Date().getFullYear()}-01-01`;
    const entries = readFeelings(p.feelingsFile);
    let rc = { retain: {}, eventAnchors: {} };
    try { rc = JSON.parse(fs.readFileSync(p.retainConfigFile, "utf8")); } catch {}
    const retainIds = new Set(Object.keys(rc.retain || {}));
    const eventIds = new Set(Object.keys(rc.eventAnchors || {}));
    const byDate = {};
    for (const e of entries) {
      const m = (e.content || "").match(/^(\d+)月(\d+)日/);
      const dateKey = m ? feelingDate(m[1], m[2], e) : "unknown";
      if (dateKey <= lastCutoff) continue;
      if (!byDate[dateKey]) byDate[dateKey] = [];
      let tag = "";
      const isR = retainIds.has(e.id), isE = eventIds.has(e.id);
      if (isR && isE) tag = "[原文+事件]";
      else if (isR) tag = "[原文]";
      else if (isE) tag = "[事件]";
      byDate[dateKey].push({ seq: e.seq, id: e.id, content: e.content, tag });
    }
    const unreviewed = Object.keys(byDate).sort();
    if (unreviewed.length === 0) return `截止 ${lastCutoff}，全部已审。`;

    const preamble = [
      "睡前记忆巡检。以下是上次审计之后的新摘要。",
      "",
      "每条看一遍。两种锚点：",
      "  type: retain → 原文锚点，这句对话不能丢，rebuild 时保留原文",
      "  type: event → 事件锚点，这件事在月摘要里要重点写，不占窗口上下文",
      "  已在行的标注 [原文] [事件] 或 [原文+事件]",
      "",
      "不用每条都标。只标真正重要的。",
      "",
      `截止: ${lastCutoff}，${unreviewed.length} 条未审`,
      "",
    ].join("\n");
    const lines = [preamble, "| # | 日期 | 类型 | 摘要 |", "|---|------|------|------|"];
    for (const d of unreviewed) {
      for (const f of byDate[d]) {
        lines.push(`| ${f.seq || "?"} | ${d} | ${f.tag || ""} | ${f.content.slice(0, 70)}... |`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `audit_list 失败: ${err.message}`;
  }
}

function toolAuditMark(args) {
  try {
    const p = auditResolvePaths(args);
    const marks = auditLoadMarks(p);
    const cutoffDate = (args.cutoffDate || "").trim();
    const numbers = Array.isArray(args.numbers) ? args.numbers.filter(n => Number.isInteger(n)) : [];
    const anchorType = args.type === "event" ? "event" : "retain";
    if (cutoffDate && cutoffDate > (marks.lastCutoffDate || "")) marks.lastCutoffDate = cutoffDate;

    const entries = readFeelings(p.feelingsFile);
    const seqToId = {};
    for (const e of entries) { if (typeof e.seq === "number") seqToId[e.seq] = e.id; }
    const feelingIds = numbers.map(n => seqToId[n]).filter(Boolean);
    for (const id of feelingIds) marks.retainMarks[id] = true;
    auditSaveMarks(p, marks);

    if (feelingIds.length > 0) {
      try {
        const rc = JSON.parse(fs.readFileSync(p.retainConfigFile, "utf8"));
        if (anchorType === "event") {
          rc.eventAnchors = rc.eventAnchors || {};
          for (const id of feelingIds) rc.eventAnchors[id] = { createdAt: new Date().toISOString() };
        } else {
          rc.retain = rc.retain || {};
          for (const id of feelingIds) rc.retain[id] = { anchor: false };
        }
        fs.writeFileSync(p.retainConfigFile, JSON.stringify(rc, null, 2), "utf8");
      } catch {}
    }
    const label = anchorType === "event" ? "事件锚点" : "原文锚点";
    return `截止 ${cutoffDate}，标记${label} #${numbers.join(", #")}`;
  } catch (err) {
    return `audit_mark 失败: ${err.message}`;
  }
}

function toolAuditQuery(args) {
  try {
    const p = auditResolvePaths(args);
    const date = (args.date || "").trim();
    const keyword = (args.keyword || "").trim().toLowerCase();
    if (!date && !keyword) return "请提供 date 或 keyword。";
    let rc = { retain: {}, eventAnchors: {} };
    try { rc = JSON.parse(fs.readFileSync(p.retainConfigFile, "utf8")); } catch {}
    const retainIds = new Set(Object.keys(rc.retain || {}));
    const eventIds = new Set(Object.keys(rc.eventAnchors || {}));
    const all = readFeelings(p.feelingsFile);
    let results = all;
    if (date) {
      results = results.filter(f => {
        const m = (f.content || "").match(/^(\d+)月(\d+)日/);
        return m && feelingDate(m[1], m[2], f) === date;
      });
    }
    if (keyword) results = results.filter(f => (f.content || "").toLowerCase().includes(keyword));
    if (results.length === 0) return "未找到匹配的记忆。";
    const lines = [`找到 ${results.length} 条：`, ""];
    results.forEach(f => {
      let tag = "";
      const isR = retainIds.has(f.id), isE = eventIds.has(f.id);
      if (isR && isE) tag = " [原文+事件锚点]";
      else if (isR) tag = " [原文锚点]";
      else if (isE) tag = " [事件锚点]";
      lines.push(`### #${f.seq || "?"}${tag}`);
      lines.push(f.content);
      lines.push("");
    });
    return lines.join("\n");
  } catch (err) {
    return `audit_query 失败: ${err.message}`;
  }
}

// ── 工具注册 ──

const TOOLS = [
  {
    name: "stmem_memory_rebuild",
    description: "Queue a thread rebuild: writes a pending-rebuild marker to disk. The rebuild will run automatically the next time MCP server starts or /switch triggers it. This avoids UUID chain breaks that happen when the file is replaced mid-session.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID，默认自动检测当前 session" },
        window: { type: "number", description: "窗口天数，默认 stmem.json 的 windowDays" },
        toolPairs: { type: "number", description: "保留最近 N 对工具链调用，默认 40" },
      },
    },
  },
  {
    name: "stmem_memory_mine",
    description: "手动触发单日记忆挖掘（feelings + features 双通道）",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: "日期 YYYY-MM-DD，默认昨天" } },
    },
  },
  {
    name: "stmem_memory_status",
    description: "查看 stmem 记忆系统当前状态",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stmem_memory_search",
    description: "关键词搜索记忆 feelings + 回溯原文 archive",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "搜索关键词" } },
      required: ["query"],
    },
  },
  {
    name: "stmem_memory_deep_search",
    description: "深度记忆检索（子 agent 多级搜索 + 原文回溯）",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "搜索内容（自然语言）" } },
      required: ["query"],
    },
  },
  {
    name: "stmem_memory_audit_list",
    description: "List feelings from dates after the last audit cutoff. Shows feeling IDs and anchor type for marking.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
    },
  },
  {
    name: "stmem_memory_audit_mark",
    description: "Mark feelings by seq number with anchor type. Input: { cutoffDate, numbers, type }",
    inputSchema: {
      type: "object",
      required: ["cutoffDate"],
      properties: {
        cutoffDate: { type: "string", description: "Audit cutoff date (YYYY-MM-DD)." },
        numbers: { type: "array", items: { type: "integer" }, description: "Seq numbers to mark, e.g. [1, 3, 5]." },
        type: { type: "string", description: "锚点类型。'retain' = 原文锚点（保留对话原文，默认），'event' = 事件锚点（标注重要事件，用于月摘要）" },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
    },
  },
  {
    name: "stmem_memory_audit_query",
    description: "Query feelings by date or keyword. Returns full content with anchor type. Input: { date?, keyword? }",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date YYYY-MM-DD, e.g. '2026-06-05'." },
        keyword: { type: "string", description: "Keyword to search in feeling content." },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
    },
  },
  {
    name: "stmem_memory_summarize",
    description: "合成月摘要：读指定月的 feelings + 事件锚点原文 → 调 AI → 写入 months.jsonl。压缩后的月摘要会被 rebuild 自动使用，替换单日 feelings。",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID，默认自动检测" },
        date: { type: "string", description: "月份 YYYY-MM，默认当前月" },
      },
    },
  },
  {
    name: "stmem_memory_triggers_check",
    description: "检查当前待办事项（重建、月摘要），返回自然语言列表。适合在会话启动或睡前巡检时调用。",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── MCP 协议（支持 Content-Length + newline JSON 双模式） ──

let rpcMode = "content-length";
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
  while (true) {
    // 优先解析 Content-Length 头（标准 MCP stdio 协议）
    const clMatch = data.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/);
    if (clMatch) {
      rpcMode = "content-length";

      const len = parseInt(clMatch[1], 10);
      const hdrEnd = clMatch[0].length;
      if (data.length < hdrEnd + len) break;
      try { handle(JSON.parse(data.slice(hdrEnd, hdrEnd + len))); } catch {}
      data = data.slice(hdrEnd + len);
      continue;
    }
    // fallback: newline-delimited JSON
    const nlIdx = data.indexOf("\n");
    if (nlIdx >= 0) {
      const line = data.slice(0, nlIdx).trim();
      data = data.slice(nlIdx + 1);
      if (line) {
        rpcMode = "jsonl";
        try { handle(JSON.parse(line)); } catch {}
      }
      continue;
    }
    break;
  }
});

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stmem-mcp", version: "2.0.0" } });
  } else if (method === "tools/list") {
    respond(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const { name, arguments: args = {} } = params || {};
    let text;
    try {
      if (name === "stmem_memory_rebuild") text = toolRebuild(args);
      else if (name === "stmem_memory_mine") text = toolMine(args);
      else if (name === "stmem_memory_status") text = toolStatus();
      else if (name === "stmem_memory_search") text = toolMemorySearch(args);
      else if (name === "stmem_memory_deep_search") text = toolDeepSearch(args);
      else if (name === "stmem_memory_audit_list") text = toolAuditList(args);
      else if (name === "stmem_memory_audit_mark") text = toolAuditMark(args);
      else if (name === "stmem_memory_audit_query") text = toolAuditQuery(args);
      else if (name === "stmem_memory_summarize") text = toolSummarize(args);
      else if (name === "stmem_memory_triggers_check") text = toolTriggersCheck(args);
      else text = `未知工具: ${name}`;
    } catch (err) {
      text = `工具执行错误: ${err.message}`;
    }
    respond(id, { content: [{ type: "text", text }] });
  } else if (id !== undefined && id !== null) {
    respond(id, {});
  }
}
