#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getThreadDir, listThreadIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { extractFeatureTerms, normalizeTerm } = require("../src/services/feature-phrase-extractor");
const { readUserArchive } = require("../src/services/feature-term-evidence");
const { buildTermTimeline, buildCooccurrenceSignatures } = require("../src/services/term-timeline");
const { buildRelationLifecycles } = require("../src/services/relation-lifecycle");
const { findRelationSignaturePeers } = require("../src/services/relation-signature-context");
const { buildRelationCompressionPlan, summarizeRelationCompressionPlan } = require("../src/services/relation-compression-plan");
const { buildWorkLifecycles } = require("../src/services/work-lifecycle");
const { buildWorkCompressionPlan, summarizeWorkCompressionPlan } = require("../src/services/work-compression-plan");
const { updateTermEvidenceCache } = require("../src/services/term-evidence-cache");

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const threadId = value("--thread") || listThreadIds()[0];
const requestedTerms = (value("--terms") || "").split(",").map(term => term.trim()).filter(Boolean);
if (!threadId) throw new Error("没有已配置线程，请使用 --thread <id>");
if (!requestedTerms.length) throw new Error("请使用 --terms 词1,词2 指定要查看的词");
const memoryDir = path.join(getThreadDir(threadId), "memory");
const store = new MemoryStore({ memoryDir, threadId });
const features = store.listFeatures();
const feelings = store.listFeelings();
let anchors = { retain: {}, eventAnchors: {} };
try { anchors = JSON.parse(fs.readFileSync(path.join(memoryDir, "retain-config.json"), "utf8")); } catch {}
let messages = store.listMessages().filter(row => row.type === "user")
  .map(row => ({ date: row.sourceDate, timestamp: row.timestamp, text: row.text }));
if (!messages.length) messages = readUserArchive(path.join(memoryDir, "archive"));
const from = value("--from");
const to = value("--to");
const extractedTerms = extractFeatureTerms(features);
updateTermEvidenceCache({ store, terms: requestedTerms });
const dailyStats = store.listTermDailyStats(requestedTerms.map(normalizeTerm), { from, to });
store.close();
const report = buildTermTimeline({
  requestedTerms,
  extractedTerms,
  feelings,
  messages,
  dailyStats,
  anchors,
  from,
  to,
});
const intersections = buildCooccurrenceSignatures({ termTimelines: report, messages, feelings, anchors, from, to });
const signaturePeers = findRelationSignaturePeers({ requestedTerms, extractedTerms, feelings });
const requestedNormalized = new Set(requestedTerms.map(normalizeTerm));
const auxiliaryTerms = signaturePeers.filter(row => !requestedNormalized.has(row.normalizedTerm)).map(row => row.term);
const auxiliaryTimelines = auxiliaryTerms.length ? buildTermTimeline({
  // 辅助词只用于 feelings 共同签名资格，不构建 archive 词频曲线。
  requestedTerms: auxiliaryTerms, extractedTerms, feelings, messages: [], anchors, from, to,
}) : [];
const relationTimelines = [...report, ...auxiliaryTimelines];
const relationIntersections = buildCooccurrenceSignatures({
  // 辅助词只为补全摘要共同签名；不重复扫描 archive 的局部消息窗口。
  // 用户显式查询词的同消息证据仍由上方 intersections 完整计算。
  termTimelines: relationTimelines, messages: [], feelings, anchors, from, to,
});
const relation = buildRelationLifecycles({ termTimelines: relationTimelines, intersections: relationIntersections });
relation.analysisPeers = signaturePeers;
relation.compressionPlan = buildRelationCompressionPlan({ relation, termTimelines: relationTimelines, anchors });
relation.compressionSummary = summarizeRelationCompressionPlan(relation.compressionPlan);
const work = buildWorkLifecycles({ termTimelines: report, intersections });
work.compressionPlan = buildWorkCompressionPlan({
  work, termTimelines: report,
  relationFeelingIds: relation.compressionPlan.filter(row => row.takeover).map(row => row.feelingId), anchors,
});
work.compressionSummary = summarizeWorkCompressionPlan(work.compressionPlan);

if (args.includes("--json")) {
  fs.writeFileSync(1, `${JSON.stringify({ threadId, report, intersections, relation, work }, null, 2)}\n`);
  process.exit(0);
}

