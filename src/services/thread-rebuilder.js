/**
 * 线程重建共享逻辑 — Claude Code / Codex 双格式复用
 *
 * 提供:
 *   - 时间解析 (中文自然语言 → UTC)
 *   - 分层 feelings 加载 (月 > 周 > 日)
 *   - 锚点配置 + 片段窗口计算
 *   - 记忆块构建 (按日期连续性切分)
 *   - 窗口分界计算
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { readFeelings } = require("../storage/memory-reader");

// 文件路径由调用方传入，不再硬编码

// ---- 中文数字 → int ----

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
  const date = `${year}-${dm[1].padStart(2,"0")}-${dm[2].padStart(2,"0")}`;
  const afterDate = content.slice(content.indexOf("日") + 1);
  const timeDesc = afterDate.split(/[。.]/).filter(Boolean)[0]?.replace(/^[，,]\s*/, "").trim() || "";
  const periods = [[/^凌晨/,0],[/^通宵/,0],[/^半夜/,0],[/^午夜/,0],[/^将近午夜/,0],[/^早上/,0],[/^上午/,0],[/^中午/,0],[/^下午/,12],[/^傍晚/,12],[/^晚上/,12],[/^深夜/,12]];
  let periodOffset = 0, periodName = "";
  for (const [re, off] of periods) { if (re.test(timeDesc)) { periodOffset = off; periodName = re.source.slice(1); break; } }
  let hour = null, minute = 0;
  const dotIdx = timeDesc.indexOf("点");
  if (dotIdx > 0) {
    let hStart = dotIdx - 1;
    while (hStart >= 0 && /[零一二三四五六七八九两十\d]/.test(timeDesc[hStart])) hStart--;
    hStart++;
    hour = cn2int(timeDesc.slice(hStart, dotIdx));
    const after = timeDesc.slice(dotIdx + 1);
    if (after.startsWith("半")) minute = 30;
    else if (after && after[0] !== "多") { const m = cn2int(after); if (m !== null && m < 60) minute = m; }
  }
  if (hour !== null) {
    if (periodName === "中午" && hour === 12) hour = 12;
    else if (periodName === "深夜" && hour === 12) hour = 0;
    else if (periodName === "深夜" && hour <= 5) hour = hour;
    else if (periodOffset === 12 && hour === 12) hour = 0;
    else if (periodOffset === 12) hour += 12;
  } else {
    const defs = { 凌晨:2,通宵:4,半夜:0,午夜:0,将近午夜:23,早上:8,上午:10,中午:12,下午:15,傍晚:18,晚上:20,深夜:23 };
    for (const [k,v] of Object.entries(defs)) if (timeDesc.includes(k)) { hour = v; break; }
  }
  if (hour !== null && hour >= 24) hour -= 24;
  return { date, timeDesc, hour, minute };
}

function feelingToUtc(f) {
  if (f.hour === null || f.hour === undefined) return null;
  return new Date(`${f.date}T${String(f.hour).padStart(2,"0")}:${String(f.minute||0).padStart(2,"0")}:00.000+08:00`).toISOString();
}

// ---- 分层加载 ----

function loadRetainConfig(retainConfigPath) {
  try { return JSON.parse(fs.readFileSync(retainConfigPath, "utf8")); }
  catch { return { retain: {} }; }
}

function loadInjectableFeelings(memoryDir, threadId) {
  const feelings = readFeelings(memoryDir, { threadId, forInjection: true }).map(r => {
    const parsed = parseFeelingTime(r.content) || {};
    const event = r.eventTime ? new Date(r.eventTime) : null;
    const localEvent = event && !isNaN(event.getTime()) ? new Date(event.getTime() + 8 * 3600 * 1000) : null;
    const hour = localEvent ? localEvent.getUTCHours() : parsed.hour;
    const minute = localEvent ? localEvent.getUTCMinutes() : parsed.minute;
    const time = { date: r.sourceDate || parsed.date, hour, minute };
    return { id: r.id, content: r.content, date: time.date, hour, minute, utcTime: feelingToUtc(time), retainOriginal: false };
  });
  console.log(`[rebuilder] sqlite: ${feelings.length} memories (daily/coarse; hidden excluded)`);
  return feelings;
}

// ---- 锚点 + 片段窗口 ----

