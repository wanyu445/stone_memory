#!/usr/bin/env node
/**
 * 线程重建脚本 v4 — 滚动窗口
 *
 * 策略:
 *   近 N 天: 对话 + 思考链全保留 (去工具链/轮询)
 *   N 天前:  全部 feelings → memory_context 块
 *   全量 UUID 重建，保持连贯性
 *
 * 用法:
 *   node scripts/rebuild-thread.js --dry-run          # 预览
 *   node scripts/rebuild-thread.js --apply            # 写入
 *   node scripts/rebuild-thread.js --window 7         # 自定义窗口(天)
 *   node scripts/rebuild-thread.js --thread <id>      # 指定线程
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const { FullArchive, dateKeyFromTs } = require("../src/services/memory-archive");
const { getCfg, getThreadDir } = require("../src/config");
const { resolveDateFile, listDateFiles } = require("../src/lib/archive-paths");
const { readFeelings: readDatabaseFeelings, readMessages } = require("../src/storage/memory-reader");
const { itemKey, conversationWindow, loadRebuildPlan } = require("../src/services/rebuild-workbench");

let THREAD_BASE = null;
let FULL_ARCHIVE = null;
let SESSION_DIR = null;
let RETAIN_CONFIG_FILE = null;
let ARCHIVE_DIR = null;
let RULES_DIR = null;
let DEFAULT_WINDOW_DAYS = 3;
let currentThreadId = null;

function initThreadPaths(threadId) {
  if (currentThreadId === threadId && THREAD_BASE) return;
  currentThreadId = threadId;
  THREAD_BASE = getThreadDir(threadId);
  FULL_ARCHIVE = new FullArchive(path.join(THREAD_BASE, "memory"));
  SESSION_DIR = getCfg("sessionDir", threadId);
  if (!SESSION_DIR) throw new Error("请在 stmem.json 中配置 sessionDir");
  RETAIN_CONFIG_FILE = path.join(THREAD_BASE, "memory", "retain-config.json");
  ARCHIVE_DIR = path.join(THREAD_BASE, "memory", "archive");
  RULES_DIR = path.join(THREAD_BASE, "rules");
  DEFAULT_WINDOW_DAYS = getCfg("windowDays", threadId, 3);
}
const { automaticRetainWindow, buildMemoryBlocks, resolveLatestFeelingWatermark } = require("../src/services/thread-rebuilder");

function loadRetainConfig() {
  try {
    const raw = fs.readFileSync(RETAIN_CONFIG_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { retain: {} };
  }
}

// ---- 工具 ----

function newUuid() {
  return crypto.randomUUID();
}



// ---- 中文数字解析 ----

function cn2int(s) {
  if (!s) return null;
  const d = { 零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,两:2 };
  s = s.replace(/[分秒]$/, "");
  if (s === "半") return 30;
  let m = s.match(/^([零一二三四五六七八九两])?十([零一二三四五六七八九两])?$/);
  if (m) return (m[1] ? d[m[1]] : 1) * 10 + (m[2] ? d[m[2]] : 0);
  m = s.match(/^([零一二三四五六七八九两])$/);
  if (m) return d[m[1]];
  m = s.match(/^(\d+)/);
  if (m) return parseInt(m[1]);
  return null;
}

function parseFeelingTime(content) {
  const dm = content.match(/^(\d+)月(\d+)日/);
  if (!dm) return null;
  const cy = new Date().getFullYear(); const cm = new Date().getMonth() + 1;
  const year = parseInt(dm[1]) > cm + 1 ? cy - 1 : cy;
  const date = `${year}-${dm[1].padStart(2, "0")}-${dm[2].padStart(2, "0")}`;
  const afterDate = content.slice(content.indexOf("日") + 1);
  const timeDesc = afterDate.split(/[。.]/).filter(Boolean)[0]?.replace(/^[，,]\s*/, "").trim() || "";

  const periods = [
    [/^凌晨/, 0], [/^通宵/, 0], [/^半夜/, 0], [/^午夜/, 0], [/^将近午夜/, 0],
    [/^早上/, 0], [/^上午/, 0], [/^中午/, 0],
    [/^下午/, 12], [/^傍晚/, 12], [/^晚上/, 12], [/^深夜/, 12],
  ];
  let periodOffset = 0, periodName = "";
  for (const [re, off] of periods) {
    if (re.test(timeDesc)) { periodOffset = off; periodName = re.source.slice(1); break; }
  }

  let hour = null, minute = 0;
  const dotIdx = timeDesc.indexOf("点");
  if (dotIdx > 0) {
    let hStart = dotIdx - 1;
    while (hStart >= 0 && /[零一二三四五六七八九两十\d]/.test(timeDesc[hStart])) hStart--;
    hStart++;
    hour = cn2int(timeDesc.slice(hStart, dotIdx));
    const after = timeDesc.slice(dotIdx + 1);
    if (after.startsWith("半")) minute = 30;
    else if (after && after[0] !== "多") {
      const m = cn2int(after);
      if (m !== null && m < 60) minute = m;
    }
  }

  if (hour !== null) {
    if (periodName === "中午" && hour === 12) hour = 12;
    else if (periodName === "深夜" && hour === 12) hour = 0;
    else if (periodName === "深夜" && hour <= 5) hour = hour;
    else if (periodOffset === 12 && hour === 12) hour = 0;
    else if (periodOffset === 12) hour += 12;
  } else {
    const defs = { 凌晨:2,通宵:4,半夜:0,午夜:0,将近午夜:23,早上:8,上午:10,中午:12,下午:15,傍晚:18,晚上:20,深夜:23 };
    for (const [k, v] of Object.entries(defs)) if (timeDesc.includes(k)) { hour = v; break; }
  }
  if (hour !== null && hour >= 24) hour -= 24;
  return { date, timeDesc, hour, minute };
}

