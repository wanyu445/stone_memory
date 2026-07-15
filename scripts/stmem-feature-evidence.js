#!/usr/bin/env node
const path = require("path");
const { getThreadDir, listThreadIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { extractFeatureTerms } = require("../src/services/feature-phrase-extractor");
const { scanTermEvidence, aggregateFeelingEvidence } = require("../src/services/feature-term-evidence");

const args = process.argv.slice(3);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const threadId = value("--thread") || listThreadIds()[0];
const categoryArg = value("--categories");
if (!threadId) throw new Error("没有已配置线程，请使用 --thread <id>");

const memoryDir = path.join(getThreadDir(threadId), "memory");
const store = new MemoryStore({ memoryDir, threadId });
let features, feelings;
try { features = store.listFeatures(); feelings = store.listFeelings(); } finally { store.close(); }
const categories = categoryArg
  ? categoryArg.split(",").map(x => x.trim()).filter(Boolean)
  : [...new Set(features.map(row => row.category).filter(Boolean))].sort();
const evidence = scanTermEvidence({
  terms: extractFeatureTerms(features, categories),
  feelings,
  archiveDir: path.join(memoryDir, "archive"),
});
const feelingEvidence = aggregateFeelingEvidence({ feelings, termEvidence: evidence });

if (args.includes("--json")) {
  console.log(JSON.stringify({ threadId, categories, evidence, feelingEvidence }, null, 2));
  process.exit(0);
}

console.log(`Feature 词频证据（archive + feelings，只读）— ${threadId}`);
for (const category of categories) {
  console.log(`\n[${category}]`);
  const rows = evidence.filter(row => row.category === category)
    .sort((a, b) => b.activeDays - a.activeDays || b.messageCount - a.messageCount || a.term.localeCompare(b.term, "zh-CN"));
  for (const row of rows) {
    const range = row.firstSeen ? `${row.firstSeen} ~ ${row.lastSeen}` : "无原文命中";
    const levels = row.feelingImportances.length ? row.feelingImportances.join(",") : "-";
    console.log(`  ${row.term}: archive ${row.messageCount} 条/${row.activeDays} 天 (${range})；feelings ${row.feelingCount} 条；importance ${levels}`);
  }
}

console.log(`\n[feelings] ${feelingEvidence.length} 条命中 feature terms`);
for (const feeling of feelingEvidence) {
  const terms = feeling.matchedTerms.map(row =>
    `${row.term}(${row.messageCount}条/${row.activeDays}天, ${row.firstSeen || "-"}~${row.lastSeen || "-"})`).join("；");
  console.log(`  ${feeling.sourceDate || "无日期"} ${feeling.feelingId} [importance ${feeling.importance}]：${terms}`);
}