function buildFragmentWindows(preWindowFeelings, allFeelings, messages, retainMap) {
  // 标记 retainOriginal
  for (const f of preWindowFeelings) {
    if (retainMap[f.id]) f.retainOriginal = true;
  }
  const retainFeelings = preWindowFeelings.filter(f => f.retainOriginal);
  const retainIds = new Set(retainFeelings.map(f => f.id));
  const fragmentWindows = [];
  for (const f of retainFeelings) {
    const cfg = retainMap[f.id] || {};
    let startUtc, endUtc;
    if (cfg.startUtc && cfg.endUtc) {
      startUtc = cfg.startUtc;
      endUtc = cfg.endUtc;
    } else if (f.utcTime) {
      const startMs = new Date(f.utcTime).getTime() - 30 * 60 * 1000;
      startUtc = new Date(startMs).toISOString();
      const idx = allFeelings.indexOf(f);
      if (idx >= 0 && idx < allFeelings.length - 1) {
        endUtc = allFeelings[idx + 1].utcTime || new Date(startMs + 24 * 3600000).toISOString();
      } else {
        endUtc = new Date(startMs + 24 * 3600000).toISOString();
      }
    } else continue;
    fragmentWindows.push({ feeling: f, startUtc, endUtc });
  }

  // 标记消息 → 片段
  const msgInFragment = new Set();
  for (const fw of fragmentWindows) {
    for (let mi = 0; mi < messages.length; mi++) {
      const ts = messages[mi].timestamp;
      if (ts && ts >= fw.startUtc && ts < fw.endUtc) msgInFragment.add(mi);
    }
  }

  return { retainFeelings, retainIds, fragmentWindows, msgInFragment };
}

// ---- 记忆块构建 ----

function buildMemoryBlocks(feelings) {
  if (feelings.length === 0) return [];
  const byDate = {};
  const dateFirstFeeling = {};
  for (const f of feelings) {
    const m = f.content.match(/^(\d+)月(\d+)日/);
    const dateKey = m ? (f.date || (() => { const cy=new Date().getFullYear(),cm=new Date().getMonth()+1; return `${parseInt(m[1])>cm+1?cy-1:cy}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`; })()) : "unknown";
    if (!byDate[dateKey]) byDate[dateKey] = [];
    byDate[dateKey].push(f.content);
    if (!dateFirstFeeling[dateKey] || (f.hour||0)*60+(f.minute||0) < (dateFirstFeeling[dateKey].hour||24)*60+(dateFirstFeeling[dateKey].minute||0)) {
      dateFirstFeeling[dateKey] = f;
    }
  }
  const dates = Object.keys(byDate).sort();
  if (dates.length === 0) return [];

  const groups = [];
  let current = [dates[0]];
  for (let i = 1; i < dates.length; i++) {
    if ((new Date(dates[i]) - new Date(dates[i-1])) / 86400000 <= 2) {
      current.push(dates[i]);
    } else {
      groups.push(current);
      current = [dates[i]];
    }
  }
  groups.push(current);

  const blocks = [];
  for (const group of groups) {
    const lines = [];
    lines.push("<memory_context>");
    lines.push("以下是你和小鱼在过去对话中的重要记忆，按时间排列。这些记忆是你在对话中自然形成的印象，作为背景知识理解即可，不需要逐条回应。");
    lines.push("");
    for (const d of group) {
      if (d === "unknown") continue;
      const m = d.match(/^\d{4}-(\d+)-(\d+)$/);
      const label = m ? `${parseInt(m[1])}月${parseInt(m[2])}日` : d;
      lines.push(`## ${label}`);
      for (const f of byDate[d]) lines.push(`- ${f}`);
      lines.push("");
    }
    lines.push("</memory_context>");
    const anchor = dateFirstFeeling[group[0]];
    blocks.push({ text: lines.join("\n"), timestamp: anchor?.utcTime || new Date().toISOString() });
  }
  return blocks;
}

// ---- 窗口计算 ----

function computeCutoff(windowDays, referenceDate = new Date().toISOString().slice(0, 10)) {
  const reference = /^\d{4}-\d{2}-\d{2}$/.test(String(referenceDate || ""))
    ? `${referenceDate}T00:00:00.000Z`
    : referenceDate;
  return new Date(new Date(reference).getTime() - windowDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

module.exports = {
  parseFeelingTime, feelingToUtc,
  loadRetainConfig, loadInjectableFeelings,
  buildFragmentWindows, buildMemoryBlocks,
  computeCutoff,
};
