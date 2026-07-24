#!/usr/bin/env node
/**
 * STMEM MCP Server — stdio JSON-RPC
 *
 * 工具: stmem_memory_rebuild, _mine, _status, _search, _deep_search,
 *       _audit_list, _audit_mark, _audit_query, _triggers_check
 * 订阅用户无 API key 时自动用 claude -p（OAuth token）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { getCfg, getThreadDir, listThreadIds } = require("./src/config");
const { runSubagent } = require("./src/services/subagent-runner");
const { parseJsonArray } = require("./src/lib/json-parse");
const { readFeelings: readDatabaseFeelings, readFeatures: readDatabaseFeatures } = require("./src/storage/memory-reader");
const { MemoryStore } = require("./src/storage/memory-store");
const { resolveMcpThread } = require("./src/services/mcp-thread-resolution");

const CONFIG_PATH = path.join(os.homedir(), ".stone_memory", "stmem.json");
const PROJECT_ROOT = path.resolve(__dirname);
const SCRIPTS_DIR = path.join(PROJECT_ROOT, "scripts");
const LOG_FILE = path.join(os.homedir(), ".stone_memory", "logs", "mcp.log");
const PENDING_REBUILD_FILE = path.join(os.homedir(), ".stone_memory", "rebuild-pending.json");

/** 获取 feeling 的完整日期字符串，优先从 createdAt 取年份，无 createdAt 时从月份推断（跨年保护） */
function feelingDate(month, day, feeling) {
  let year;
  if (feeling && feeling.createdAt) { const y = new Date(feeling.createdAt).getFullYear(); if (!isNaN(y)) year = y; }
  if (!year) { const now = new Date(); year = parseInt(month) > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear(); }
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
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
  const config = cfg || {};
  const sessionId = resolveMcpThread(args, config, listThreadIds());
  const tc = config[sessionId] || {};
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
  // 待重建 — 直接执行，不注入文本提醒
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
        const rebuildArgs = [script, "--thread", threadId, "--apply"];
        if (queue.window) rebuildArgs.push("--window", String(queue.window));
        log(`pending rebuild: ${script} (${rebuildArgs.length - 1} args)`);
        try {
          execFileSync(process.execPath, rebuildArgs, { encoding: "utf8", timeout: 120000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
          log(`pending rebuild done: ${threadId}`);
        } catch (e) {
          log(`pending rebuild failed: ${e.stderr || e.message}`);
        }
      }
    } catch {}
    try { fs.unlinkSync(PENDING_REBUILD_FILE); } catch {}
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
    const memoryDir = path.join(getThreadDir(tid), "memory");
    const store = new MemoryStore({ memoryDir, threadId: tid });
    try {
      const blockedDays = store.listDayStates().filter(row => row.status === "blocked").map(row => ({
        date: row.source_date, attempt: row.attempt, errorCode: row.error_code, errorMessage: row.error_message,
      }));
      for (const blocked of blockedDays) {
        lines.push(`🚨 挖掘已阻塞 — ${tid} / ${blocked.date}（连续失败 ${blocked.attempt} 次）`);
        lines.push(`   ${blocked.errorCode || "MINING_FAILED"}: ${blocked.errorMessage || "未知错误"}`);
        lines.push(`   → 修复后手动执行 stmem mine --thread ${tid} --date ${blocked.date}`);
        lines.push("");
        found = true;
      }
    } finally { store.close(); }
    // 待重建
    const windowDays = getCfg("windowDays", tid, 3);
    let lastArchiveDate = null;
    try {
      const files = new MemoryStore({ memoryDir, threadId: tid });
      const dates = files.listMessageDates();
      files.close();
      if (dates.length > 0) lastArchiveDate = dates.pop();
    } catch {}
    if (lastArchiveDate) {
      const d = Math.floor((Date.now() - new Date(lastArchiveDate).getTime()) / 86400000);
      if (d >= windowDays) { lines.push(`1️⃣  线程重建待执行 — ${tid}，上次存档 ${d} 天前，窗口 ${windowDays} 天`); lines.push(`   → stmem_memory_rebuild(thread: "${tid}")`); lines.push(""); found = true; }
    }
  }
  if (!found) lines.push("暂无待办，一切正常 ✅");
  return lines.join("\n");
  } catch (err) {
    return `待办检查失败: ${err.message}`;
  }
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
  const mineArgs = [script];
  if (args.date) mineArgs.push("--date", String(args.date));
  if (tid) mineArgs.push("--thread", String(tid));
  if (args.force) mineArgs.push("--force");
  try {
    const out = execFileSync(process.execPath, mineArgs, {
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
    let archiveCount = 0, feelingCount = 0, featureCount = 0, blockedCount = 0;
    try {
      const memoryDir = path.join(dir, "memory");
      const store = new MemoryStore({ memoryDir, threadId: tid });
      archiveCount = store.listMessageDates().length;
      feelingCount = store.listFeelings().length;
      featureCount = store.listFeatures().length;
      blockedCount = store.listDayStates().filter(row => row.status === "blocked").length;
      store.close();
    } catch {}

    const label = getCfg("label", tid, tid);
    lines.push(`stmem — ${getCfg("ai", tid)} × ${getCfg("user", tid)}${label !== tid ? ` (${label})` : ""}`);
    lines.push(`线程: ${tid} (${getCfg("runtime", tid)}/${getCfg("purpose", tid)})`);
    lines.push(`archive: ${archiveCount} 天 | feelings: ${feelingCount} | features: ${featureCount}`);
    if (blockedCount) lines.push(`⚠️ 挖掘阻塞: ${blockedCount} 天（请调用 stmem_memory_triggers_check 查看）`);
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
        const startMs = new Date(hit.utcTime).getTime() - 5 * 60 * 1000;
        const ctx = searchArchiveContext(new Date(startMs).toISOString().slice(0, 10), query.split(/\s+/).filter(w => w.length >= 2), {
          maxDays: 3, mode: "event", threadId: resolved?.threadId,
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
  return {
    threadId: tid,
    memoryDir: path.join(dir, "memory"),
    auditMarksFile: path.join(dir, "memory", "audit-marks.json"),
    retainConfigFile: path.join(dir, "memory", "retain-config.json"),
  };
}

function auditReadFeelings(p) {
  return readDatabaseFeelings(p.memoryDir, { threadId: p.threadId });
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
    const entries = auditReadFeelings(p);
    let rc = { retain: {}, eventAnchors: {} };
    try { rc = JSON.parse(fs.readFileSync(p.retainConfigFile, "utf8")); } catch {}
    const retainIds = new Set(Object.keys(rc.retain || {}));
    const eventIds = new Set(Object.keys(rc.eventAnchors || {}));
    const byDate = {};
    for (const e of entries) {
      const m = (e.content || "").match(/^(\d+)月(\d+)日/);
      const dateKey = e.sourceDate || (m ? feelingDate(m[1], m[2], e) : "unknown");
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
      "  type: event → 事件锚点，标记长期关键事件，供生命周期保护和巡检使用",
      "  已标记的条目显示 [原文]、[事件] 或 [原文+事件]",
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

    const entries = auditReadFeelings(p);
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
    const all = auditReadFeelings(p);
    let results = all;
    if (date) {
      results = results.filter(f => {
        const m = (f.content || "").match(/^(\d+)月(\d+)日/);
        return f.sourceDate === date || (m && feelingDate(m[1], m[2], f) === date);
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
      properties: {
        date: { type: "string", description: "日期 YYYY-MM-DD，默认昨天" },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
        force: { type: "boolean", description: "整日重挖；成功后直接替换当天结果，失败保留旧结果" },
      },
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
      properties: {
        query: { type: "string", description: "搜索关键词" },
        thread: { type: "string", description: "线程 ID；多记忆体环境必须显式绑定或设置 STMEM_THREAD_ID" },
      },
      required: ["query"],
    },
  },
  {
    name: "stmem_memory_deep_search",
    description: "深度记忆检索（子 agent 多级搜索 + 原文回溯）",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索内容（自然语言）" },
        thread: { type: "string", description: "线程 ID；多记忆体环境必须显式绑定或设置 STMEM_THREAD_ID" },
      },
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
    description: "Mark feelings by seq number as original-text or key-event anchors. Input: { cutoffDate, numbers, type }",
    inputSchema: {
      type: "object",
      required: ["cutoffDate"],
      properties: {
        cutoffDate: { type: "string", description: "Audit cutoff date (YYYY-MM-DD)." },
        numbers: { type: "array", items: { type: "integer" }, description: "Seq numbers to mark, e.g. [1, 3, 5]." },
        type: { type: "string", enum: ["retain", "event"], description: "'retain' 保留对应原文；'event' 标记长期关键事件，供生命周期保护和巡检使用。默认 retain。" },
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
    name: "stmem_memory_triggers_check",
    description: "检查当前待办事项（重建、挖掘阻塞），返回自然语言列表。适合在会话启动或睡前巡检时调用。",
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
