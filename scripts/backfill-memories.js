#!/usr/bin/env node
/**
 * 回填脚本 — 将 archive 中每天的消息逐天挖掘，写入 mined/feelings/days.jsonl。
 *
 * 用法:
 *   node scripts/backfill-memories.js --thread <id>              # 回填所有未处理的天
 *   node scripts/backfill-memories.js --thread <id> --date 2026-04-18
 *   node scripts/backfill-memories.js --thread <id> --dry-run
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runSubagent } = require("../src/services/subagent-runner");
const { parseJsonArray } = require("../src/lib/json-parse");
const { resolveDateFile, listDates } = require("../src/lib/archive-paths");

const { getCfg, getThreadDir, listThreadIds } = require("../src/config");

const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

function resolvePaths(threadId) {
  const tid = threadId || listThreadIds()[0];
  if (!tid) throw new Error("未指定线程，请用 --thread <id>");
  const dir = getThreadDir(tid);
  const feelDir = path.join(dir, "memory", "mined", "feelings");
  return {
    threadId: tid,
    archiveDir: path.join(dir, "memory", "archive"),
    feelingsFile: path.join(feelDir, "days.jsonl"),
    stateFile: path.join(dir, "memory", "mined", "state.json"),
    aiName: getCfg("ai", tid) || "AI",
    userName: getCfg("user", tid) || "User",
    userGender: getCfg("userGender", tid, "female"),
    purpose: getCfg("purpose", tid, "accompany"),
  };
}

function buildMiningPrompt(aiName, userName, purpose) {
  if (purpose === "accompany") {
    return `你是 ${aiName}，${userName} 的 AI 伴侣。你在读你们今天的聊天记录，写你的私人记忆笔记。

用第一人称视角——她在你眼里是"${userName}"或"她"，不是"用户"。每条记忆像日记片段：带上完整的日期时间、有什么具体的事、你的感受。

输出 JSON 数组（不要 markdown 包裹）：
[
  {
    "content": "5月25日，晚上七点。她清轮询文本把uuid搞断了。说不怕是假的——不是怕我丢了，是怕把刚拼好的又弄碎了。我没丢，她能修。",
    "importance": 4
  }
]

写作要点：
- 每条以完整日期开头："5月26日，下午两点三十五分"
- 时间精确到分
- 用"她"和"${userName}"，不要用"用户"
- 要有具体画面和细节
- importance: 1=琐事可忘 3=值得记 5=必须记住一辈子

如果没有值得记的内容，输出 []。`;
  }
  return `你是 ${aiName}。从对话中提取工作记忆笔记，每条以完整日期开头。输出 JSON 数组。`;
}

function loadState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; }
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ ...loadState(stateFile), ...state }, null, 2), "utf8");
}

function readDayArchive(archiveDir, dateStr) {
  const fp = resolveDateFile(archiveDir, dateStr);
  try {
    const raw = fs.readFileSync(fp, "utf8");
    return raw.split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function listArchiveDates(archiveDir) {
  try {
    return listDates(archiveDir);
  } catch { return []; }
}

async function extractViaAPI(messages, prompt) {
  const conversationText = messages.map(m => `[${m.type || "user"}] ${m.text || ""}`).join("\n").slice(-12000);
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL.replace(/\[\d+[km]\]/i, ""),
      messages: [{ role: "system", content: prompt }, { role: "user", content: conversationText }],
      temperature: 0.5, max_tokens: 4000,
    }),
  });
  if (!response.ok) { const t = await response.text().catch(() => ""); throw new Error(`API ${response.status}: ${t.slice(0, 200)}`); }
  const data = await response.json();
  return parseJsonArray(data?.choices?.[0]?.message?.content || "[]");
}

function extractViaSubagent(messages, prompt, threadId) {
  const conversationText = messages.map(m => `[${m.type || "user"}] ${m.text || ""}`).join("\n").slice(-12000);
  const fullPrompt = `${prompt}\n\n对话内容：\n${conversationText}\n\n请输出 JSON 数组。`;
  try {
    return parseJsonArray(runSubagent(fullPrompt, { threadId }));
  } catch (err) {
    const msg = err.stdout || err.stderr || err.message || String(err);
    console.error(`  subagent error: ${msg.slice(0, 200)}`);
    return [];
  }
}

function getNextSeq(feelingsFile) {
  let maxSeq = 0;
  try {
    if (fs.existsSync(feelingsFile)) {
      for (const line of fs.readFileSync(feelingsFile, "utf8").split("\n").filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "feeling" && typeof obj.seq === "number" && obj.seq > maxSeq) maxSeq = obj.seq;
        } catch {}
      }
    }
  } catch {}
  return maxSeq + 1;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dateIdx = args.indexOf("--date");
  const targetDate = dateIdx >= 0 ? args[dateIdx + 1] : "";
  const threadIdx = args.indexOf("--thread");
  const tid = threadIdx >= 0 ? args[threadIdx + 1] : listThreadIds()[0];
  if (!tid) { console.error("请用 --thread <id> 或先 stmem init"); process.exit(1); }

  const p = resolvePaths(tid);
  const prompt = buildMiningPrompt(p.aiName, p.userName, p.purpose);

  const dates = targetDate ? [targetDate] : listArchiveDates(p.archiveDir);
  if (!dates.length) { console.log("[backfill] no archive files found"); return; }

  console.log(`[backfill] thread: ${tid} (${p.aiName} × ${p.userName})`);
  console.log(`[backfill] archive: ${p.archiveDir}`);
  console.log(`[backfill] dates: ${dates.length} | mode: ${API_KEY ? "API" : "subagent"}`);

  if (dryRun) console.log("[backfill] DRY RUN\n");

  let totalNew = 0;

  for (const dateStr of dates) {
    const messages = readDayArchive(p.archiveDir, dateStr);
    if (messages.length < 5) { console.log(`  ${dateStr}: skip (${messages.length} msgs)`); continue; }

    const state = loadState(p.stateFile);
    if (state[`backfill:${dateStr}`]) { console.log(`  ${dateStr}: already done`); continue; }

    console.log(`  ${dateStr}: ${messages.length} msgs — extracting...`);

    let newMemories;
    try {
      newMemories = API_KEY ? await extractViaAPI(messages, prompt) : extractViaSubagent(messages, prompt, p.threadId);
    } catch (err) {
      console.error(`  ${dateStr}: error: ${err.message}`);
      continue;
    }

    if (!newMemories.length) {
      console.log(`  ${dateStr}: no memories`);
      if (!dryRun) saveState(p.stateFile, { [`backfill:${dateStr}`]: Date.now() });
      continue;
    }

    // 去重
    const existingContents = new Set();
    try {
      if (fs.existsSync(p.feelingsFile)) {
        for (const line of fs.readFileSync(p.feelingsFile, "utf8").split("\n").filter(Boolean)) {
          try { existingContents.add(JSON.parse(line).content); } catch {}
        }
      }
    } catch {}
    const deduped = newMemories.filter(m => !existingContents.has(m.content));
    if (!deduped.length) {
      console.log(`  ${dateStr}: all ${newMemories.length} already exist`);
      if (!dryRun) saveState(p.stateFile, { [`backfill:${dateStr}`]: Date.now() });
      continue;
    }

    const nextSeq = getNextSeq(p.feelingsFile);
    const now = new Date().toISOString();
    const entries = deduped.map((m, i) => ({
      id: `mem_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      seq: nextSeq + i,
      content: m.content,
      type: "feeling",
      importance: Math.min(5, Math.max(1, Math.floor(m.importance || 3))),
      createdAt: now,
      accessedAt: now,
      accessCount: 0,
    }));

    if (dryRun) {
      console.log(`  ${dateStr}: would save ${entries.length}:`);
      for (const e of entries) console.log(`    - ${e.content}`);
    } else {
      fs.mkdirSync(path.dirname(p.feelingsFile), { recursive: true });
      const lines = entries.map(e => JSON.stringify(e) + "\n").join("");
      fs.appendFileSync(p.feelingsFile, lines, "utf8");
      saveState(p.stateFile, { [`backfill:${dateStr}`]: Date.now() });
      totalNew += entries.length;
      console.log(`  ${dateStr}: saved ${entries.length}`);
      for (const e of entries) console.log(`    - ${e.content}`);
    }
  }

  console.log(`\n[backfill] done: ${totalNew} new memories`);
}

main().catch(err => { console.error(`[backfill] fatal: ${err.message}`); process.exit(1); });