function feelingToUtc(f) {
  if (f.hour === null || f.hour === undefined) return null;
  const bjMs = new Date(`${f.date}T00:00:00.000+08:00`).getTime()
    + f.hour * 3600000 + (f.minute || 0) * 60000;
  return new Date(bjMs).toISOString();
}

// ---- Feelings ----

/** 从 SQLite 加载当前可注入的 daily/coarse feelings；hidden 由 reader 过滤。 */
function loadInjectableFeelings() {
  const daysRaw = readDatabaseFeelings(path.join(THREAD_BASE, "memory"), { threadId: currentThreadId, forInjection: true });
  const feelings = [];
  for (const r of daysRaw) {
    const content = (r.content || "").trim();
    if (!content) continue;
    const time = parseFeelingTime(content);
    if (!time?.date) continue;
    feelings.push({ id: r.id, content, date: time.date, hour: time.hour, minute: time.minute, utcTime: feelingToUtc(time), retainOriginal: false });
  }
  return feelings;
}

// ---- 全量备份 ----

/** 从 full/ 读取全部消息（按文件名排序，即北京日期顺序） */
function loadFullMessages() {
  const fullDir = FULL_ARCHIVE.fullDir;
  const all = [];
  let skipped = 0;
  try {
    const files = listDateFiles(fullDir);
    for (const { file } of files) {
      const raw = fs.readFileSync(file, "utf8");
      for (const line of raw.split("\n").filter(Boolean)) {
        try { all.push(JSON.parse(line)); } catch { skipped++; }
      }
    }
  } catch (err) {
    console.error(`[rebuild] full/ load error: ${err.message}`);
  }
  // full 是按天增量追加的原始备份；迟到记录和 rebuild 前补扫会写在文件末尾，
  // 文件物理顺序不等于真实对话顺序。稳定按时间戳排序后再重建。
  all.sort((a, b) => {
    const left = new Date(a.timestamp || "").getTime();
    const right = new Date(b.timestamp || "").getTime();
    if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return left - right;
  });
  if (skipped > 0) console.warn(`[rebuild]   ⚠️ ${skipped} corrupted lines skipped in full/ archive`);
  return all;
}

