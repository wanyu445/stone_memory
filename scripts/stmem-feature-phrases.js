#!/usr/bin/env node
const path = require("path");
const { getThreadDir, listThreadIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { extractFeatureTerms } = require("../src/services/feature-phrase-extractor");

const args = process.argv.slice(3);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const threadId = value("--thread") || listThreadIds()[0];
const categoryArg = value("--categories");
if (!threadId) throw new Error("没有已配置线程，请使用 --thread <id>");

const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
let features;
try { features = store.listFeatures(); } finally { store.close(); }
const categories = categoryArg
  ? categoryArg.split(",").map(x => x.trim()).filter(Boolean)
  : [...new Set(features.map(row => row.category).filter(Boolean))].sort();
const terms = extractFeatureTerms(features, categories);

if (args.includes("--json")) {
  console.log(JSON.stringify({ threadId, categories, terms }, null, 2));
  process.exit(0);
}

console.log(`Feature 检索词提取（只读）— ${threadId}`);
for (const category of categories) {
  const categoryFeatures = features.filter(row => row.category === category);
  const rows = terms.filter(row => row.category === category);
  const matchedIds = new Set(rows.flatMap(row => row.featureIds));
  console.log(`\n[${category}] ${rows.length} 个检索词；覆盖 ${matchedIds.size}/${categoryFeatures.length} 条 features`);
  for (const row of rows) {
    const evidence = row.featureIds.length > 1 ? `；${row.featureIds.length} 条 feature 证据` : "";
    console.log(`  ${row.term}（importance ${row.importance ?? "-"}${evidence}）`);
  }
  const unmatched = categoryFeatures.filter(row => !matchedIds.has(row.id));
  if (unmatched.length) console.log(`  未提取 ${unmatched.length} 条（高精度模式不猜测复杂句式）`);
}