console.log(`Term 时间轴（archive 用户消息 + feeling 小点，只读）— ${threadId}`);
const feelingLimit = args.includes("--all") ? Infinity : Math.max(1, Number(value("--feeling-limit")) || 20);
for (const row of report) {
  console.log(`\n[${row.term}] categories=${row.categories.join(",") || "未进入 feature terms"}`);
  console.log(`范围 ${row.from || "-"} ~ ${row.to || "-"}；消息 ${row.messageCount}；出现 ${row.occurrenceCount} 次；活跃 ${row.activeDays} 天；feelings ${row.feelings.length}`);
  console.log(`基线 日均=${format(row.baseline.calendarDailyMean)}；活跃日均=${format(row.baseline.activeDailyMean)}；活跃日占比=${format(row.baseline.activeDayRatio * 100)}%`);
  const active = row.timeline.filter(point => point.messageCount > 0);
  console.log(`曲线非零点: ${active.map(point => `${point.date}:${point.occurrenceCount}`).join("  ") || "无"}`);
  console.log("Feeling 小点:");
  for (const feeling of row.feelings.slice(0, feelingLimit)) {
    const flags = [feeling.retainAnchor && "retain", feeling.eventAnchor && "event"].filter(Boolean).join(",");
    console.log(`  ${feeling.sourceDate} ${feeling.id} [importance ${feeling.importance}${flags ? `; ${flags}` : ""}] ${feeling.content}`);
  }
  if (row.feelings.length > feelingLimit) console.log(`  …另有 ${row.feelings.length - feelingLimit} 条，使用 --all 查看`);
}

for (const intersection of intersections) {
  console.log(`\n[共现 ${intersection.terms.join(" + ")}] 同日=${intersection.sameDays.length}；同消息=${intersection.sameMessages.length}；同 feeling=${intersection.sameFeelings.length}`);
  for (const feeling of intersection.sameFeelings.slice(0, feelingLimit)) {
    const flags = [feeling.retainAnchor && "retain", feeling.eventAnchor && "event"].filter(Boolean).join(",");
    console.log(`  ${feeling.sourceDate} ${feeling.id} [importance ${feeling.importance}${flags ? `; ${flags}` : ""}] ${feeling.content}`);
  }
  if (intersection.sameFeelings.length > feelingLimit) console.log(`  …另有 ${intersection.sameFeelings.length - feelingLimit} 条 feeling，使用 --all 查看`);
}

for (const lifecycle of relation.terms) {
  console.log(`\n[Relation ${lifecycle.term}] ${lifecycle.state}/${lifecycle.shape}；confidence=${lifecycle.confidence}${lifecycle.inferredRelation ? "；relation=共现推断" : ""}`);
  console.log(`  ${lifecycle.reasons.join("；")}`);
  const positions = Object.entries(lifecycle.feelingPoints.reduce((counts, point) => {
    counts[point.position] = (counts[point.position] || 0) + 1;
    return counts;
  }, {})).map(([position, count]) => `${position}=${count}`).join("；");
  if (positions) console.log(`  feeling位置: ${positions}`);
}
for (const pair of relation.pairs) {
  console.log(`\n[Relation 配对 ${pair.terms.join(" ↔ ")}] ${pair.state}/${pair.shape}`);
  console.log(`  同日=${pair.evidence.sameDays}；同消息=${pair.evidence.sameMessages}；同 feeling=${pair.evidence.sameFeelings}；跨度=${pair.evidence.spanDays} 天`);
}
if (relation.compressionPlan.length) {
  console.log(`\n[Relation 压缩计划] ${Object.entries(relation.compressionSummary.actions).map(([action, count]) => `${action}=${count}`).join("；")}`);
  for (const row of relation.compressionPlan.filter(item => item.action !== "compress_coarse").slice(0, feelingLimit)) {
    console.log(`  ${row.sourceDate} ${row.feelingId} [importance ${row.importance}] → ${row.action}：${row.reason}`);
  }
}
for (const project of work.groups) {
  console.log(`\n[Work 项目 ${project.id}] ${project.state}/${project.shape}；${project.firstSeen || "-"} ~ ${project.lastSeen || "-"}`);
  console.log(`  members: ${project.members.map(row => row.term).join(" → ")}`);
  console.log(`  活跃 ${project.activeDays} 天；连接证据 ${project.links.length} 条`);
}
if (work.compressionPlan.length) {
  console.log(`\n[Work 压缩计划] ${Object.entries(work.compressionSummary.actions).map(([action, count]) => `${action}=${count}`).join("；")}`);
}

function format(value) {
  return Number(value || 0).toFixed(2);
}
