#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getThreadDir, listThreadIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { extractFeatureTerms } = require("../src/services/feature-phrase-extractor");
const { readUserArchive } = require("../src/services/feature-term-evidence");
const { buildTermTimeline } = require("../src/services/term-timeline");

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const threadId = value("--thread") || listThreadIds()[0];
const requestedTerms = (value("--terms") || "").split(",").map(term => term.trim()).filter(Boolean);
if (!threadId) throw new Error("没有已配置线程，请使用 --thread <id>");
if (!requestedTerms.length) throw new Error("请使用 --terms 词1,词2 指定要查看的词");
const memoryDir = path.join(getThreadDir(threadId), "memory");
const store = new MemoryStore({ memoryDir, threadId });
let features, feelings;
try { features = store.listFeatures(); feelings = store.listFeelings(); } finally { store.close(); }
let anchors = { retain: {}, eventAnchors: {} };
try { anchors = JSON.parse(fs.readFileSync(path.join(memoryDir, "retain-config.json"), "utf8")); } catch {}
const report = buildTermTimeline({
  requestedTerms,
  extractedTerms: extractFeatureTerms(features),
  feelings,
  messages: readUserArchive(path.join(memoryDir, "archive")),
  anchors,
  from: value("--from"),
  to: value("--to"),
});

if (args.includes("--json")) {
  console.log(JSON.stringify({ threadId, report }, null, 2));
  process.exit(0);
}

console.log(`Term 时间轴（archive 用户消息 + feeling 小点，只读）— ${threadId}`);
const feelingLimit = args.includes("--all") ? Infinity : Math.max(1, Number(value("--feeling-limit")) || 20);
for (const row of report) {
  console.log(`\n[${row.term}] categories=${row.categories.join(",") || "未进入 feature terms"}`);
  console.log(`范围 ${row.from || "-"} ~ ${row.to || "-"}；消息 ${row.messageCount}；出现 ${row.occurrenceCount} 次；活跃 ${row.activeDays} 天；feelings ${row.feelings.length}`);
  const active = row.timeline.filter(point => point.messageCount > 0);
  console.log(`曲线非零点: ${active.map(point => `${point.date}:${point.occurrenceCount}`).join("  ") || "无"}`);
  console.log("Feeling 小点:");
  for (const feeling of row.feelings.slice(0, feelingLimit)) {
    const flags = [feeling.retainAnchor && "retain", feeling.eventAnchor && "event"].filter(Boolean).join(",");
    console.log(`  ${feeling.sourceDate} ${feeling.id} [importance ${feeling.importance}${flags ? `; ${flags}` : ""}] ${feeling.content}`);
  }
  if (row.feelings.length > feelingLimit) console.log(`  …另有 ${row.feelings.length - feelingLimit} 条，使用 --all 查看`);
}
