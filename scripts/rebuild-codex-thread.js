#!/usr/bin/env node
/**
 * Codex 线程重建 — 滚动窗口 + function_call 工具链保留
 *
 * 策略:
 *   近 N 天: 对话 + function_call 工具链全保留
 *   N 天前:  feelings → memory_context 块
 *   保留最近 N 对 function_call 链（按 call_id 配对）
 *
 * 用法:
 *   node scripts/rebuild-codex-thread.js --thread <id> [--window N] [--tool-pairs N]
 *   node scripts/rebuild-codex-thread.js --thread <id> --apply
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { FullArchive, dateKeyFromTs } = require("../src/services/memory-archive");
const {
  loadInjectableFeelings, loadRetainConfig,
  buildFragmentWindows, buildMemoryBlocks, resolveLatestFeelingWatermark,
} = require("../src/services/thread-rebuilder");
const { getCfg, getThreadDir } = require("../src/config");
const { readMessages } = require("../src/storage/memory-reader");
const { itemKey, conversationWindow, loadRebuildPlan } = require("../src/services/rebuild-workbench");
const { buildCodexSessionMeta, validateCodexRebuildOutput } = require("../src/services/codex-session-meta");

const DEFAULT_WINDOW_DAYS = 3;

function getFeelingsPaths(threadId) {
  const dir = getThreadDir(threadId);
  return {
    retainConfig: path.join(dir, "memory", "retain-config.json"),
  };
}

function msgDate(ts) {
  return dateKeyFromTs(ts);
}

/** 提取纯文本（input_text / output_text） */
function extractTextBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(b => b.type === "input_text" || b.type === "output_text");
}

/** 模板指纹：泛化变量为占位符，暴露骨架用于去重 */
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

/** 判断是否为系统注入内容 */
function isSystemInjection(text) {
  if (!text) return false;
  const t = templateFingerprint(text);
  return /<memory_context>|Relevant past memories:|Continue from where you left off\.|Review the current code changes|你上线了|Trigger:|\[轮询唤醒\]|你从哪来|石头待办清单|WECHAT SESSION INSTRUCTIONS/i.test(t);
}

/** 判断一条 response_item 是否是 function_call */
function isFunctionCall(msg) {
  return msg.type === "response_item" && msg.payload?.type === "function_call";
}

/** 判断一条 response_item 是否是 function_call_output */
function isFunctionCallOutput(msg) {
  return msg.type === "response_item" && msg.payload?.type === "function_call_output";
}