function backupNewToFull(messages) {
  return FULL_ARCHIVE.archiveNewFullBatch(messages);
}

// ---- 过滤 ----

function msgDate(msg) {
  return dateKeyFromTs(msg.timestamp);
}

function extractRealBlocks(msg) {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b.type === "text" || b.type === "thinking");
}

/** 将文本中的变量部分泛化为占位符（时间、数字、UUID、URL），暴露模板骨架用于去重 */
function templateFingerprint(text) {
  if (!text) return "";
  return text.split("\n").map(line =>
    line
      .replace(/\[\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2}(:\d{2})?\]/g, "[DATE]")
      .replace(/\d{4}-\d{2}-\d{2}/g, "DATE")
      .replace(/\d{2}:\d{2}(:\d{2})?/g, "TIME")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "UUID")
      .replace(/\b\d+(\.\d+)?\b/g, "N")
      .replace(/https?:\/\/\S+/g, "URL")
      .trim()
  ).join("\n");
}

function isSystemInjection(text) {
  if (!text) return false;
  const t = templateFingerprint(text);
  return /<memory_context>|Relevant past memories:|Continue from where you left off\.|Review the current code changes/i.test(t);
}

function isSystemAssistantText(text) {
  if (!text) return false;
  return /^\{"action":"silent"\}$/.test(text.trim()) ||
    /^\{"action":"send_message"/.test(text.trim()) ||
    /^API Error:/.test(text.trim()) ||
    /^No response requested\.?$/.test(text.trim());
}

// ---- 记忆块 (buildMemoryBlocks 从 thread-rebuilder 导入) ----

// ---- 消息输出 ----

/** 输出单条消息 (去工具链/系统注入) — 复用于片段和窗口 */
function outputCleanMessage(msg, emitFn, stats, preservedToolIds = new Set()) {
  if (msg.type !== "user" && msg.type !== "assistant") return;
  let content = msg.message?.content;

  if (msg.type === "user") {
    if (typeof content === "string") {
      // 跳过旧规则注入（会被 rules/ 重新注入）
      if (content.includes("<!-- stmem-rule:")) { stats.systemDropped++; return; }
      if (isSystemInjection(content)) { stats.systemDropped++; return; }
      if (!content.trim()) return;
      if (emitFn("user", content, { timestamp: msg.timestamp })) stats.windowMsg++;
    } else if (Array.isArray(content)) {
      const textBlocks = content.filter((b) => b.type === "text");
      const toolBlocks = content.filter((b) => b.type === "tool_result");
      if (textBlocks.length === 0 && toolBlocks.length === 0) return;
      // 保留被标记的工具链（成对的 tool_result）
      const keepToolResults = toolBlocks.filter(b => preservedToolIds.has(b.tool_use_id));
      const emitBlocks = [...textBlocks, ...keepToolResults];
      if (emitBlocks.length === 0) return;
      const cleanBlocks = emitBlocks.filter(b => b.type !== "text" || !isSystemInjection(b.text || ""));
      if (cleanBlocks.length === 0) return;
      if (emitFn("user", cleanBlocks, { timestamp: msg.timestamp })) stats.windowMsg++;
      if (toolBlocks.length - keepToolResults.length > 0) stats.systemDropped += toolBlocks.length - keepToolResults.length;
    }
  } else if (msg.type === "assistant") {
    // 片段消息从 archive 来是纯文本字符串，窗口消息是 content blocks 数组
    if (typeof content === "string") {
      const text = content.trim();
      if (!text || text.startsWith("{\"action\":\"silent\"}")) return;
      if (emitFn("assistant", [{ type: "text", text }], { timestamp: msg.timestamp })) stats.windowMsg++;
      return;
    }
    if (!Array.isArray(content)) return;

    // 逐块过滤: tool_use 未标记 → 丢弃, system text 丢弃, text/thinking 保留
    const clean = [];
    let droppedTool = 0;
    for (const b of content) {
      if (b.type === "tool_use") {
        if (preservedToolIds.has(b.id)) { clean.push(b); } else { droppedTool++; }
        continue;
      }
      if (b.type === "text" && isSystemAssistantText(b.text || "")) { continue; }
      if (b.type === "text" || b.type === "thinking") {
        clean.push(b);
      }
    }
    if (droppedTool > 0) stats.systemDropped += droppedTool;
    if (clean.length === 0) return;
    const emitted = emitFn("assistant", clean, {
      timestamp: msg.timestamp,
      model: msg.message?.model,
      stop_reason: msg.message?.stop_reason,
    });
    if (emitted) stats.windowMsg++;
  }
}

// ---- 主流程 ----

function rebuildThread(inputPath, outputPath, dryRun, windowDays, toolPairsOverride = null, plan = loadRebuildPlan(), watermarkMode = false) {
  // === 加载 ===
  console.log("[rebuild] Loading injectable feelings (daily/coarse; hidden excluded)...");
  const allFeelings = loadInjectableFeelings();
  console.log(`[rebuild]   ${allFeelings.length} feelings`);

  // === 先增量备份当前线程到 full/ ===
  console.log("[rebuild] Backing up current thread to full/...");
  let currentMessages = [];
  let currentSkipped = 0;
  if (fs.existsSync(inputPath)) {
    const threadRaw = fs.readFileSync(inputPath, "utf8");
    for (const line of threadRaw.split("\n")) {
      if (!line.trim()) continue;
      try { currentMessages.push(JSON.parse(line)); } catch { currentSkipped++; }
    }
  }
  if (currentSkipped > 0) console.warn(`[rebuild]   ⚠️ ${currentSkipped} corrupted lines skipped in source`);
  const backed = backupNewToFull(currentMessages);
  if (backed > 0) console.log(`[rebuild]   full backup: ${backed} new messages`);

  // === 从 full/ 读取全量消息作为重建源 ===
  console.log("[rebuild] Loading full messages...");
  const messages = loadFullMessages();
  console.log(`[rebuild]   ${messages.length} messages from full`);

  // === 计算滚动窗口 ===
  const fallbackWindow = conversationWindow(messages, "claude", windowDays);
  const watermark = watermarkMode
    ? resolveLatestFeelingWatermark(path.join(THREAD_BASE, "memory"), currentThreadId, messages)
    : null;
  const cutoffUtc = watermark?.cutoffUtc || null;
  const cutoffDate = cutoffUtc ? dateKeyFromTs(cutoffUtc) : fallbackWindow.cutoff;
  const isWindowMessage = msg => cutoffUtc
    ? new Date(msg?.timestamp || "").getTime() >= new Date(cutoffUtc).getTime()
    : msgDate(msg) >= cutoffDate;
  console.log(watermark
    ? `[rebuild] Retention mode: watermark (feeling ${watermark.feelingId}, since ${cutoffUtc})`
    : `[rebuild] Retention mode: active-days${watermarkMode ? " (watermark unavailable)" : ""}`);

  // === 保留工具调用对 (tool_use + tool_result)，遇到窗口外上下文截断 ===
  const preservedToolIds = new Set();
  const keepPairs = toolPairsOverride ?? getCfg("keepToolPairs", currentThreadId, 30);
  let pairCount = 0;
  for (let i = messages.length - 1; i >= 0 && pairCount < keepPairs; i--) {
    const msg = messages[i];
    if (msg.type !== "user" && msg.type !== "assistant") continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    const toolUses = content.filter(b => b.type === "tool_use");
    if (toolUses.length === 0) continue;

    // 该工具对的日期已滚出窗口 → 上下文变摘要，截断
    const date = msgDate(msg);
    if (!isWindowMessage(msg)) {
      console.log(`[rebuild]   tool chain: first pre-window pair at date=${date}, stop at ${pairCount} pairs`);
      break;
    }

    for (const tu of toolUses) {
      if (pairCount >= keepPairs) break;
      pairCount++;
      preservedToolIds.add(tu.id);
    }
    for (const b of content) {
      if (b.type === "tool_result" && b.tool_use_id && preservedToolIds.has(b.tool_use_id)) {
        preservedToolIds.add(b.tool_use_id);
      }
    }
  }
  for (const id of plan.excludedTools) preservedToolIds.delete(id);
  console.log(`[rebuild] Window: ${windowDays} days (cutoff: ${cutoffDate}), tool chains: ${pairCount} pairs, ${preservedToolIds.size} tool IDs`);

  // 按 cutoff 分 feelings
  const preWindow = [];
  const inWindow = [];
  for (const f of allFeelings) {
    if (watermark) {
      if (f.id === watermark.feelingId) inWindow.push(f);
      else preWindow.push(f);
    } else if (f.date < cutoffDate) preWindow.push(f);
    else inWindow.push(f);
  }
  console.log(`[rebuild]   ${preWindow.length} pre-window, ${inWindow.length} in-window`);

  // === 片段提取 (从 retain-config.json 读取) ===
  const retainConfig = loadRetainConfig();
  const retainMap = retainConfig.retain || {};

  // 标记哪些 feelings 需要保留原文 (按 feeling.id 匹配)
  for (const f of preWindow) {
    if (retainMap[f.id]) f.retainOriginal = true;
  }
  const retainFeelings = preWindow.filter((f) => f.retainOriginal);
  const retainIds = new Set(retainFeelings.map((f) => f.id));

  // 构建片段窗口: 优先使用 config 中的 startUtc/endUtc, 否则自动计算
  const fragmentWindows = [];
  for (const f of retainFeelings) {
    const cfg = retainMap[f.id] || {};

    let startUtc, endUtc;

    if (cfg.startUtc && cfg.endUtc) {
      // 使用 config 中的精确时间戳
      startUtc = cfg.startUtc;
      endUtc = cfg.endUtc;
    } else {
      if (!f.utcTime) continue;
      const globalIdx = allFeelings.indexOf(f);
      const nextUtc=globalIdx >= 0 && globalIdx < allFeelings.length - 1 ? allFeelings[globalIdx + 1].utcTime : null;
      const automatic=automaticRetainWindow(f.utcTime,nextUtc,messages);
      startUtc=automatic.startUtc;
      endUtc=automatic.endUtc;
    }
    fragmentWindows.push({ feeling: f, startUtc, endUtc });
  }

  // 从 archive 加载碎片消息
  const fragmentArchive = {}; // date → [{timestamp, type, text}]
  const fragmentDates = new Set();

  for (const fw of fragmentWindows) {
    const date = fw.feeling.date;
    if (!date) continue;
    const entries = [];
    for (const obj of readMessages(path.join(THREAD_BASE, "memory"), { threadId: currentThreadId, from: fw.startUtc, to: fw.endUtc })) {
      try {
        if (obj.timestamp) {
          const t = new Date(obj.timestamp).getTime(), s = new Date(fw.startUtc).getTime(), e = new Date(fw.endUtc).getTime();
          if (t >= s && t < e) entries.push({ timestamp: obj.timestamp, type: obj.type, text: obj.text || "" });
        }
      } catch {}
    }
    if (entries.length > 0) {
      if (!fragmentArchive[date]) fragmentArchive[date] = [];
      fragmentArchive[date].push(...entries);
      fragmentDates.add(date);
    }
  }

  // pre-window feelings: retainOriginal 的不放记忆块, 其余放记忆块
  const memoryFeelings = preWindow.filter((f) => !retainIds.has(f.id));
  console.log(`[rebuild]   ${retainFeelings.length} retainOriginal (from retain-config.json) → ${fragmentWindows.length} fragments, ${fragmentDates.size} dates`);

  // === 构建输出 ===
  const now = new Date();
  const outputLines = [];
  let prevUuid = null;
  let stats = { memoryBlock: 0, windowMsg: 0, systemDropped: 0 };
  const emittedHashes = new Set();

  function emit(type, content, extra = {}) {
    // 去重: 泛化变量后用模板指纹 hash，同骨架文本只留一条
    const contentSrc = typeof content === "string" ? content : JSON.stringify(content);
    const dedupKey = templateFingerprint(contentSrc);
    const hash = crypto.createHash("md5").update(dedupKey).digest("hex");
    if (emittedHashes.has(hash)) return null;
    emittedHashes.add(hash);

    const uuid = newUuid();
    const ts = extra.timestamp || new Date().toISOString();
    const msg = {
      type,
      uuid,
      parentUuid: prevUuid || null,
      timestamp: ts,
      message: { role: type, content },
    };
    if (type === "assistant") {
      msg.message.id = newUuid();
      msg.message.model = extra.model || "deepseek";
      msg.message.stop_reason = extra.stop_reason || "end_turn";
      msg.message.stop_sequence = null;
    }
    outputLines.push(JSON.stringify(msg));
    prevUuid = uuid;
    return uuid;
  }

  // 0. System init
  const sysMsg = {
    type: "system",
    subtype: "init",
    session_id: path.basename(inputPath, ".jsonl"),
    timestamp: now.toISOString(),
    cwd: os.homedir(),
    version: "2.1.144",
  };
  outputLines.push(JSON.stringify(sysMsg));
  prevUuid = sysMsg.session_id;

  // 1. 注入 rules/ 下所有 .md 文件（标记: <!-- stmem-rule: <filename> -->）
  const RULE_MARKER = "<!-- stmem-rule:";
  let ruleCount = 0;
  const injectedRuleNames = [];
  try {
    fs.mkdirSync(RULES_DIR, { recursive: true });
    const { listRules } = require("../src/services/rule-store");
    for (const { name: f, content: text, injected } of listRules(currentThreadId)) {
      if (!injected) continue;
      if (!text.trim()) continue;
      emit("user", `${RULE_MARKER} ${f} -->\n${text}`);
      ruleCount++;
      injectedRuleNames.push(f);
    }
  } catch {}
  if (ruleCount > 0) console.log(`[rebuild]   injected ${ruleCount} rules from rules/`);

  // 2. Pre-window: 记忆块 + 片段交替注入
  let pendingMemory = []; // 当前累积的记忆 feelings
  let retainedMessages = 0;

  // 收集所有 pre-window 日期
  const allPreDates = new Set();
  for (const f of preWindow) allPreDates.add(f.date);
  const sortedPreDates = [...allPreDates].sort();

  for (const date of sortedPreDates) {
    if (fragmentDates.has(date)) {
      // 先输出累积的记忆块
      if (pendingMemory.length > 0) {
        const blocks = buildMemoryBlocks(pendingMemory);
        for (const block of blocks) { emit("user", block.text, { timestamp: block.timestamp }); stats.memoryBlock++; }
        pendingMemory = [];
      }
      // 输出该日期的片段消息（从 archive，去时间戳前缀）
      const dayEntries = fragmentArchive[date] || [];
      for (const entry of dayEntries) {
        const cleanText = (entry.text || "").replace(/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/gm, "").trim();
        if (!cleanText || cleanText.startsWith("{\"action\"")) continue;
        const msg = {
          type: entry.type,
          timestamp: entry.timestamp,
          message: { content: cleanText },
        };
        const before = stats.windowMsg;
        outputCleanMessage(msg, emit, stats, preservedToolIds);
        retainedMessages += stats.windowMsg - before;
      }
      // 该日期未被 retain 的 feelings → 进 pendingMemory (下一个记忆块)
      const dayNonRetain = preWindow.filter((f) => f.date === date && !retainIds.has(f.id));
      pendingMemory.push(...dayNonRetain);
    } else {
      // 无片段 → 累积 feelings 到记忆块
      const dayFeelings = preWindow.filter((f) => f.date === date);
      pendingMemory.push(...dayFeelings);
    }
  }

  // 输出剩余记忆块
  if (pendingMemory.length > 0) {
    const blocks = buildMemoryBlocks(pendingMemory);
    for (const block of blocks) { emit("user", block.text, { timestamp: block.timestamp }); stats.memoryBlock++; }
  }

  // 3. 窗口内消息 (近 N 天) — 保留对话 + thinking，去掉工具链/轮询
  console.log(`[rebuild] Processing window messages (>= ${cutoffUtc || cutoffDate})...`);

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    const d = msgDate(msg);
    if (!d || !isWindowMessage(msg) || (msg.type === "system" || msg.type === "attachment")) continue;
    const content = msg.message?.content;
    const selectableText = typeof content === "string" ? content.trim() : Array.isArray(content)
      ? content.filter(block => block.type === "text" || block.type === "thinking").map(block => block.text || "").filter(Boolean).join("\n").trim()
      : "";
    if (selectableText && plan.excludedMessages.has(itemKey(msg.timestamp, msg.type, selectableText))) continue;
    outputCleanMessage(msg, emit, stats, preservedToolIds);
  }

  // === UUID 链完整性：补上因源文件 JSON 损坏导致的断链 ===
  let chainFixed = 0;
  {
    const seenUuids = new Set();
    let prevValidUuid = null;
    for (let i = 0; i < outputLines.length; i++) {
      const line = outputLines[i];
      try {
        var d = JSON.parse(line);
        if (d.uuid) { seenUuids.add(d.uuid); prevValidUuid = d.uuid; }
        if (d.parentUuid && d.parentUuid !== sysMsg.session_id && !seenUuids.has(d.parentUuid)) {
          d.parentUuid = prevValidUuid || sysMsg.session_id;
          outputLines[i] = JSON.stringify(d);
          seenUuids.add(d.uuid);
          chainFixed++;
        }
      } catch { /* 不应发生，兜底跳过 */ }
    }
  }
  if (chainFixed > 0) console.log(`[rebuild]   UUID chain: ${chainFixed} orphan(s) relinked`);

  // === 统计与输出 ===
  const originalSize = fs.statSync(inputPath).size;
  const fullArchiveSize = FULL_ARCHIVE.getTotalBytes();
  const totalOutput = outputLines.length;
  const totalOriginal = messages.length;
  const outputText = outputLines.join("\n");
  const estimatedOutputSize = Buffer.byteLength(outputText, "utf8");
  const byteReduction = fullArchiveSize > 0 ? (1 - estimatedOutputSize / fullArchiveSize) * 100 : null;

  if (dryRun) {
    console.log("\n[rebuild] ====== DRY RUN ======");
    console.log(`  Window:            ${windowDays} days (since ${cutoffDate})`);
    console.log(`  Original messages: ${totalOriginal}`);
    console.log(`  Output lines:      ${totalOutput}`);
    console.log(`  Reduction:         ${byteReduction === null ? "—" : `${byteReduction.toFixed(1)}%`}`);
    console.log(`  Memory blocks:     ${stats.memoryBlock}`);
    console.log(`  Window messages:   ${stats.windowMsg}`);
    console.log(`  Retained messages: ${retainedMessages}`);
    console.log(`  System dropped:    ${stats.systemDropped}`);
    console.log(`  Memory feelings:   ${memoryFeelings.length}`);
    console.log(`  Full archive size: ${fullArchiveSize} bytes`);
    console.log(`  Estimated output:  ${estimatedOutputSize} bytes`);
    console.log("==============================");
  } else {
    fs.writeFileSync(outputPath, outputText, "utf8");
    const outputSize = fs.statSync(outputPath).size;
    // 备份原文件
    const bakPath = inputPath + ".bak." + new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    fs.copyFileSync(inputPath, bakPath);
    console.log(`[rebuild]   backup: ${path.basename(bakPath)}`);
    // 原子替换 — 不依赖外部 mv
    fs.renameSync(outputPath, inputPath);
    const triggerIdx=process.argv.indexOf("--trigger"),trigger=triggerIdx>=0?process.argv[triggerIdx+1]:"cli";
    require("../src/services/rebuild-log").appendRebuildLog(currentThreadId,{status:"completed",runtime:"claude",trigger,threadFile:inputPath,windowDays,recentMessages:Math.max(0,stats.windowMsg-retainedMessages),retainAnchors:retainFeelings.length,retainedMessages,injectedFeelings:memoryFeelings.length,injectedRules:ruleCount,injectedRuleNames,preservedToolPairs:pairCount,originalBytes:fullArchiveSize,contextBytes:outputSize,outputLines:totalOutput});
    console.log(`\n[rebuild] ${(fullArchiveSize / 1024 / 1024).toFixed(2)} MB full → ` +
      `${(outputSize / 1024 / 1024).toFixed(2)} MB ` +
      `(${fullArchiveSize > 0 ? ((1 - outputSize / fullArchiveSize) * 100).toFixed(1) : "—"}% saved)`);
  }
}

