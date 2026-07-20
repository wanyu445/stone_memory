#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getThreadDir, listThreadIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { buildHiddenPlan } = require("../src/services/hidden-plan");

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };

function main() {
  const threadId = value("--thread") || listThreadIds()[0];
  if (!threadId) throw new Error("没有已配置线程，请使用 --thread <id>");
  const afterDays = Math.max(1, Number(value("--after-days")) || 90);
  const apply = args.includes("--apply");
  const json = args.includes("--json");
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const store = new MemoryStore({ memoryDir, threadId });
  try {
    let anchors = { retain: {}, eventAnchors: {} };
    try { anchors = JSON.parse(fs.readFileSync(path.join(memoryDir, "retain-config.json"), "utf8")); } catch {}
    const plan = buildHiddenPlan({ features: store.listFeatures(), feelings: store.listFeelings(),
      messages: store.listMessages(), anchors, afterDays });
    const candidates = plan.decisions.filter(row => row.action === "hide");
    const updated = apply ? store.applyHiddenFeelings(candidates.map(row => row.feelingId)) : 0;
    const report = { threadId, apply, referenceDate: plan.referenceDate, afterDays,
      primaryCategory: plan.primaryCategory, secondaryCategory: plan.secondaryCategory,
      coarseFeelings: plan.decisions.length, candidates: candidates.length, updated,
      examples: candidates.slice(0, 10) };
    if (json) return console.log(JSON.stringify(report, null, 2));
    console.log(`Hidden ${apply ? "执行" : "dry-run"} — ${threadId}`);
    console.log(`参考日期 ${report.referenceDate || "无"}；沉寂阈值 ${afterDays} 天；副核心 ${report.secondaryCategory || "无"}`);
    console.log(`coarse ${report.coarseFeelings} 条；hidden 候选 ${report.candidates} 条${apply ? `；已更新 ${updated} 条` : ""}`);
    for (const row of report.examples) console.log(`  ${row.sourceDate} [${row.importance}] ${row.coreTerms.join("+")}：${row.reason}\n    ${row.content}`);
    if (!apply) console.log("未修改数据库；确认后添加 --apply。");
  } finally { store.close(); }
}

try { main(); } catch (error) { console.error(error.stack || error.message); process.exit(1); }