/** 判断一条 response_item 是否是常规消息（user/assistant） */
function isMessage(msg) {
  return msg.type === "response_item" && msg.payload?.type === "message";
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const threadIdx = args.indexOf("--thread");
  const windowIdx = args.indexOf("--window");
  const toolPairsIdx = args.indexOf("--tool-pairs");
  const planIdx = args.indexOf("--plan");
  const triggerIdx = args.indexOf("--trigger");
  const watermarkMode = args.includes("--watermark");
  const threadId = threadIdx >= 0 ? args[threadIdx + 1] : null;
  const windowDays = windowIdx >= 0 ? parseInt(args[windowIdx + 1]) || DEFAULT_WINDOW_DAYS : DEFAULT_WINDOW_DAYS;
  const keepPairs = toolPairsIdx >= 0 ? Math.max(0, parseInt(args[toolPairsIdx + 1]) || 0) : 40;
  const plan = loadRebuildPlan(planIdx >= 0 ? args[planIdx + 1] : null);
  const trigger = triggerIdx >= 0 ? args[triggerIdx + 1] : "cli";

  if (!threadId) { console.log("用法: --thread <id> [--window N] [--tool-pairs N] [--apply]"); return; }
  const codexDir = getCfg("sessionDir", threadId);
  if (!codexDir) { console.error("无法重建：未配置线程文件目录，请前往设置填写 Codex session 搜索目录"); process.exit(1); }

  // 支持 rollout-<threadId>.jsonl 文件名和日期子目录
  function searchSessionFile(dir) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = searchSessionFile(full); if (found) return found; }
      if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId) && !entry.name.includes(".rebuilt")) return full;
    }
    return null;
  }
  let inputFile = path.join(codexDir, `${threadId}.jsonl`);
  if (!fs.existsSync(inputFile)) {
    inputFile = searchSessionFile(codexDir);
    if (!inputFile) { console.error(`无法重建：在 ${codexDir} 中没有找到线程 ${threadId}。请修改线程文件目录或检查文件是否存在`); process.exit(1); }
  }
  const pendingFile=inputFile.replace(/\.jsonl$/i,".rebuilt.jsonl");
  if(process.platform==="win32"&&fs.existsSync(pendingFile)){
    const pendingRaw=fs.readFileSync(pendingFile,"utf8");
    const pendingMeta=JSON.parse(pendingRaw.split("\n").find(Boolean)||"null");
    const pendingId=pendingMeta?.payload?.session_id||pendingMeta?.payload?.id;
    if(!pendingId)throw new Error(`待替换文件缺少 Codex session ID：${pendingFile}`);
    validateCodexRebuildOutput(pendingRaw,pendingId);
    try{
      fs.copyFileSync(pendingFile,inputFile);
      fs.unlinkSync(pendingFile);
      console.log(`[codex-rebuild] pending replace applied: ${pendingFile} → ${inputFile}`);
    }catch(error){
      throw new Error(`仍无法写入 Codex 活动线程，请关闭占用该线程的 Codex 后重试：${error.message}`);
    }
  }

  console.log(`[codex-rebuild] Loading: ${inputFile}`);
  const raw = fs.readFileSync(inputFile, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  let parseSkipped = 0;
  const allMsgs = lines.map(l => { try { return JSON.parse(l); } catch { parseSkipped++; return null; } }).filter(Boolean);
  if (parseSkipped > 0) console.warn(`[codex-rebuild]   ⚠️ ${parseSkipped} corrupted lines skipped`);

  // 提取元信息（保留原始 originator，不覆盖为 "codex-rebuild"）
  const metaMsg = allMsgs.find(m => m.type === "session_meta");
  const origSessionId = metaMsg?.payload?.session_id || metaMsg?.payload?.id || threadId;
  const origCwd = metaMsg?.payload?.cwd || process.cwd();

  // === 全量备份到 full/ ===
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const codexArchive = new FullArchive(memoryDir);
  const backed = codexArchive.archiveNewFullBatch(allMsgs);
  if (backed > 0) console.log(`[codex-rebuild] full backup: ${backed} new messages`);

  // === 工具链扫描（反向，保留最近 N 对 function_call） ===
  const preservedCallIds = new Set();
  let pairCount = 0;
  for (let i = allMsgs.length - 1; i >= 0 && pairCount < keepPairs; i--) {
    const m = allMsgs[i];
    if (!isFunctionCall(m)) continue;
    const callId = m.payload?.call_id;
    if (!callId) continue;
    const date = msgDate(m.timestamp);
    // 配对：找同名 response_item 中紧随的 function_call_output
    let hasOutput = false;
    for (let j = i + 1; j < allMsgs.length; j++) {
      if (!isFunctionCallOutput(allMsgs[j])) continue;
      if (allMsgs[j].payload?.call_id === callId) { hasOutput = true; break; }
    }
    if (!hasOutput) continue;
    pairCount++;
    preservedCallIds.add(callId);
  }
  for (const id of plan.excludedTools) preservedCallIds.delete(id);
  console.log(`[codex-rebuild] Tool chains: ${pairCount} pairs preserved`);

  // === 构建消息列表（只保留 user/assistant + function_call I/O） ===
  // 每条消息附带其关联的 function_call 链
  const messages = [];
  const msgToCallIds = new Map(); // message index → [call_id, ...]
  const callIdToMsg = {}; // call_id → { timestamp, payload }
  let msgIdx = 0;

  for (const m of allMsgs) {
    if (m.type === "session_meta" || m.type === "turn_context") continue;
    if (m.type === "event_msg") continue;

    if (isMessage(m)) {
      const role = m.payload.role;
      if (role === "developer") continue;
      const text = extractTextBlocks(m.payload.content).map(b => b.text || "").join(" ").trim();
      if (!text && !m.payload.content?.some(b => b.type === "tool_use" || b.type === "tool_result")) continue;
      const idx = messages.length;
      messages.push({ timestamp: m.timestamp, type: role === "user" ? "user" : "assistant", text });
      msgToCallIds.set(idx, []);
      msgIdx = idx;
    } else if (isFunctionCall(m)) {
      const callId = m.payload?.call_id;
      if (callId) {
        callIdToMsg[callId] = { timestamp: m.timestamp, payload: m.payload };
        if (preservedCallIds.has(callId)) {
          const prevMsgs = msgToCallIds.get(msgIdx);
          if (prevMsgs !== undefined) prevMsgs.push(callId);
        }
      }
    } else if (isFunctionCallOutput(m)) {
      const callId = m.payload?.call_id;
      if (callId && preservedCallIds.has(callId)) {
        callIdToMsg[callId + "_out"] = { timestamp: m.timestamp, payload: m.payload };
      }
    }
  }

  // === 窗口 ===
  const fallbackWindow = conversationWindow(allMsgs, "codex", windowDays);
  const watermark = watermarkMode ? resolveLatestFeelingWatermark(memoryDir, threadId, messages) : null;
  const cutoffUtc = watermark?.cutoffUtc || null;
  const cutoffDate = cutoffUtc ? dateKeyFromTs(cutoffUtc) : fallbackWindow.cutoff;
  const isWindowMessage = message => cutoffUtc
    ? new Date(message?.timestamp || "").getTime() >= new Date(cutoffUtc).getTime()
    : msgDate(message?.timestamp) >= cutoffDate;
  console.log(watermark
    ? `[codex-rebuild] Retention mode: watermark (feeling ${watermark.feelingId}, since ${cutoffUtc})`
    : `[codex-rebuild] Retention mode: active-days${watermarkMode ? " (watermark unavailable)" : ""}`);
  console.log(`[codex-rebuild] Window: ${windowDays} days (cutoff: ${cutoffDate})`);

  // === Feelings ===
  console.log(`[codex-rebuild] Loading injectable feelings (daily/coarse; hidden excluded)...`);
  const fp = getFeelingsPaths(threadId);
  const allFeelings = loadInjectableFeelings(path.join(getThreadDir(threadId), "memory"), threadId);
  const preWindow = watermark
    ? allFeelings.filter(f => f.id !== watermark.feelingId)
    : allFeelings.filter(f => f.date < cutoffDate);
  const inWindow = watermark
    ? allFeelings.filter(f => f.id === watermark.feelingId)
    : allFeelings.filter(f => f.date >= cutoffDate);
  console.log(`[codex-rebuild] ${preWindow.length} pre-window, ${inWindow.length} in-window`);

  // === 锚点 + 片段 ===
  const retainConfig = loadRetainConfig(fp.retainConfig);
  const retainMap = retainConfig.retain || {};
  const { retainFeelings, retainIds, fragmentWindows, msgInFragment } = buildFragmentWindows(preWindow, allFeelings, messages, retainMap);

  // 从 archive 按 UTC 窗口加载碎片消息（与 rebuild-thread.js 一致）
  const archiveDir = path.join(getThreadDir(threadId), "memory", "archive");
  const fragmentArchive = {}; // date → [{timestamp, type, text}]
  const fragmentDates = new Set();

  for (const fw of fragmentWindows) {
    const date = fw.feeling.date;
    if (!date) continue;
    for (const obj of readMessages(path.join(getThreadDir(threadId), "memory"), { threadId, from: fw.startUtc, to: fw.endUtc })) {
      try {
        if (obj.timestamp) { const t = new Date(obj.timestamp).getTime(), s = new Date(fw.startUtc).getTime(), e = new Date(fw.endUtc).getTime(); if (t >= s && t < e) {
          if (!fragmentArchive[date]) fragmentArchive[date] = [];
          fragmentArchive[date].push({ timestamp: obj.timestamp, type: obj.type, text: obj.text || "" });
          fragmentDates.add(date);
        } }
      } catch {}
    }
  }

  const memoryFeelings = preWindow.filter(f => !retainIds.has(f.id));
  console.log(`[codex-rebuild] ${retainFeelings.length} fragments → ${fragmentDates.size} archive dates, ${memoryFeelings.length} → memory`);

  // === 构建输出 ===
  const output = [];
  const now = new Date();
  let stats = { memoryBlock: 0, windowMsg: 0, functionCall: 0, systemDropped: 0 };
  const emittedHashes = new Set();

  function isClean(text) {
    if (!text) return false;
    if (isSystemInjection(text)) return false;
    return true;
  }

  // System meta（保留原始 originator）
  output.push(JSON.stringify(buildCodexSessionMeta(metaMsg,{threadId:origSessionId,now,cwd:origCwd})));

  // Turn context
  output.push(JSON.stringify({
    timestamp: now.toISOString(), type: "turn_context",
    payload: { turn_id: `turn-${Date.now()}`, cwd: origCwd, current_date: now.toISOString().slice(0, 10), timezone: "Asia/Shanghai" },
  }));

  // 1. 注入 rules/ 下所有 .md 文件
  const RULES_DIR = path.join(getThreadDir(threadId), "rules");
  const RULE_MARKER = "<!-- stmem-rule:";
  let ruleCount = 0;
  const injectedRuleNames = [];
  try {
    fs.mkdirSync(RULES_DIR, { recursive: true });
    const { listRules } = require("../src/services/rule-store");
    for (const { name: f, content: text, injected } of listRules(threadId)) {
      if (!injected) continue;
      if (!text.trim()) continue;
      output.push(JSON.stringify({
        timestamp: now.toISOString(), type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${RULE_MARKER} ${f} -->\n${text}` }] },
      }));
      ruleCount++;
      injectedRuleNames.push(f);
    }
  } catch(error) {
    throw new Error(`读取人设 / 规则失败，已停止重建以避免生成无人设线程：${error.message}`);
  }
  if (ruleCount > 0) console.log(`[codex-rebuild] injected ${ruleCount} rules from rules/`);

  /** 输出一条常规消息（去重、去系统注入）+ 附属的 function_call 链 */
  function emitMessage(m, extraCallIds = []) {
    if (!m) return;
    const text = m.text || "";
    if (plan.excludedMessages.has(itemKey(m.timestamp, m.type, text))) return;
    // 跳过旧规则注入（会被 rules/ 重新注入）
    if (text.includes("<!-- stmem-rule:")) { stats.systemDropped++; return; }
    // 系统注入过滤
    if (!isClean(text)) { stats.systemDropped++; return; }
    // 骨架去重：同模板骨架只留第一条
    const dedupKey = templateFingerprint(text);
    const hash = crypto.createHash("md5").update(dedupKey).digest("hex");
    if (emittedHashes.has(hash)) { stats.systemDropped++; return; }
    emittedHashes.add(hash);
    // 输出
    const blockType = m.type === "user" ? "input_text" : "output_text";
    output.push(JSON.stringify({
      timestamp: m.timestamp, type: "response_item",
      payload: { type: "message", role: m.type, content: [{ type: blockType, text }] },
    }));
    stats.windowMsg++;
    // 附属 function_call 链
    for (const callId of extraCallIds) {
      const fc = callIdToMsg[callId];
      const fo = callIdToMsg[callId + "_out"];
      if (fc) {
        output.push(JSON.stringify({ timestamp: fc.timestamp, type: "response_item", payload: fc.payload }));
        stats.functionCall++;
      }
      if (fo) {
        output.push(JSON.stringify({ timestamp: fo.timestamp, type: "response_item", payload: fo.payload }));
        stats.functionCall++;
      }
    }
  }

  // 交替注入: 记忆块 ↔ 片段
  const preDates = [...new Set(preWindow.map(f => f.date))].sort();
  let pendingMemory = [];
  let retainedMessages = 0;
  for (const date of preDates) {
    if (fragmentDates.has(date)) {
      if (pendingMemory.length > 0) {
        for (const block of buildMemoryBlocks(pendingMemory, { userName: getCfg("user", threadId, "用户") })) {
          output.push(JSON.stringify({
            timestamp: block.timestamp, type: "response_item",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text: block.text }] },
          }));
          stats.memoryBlock++;
        }
        pendingMemory = [];
      }
      // 片段消息（从 archive 加载，按 UTC 窗口筛选，去重去注入）
      const dayEntries = fragmentArchive[date] || [];
      for (const entry of dayEntries) {
        const cleanText = (entry.text || "").replace(/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/gm, "").trim();
        if (!cleanText || !isClean(cleanText)) continue;
        const dedupKey = templateFingerprint(cleanText);
        const hash = crypto.createHash("md5").update(dedupKey).digest("hex");
        if (emittedHashes.has(hash)) continue;
        emittedHashes.add(hash);
        const blockType = entry.type === "user" ? "input_text" : "output_text";
        output.push(JSON.stringify({
          timestamp: entry.timestamp, type: "response_item",
          payload: { type: "message", role: entry.type, content: [{ type: blockType, text: cleanText }] },
        }));
        stats.windowMsg++;
        retainedMessages++;
      }
      const dayNonRetain = preWindow.filter(f => f.date === date && !retainIds.has(f.id));
      pendingMemory.push(...dayNonRetain);
    } else {
      pendingMemory.push(...preWindow.filter(f => f.date === date));
    }
  }
  if (pendingMemory.length > 0) {
    for (const block of buildMemoryBlocks(pendingMemory, { userName: getCfg("user", threadId, "用户") })) {
      output.push(JSON.stringify({
        timestamp: block.timestamp, type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: block.text }] },
      }));
      stats.memoryBlock++;
    }
  }

  // 窗口消息（保留工具链）
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (!m || !isWindowMessage(m)) continue;
    const callIds = msgToCallIds.get(mi) || [];
    emitMessage(m, callIds);
  }

  // === 统计 ===
  const totalOriginal = lines.length;
  const totalOutput = output.length;
  const fullArchiveSize = codexArchive.getTotalBytes();
  const outputText = output.join("\n") + "\n";
  validateCodexRebuildOutput(outputText,origSessionId);
  const estimatedOutputSize = Buffer.byteLength(outputText, "utf8");
  const byteReduction = fullArchiveSize > 0 ? (1 - estimatedOutputSize / fullArchiveSize) * 100 : null;

  if (apply) {
    // 备份
    const bakPath = inputFile + ".bak." + now.toISOString().replace(/[:.]/g, "").slice(0, 15);
    fs.copyFileSync(inputFile, bakPath);
    console.log(`[codex-rebuild] backup: ${path.basename(bakPath)}`);
    const stagedFile=inputFile.replace(/\.jsonl$/i,".rebuilt.jsonl");
    fs.writeFileSync(stagedFile,outputText,"utf8");
    validateCodexRebuildOutput(fs.readFileSync(stagedFile,"utf8"),origSessionId);
    try{
      if(process.platform==="win32"){
        fs.copyFileSync(stagedFile,inputFile);
        fs.unlinkSync(stagedFile);
      }else{
        fs.renameSync(stagedFile,inputFile);
      }
    }catch(error){
      throw new Error(`重建结果已安全保存在 ${stagedFile}，但无法覆盖活动线程；请关闭占用该线程的 Codex 后重试：${error.message}`);
    }
    const contextBytes=fs.statSync(inputFile).size;
    require("../src/services/rebuild-log").appendRebuildLog(threadId,{status:"completed",runtime:"codex",trigger,threadFile:inputFile,windowDays,recentMessages:Math.max(0,stats.windowMsg-retainedMessages),retainAnchors:retainFeelings.length,retainedMessages,injectedFeelings:memoryFeelings.length,injectedRules:ruleCount,injectedRuleNames,preservedToolPairs:pairCount,originalBytes:fullArchiveSize,contextBytes,outputLines:totalOutput});
    console.log(`\n[codex-rebuild] ${fullArchiveSize} bytes full → ${contextBytes} bytes (${fullArchiveSize > 0 ? ((1 - contextBytes / fullArchiveSize) * 100).toFixed(1) : "—"}% saved)`);
    console.log(`  Memory blocks: ${stats.memoryBlock} | Messages: ${stats.windowMsg} | Function calls: ${stats.functionCall} | System dropped: ${stats.systemDropped}`);
  } else {
    console.log(`\n[codex-rebuild] ====== DRY RUN ======`);
    console.log(`  Window: ${windowDays} days (since ${cutoffDate})`);
    console.log(`  Original: ${totalOriginal} lines → Output: ${totalOutput} lines`);
    console.log(`  Reduction: ${byteReduction === null ? "—" : `${byteReduction.toFixed(1)}%`}`);
    console.log(`  Full archive size: ${fullArchiveSize} bytes`);
    console.log(`  Estimated output: ${estimatedOutputSize} bytes`);
    console.log(`  Memory blocks: ${stats.memoryBlock} | Messages: ${stats.windowMsg} | Function calls: ${stats.functionCall}`);
    console.log(`  Retained messages: ${retainedMessages}`);
    console.log(`  System dropped: ${stats.systemDropped}`);
    console.log(`  Tool pairs preserved: ${pairCount}`);
    console.log("  Use --apply to write.");
  }
}

main();