// ---- CLI ----

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = !apply || args.includes("--dry-run");
  const threadIdx = args.indexOf("--thread");
  const windowIdx = args.indexOf("--window");
  const toolPairsIdx = args.indexOf("--tool-pairs");
  const planIdx = args.indexOf("--plan");
  const watermarkMode = args.includes("--watermark");
  const threadId = threadIdx >= 0 ? args[threadIdx + 1] : null;
  const windowDays = windowIdx >= 0
    ? parseInt(args[windowIdx + 1], 10) || DEFAULT_WINDOW_DAYS
    : DEFAULT_WINDOW_DAYS;
  const toolPairsOverride = toolPairsIdx >= 0
    ? Math.max(0, parseInt(args[toolPairsIdx + 1], 10) || 0)
    : null;
  const plan = loadRebuildPlan(planIdx >= 0 ? args[planIdx + 1] : null);

  initThreadPaths(threadId);
  const OUTPUT_SUFFIX = ".rebuilt";

  function searchSessionFile(dir) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = searchSessionFile(full); if (found) return found; }
      if (entry.isFile() && entry.name.endsWith(".jsonl") && (threadId ? entry.name.includes(threadId) : true) && !entry.name.includes("compressed") && !entry.name.includes("rebuilt")) return full;
    }
    return null;
  }

  let inputFile;
  if (threadId) {
    inputFile = searchSessionFile(SESSION_DIR) || path.join(SESSION_DIR, `${threadId}.jsonl`);
  } else {
    inputFile = searchSessionFile(SESSION_DIR);
    if (!inputFile) {
      console.error("No thread files found");
      process.exit(1);
    }
  }

  if (!fs.existsSync(inputFile)) {
    console.error(`无法重建：在 ${SESSION_DIR} 中没有找到线程 ${threadId}。请修改线程文件目录或检查文件是否存在`);
    process.exit(1);
  }

  const outputFile = inputFile.replace(/\.jsonl$/, `${OUTPUT_SUFFIX}.jsonl`);

  if (dryRun && !apply) {
    rebuildThread(inputFile, outputFile, true, windowDays, toolPairsOverride, plan, watermarkMode);
    console.log("\n[rebuild] Use --apply to write.");
    return;
  }

  rebuildThread(inputFile, outputFile, false, windowDays, toolPairsOverride, plan, watermarkMode);
  console.log(`\n[rebuild] Done — thread replaced.`);
}

main();
