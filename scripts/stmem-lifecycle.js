#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getThreadDir, listThreadIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { extractFeatureTerms } = require("../src/services/feature-phrase-extractor");
const { scanTermEvidence, aggregateFeelingEvidence } = require("../src/services/feature-term-evidence");
const { analyzeFeelingLifecycle, summarizeLifecycle } = require("../src/services/feeling-lifecycle");

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const threadId = value("--thread") || listThreadIds()[0];
if (!threadId) throw new Error("没有已配置线程，请使用 --thread <id>");
const memoryDir = path.join(getThreadDir(threadId), "memory");
const store = new MemoryStore({ memoryDir, threadId });
let features, feelings;
try { features = store.listFeatures(); feelings = store.listFeelings(); } finally { store.close(); }

const termEvidence = scanTermEvidence({
  terms: extractFeatureTerms(features), feelings, archiveDir: path.join(memoryDir, "archive"),
});
const feelingEvidence = aggregateFeelingEvidence({ feelings, termEvidence });
let anchors = { retain: {}, eventAnchors: {} };
try { anchors = JSON.parse(fs.readFileSync(path.join(memoryDir, "retain-config.json"), "utf8")); } catch {}
const lifecycle = analyzeFeelingLifecycle({
  feelingEvidence,
  eventAnchorIds: Object.keys(anchors.eventAnchors || {}),
  retainAnchorIds: Object.keys(anchors.retain || {}),
  referenceDate: value("--reference"),
});
const summary = {
  ...summarizeLifecycle(lifecycle),
  totalFeelings: feelings.length,
  unmatchedFeelings: feelings.length - feelingEvidence.length,
  referenceDate: lifecycle[0]?.referenceDate || value("--reference") || null,
};

if (args.includes("--json")) {
  console.log(JSON.stringify({ threadId, summary, lifecycle }, null, 2));
  process.exit(0);
}

console.log(`Feeling 生命周期 dry-run — ${threadId}`);
console.log(`参考日期: ${summary.referenceDate}`);
console.log(`全部 ${summary.totalFeelings}；命中 ${summary.matchedFeelings}；未命中排除 ${summary.unmatchedFeelings}`);
for (const [action, count] of Object.entries(summary.actions)) console.log(`  ${action}: ${count}`);
console.log(`预计 coarse 候选节省约 ${summary.estimatedSavingsChars} 字符`);

const limit = args.includes("--all") ? Infinity : Math.max(1, Number(value("--limit")) || 100);
const actionFilter = value("--action");
const rows = lifecycle.filter(row => !actionFilter || row.action === actionFilter).slice(0, limit);
for (const row of rows) {
  const flags = [row.eventAnchor && "event", row.retainAnchor && "retain"].filter(Boolean).join(",");
  console.log(`\n${row.sourceDate} ${row.feelingId} [importance ${row.importance}${flags ? `; ${flags}` : ""}] → ${row.action}`);
  console.log(`  ${row.reason}`);
  console.log(`  terms: ${row.matchedTerms.map(term => term.term).join("、")}`);
}
if (rows.length < lifecycle.filter(row => !actionFilter || row.action === actionFilter).length) {
  console.log("\n结果已截断；使用 --all 查看全部，或用 --action 筛选。");
}
console.log("\n只读报告，未修改数据库。主 Agent 确认规则后再调用 compress --apply。");
