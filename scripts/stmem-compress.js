#!/usr/bin/env node
const path = require("path");
const { MemoryCompressor } = require("../src/services/memory-compressor");
const { MemoryStore } = require("../src/storage/memory-store");
const { getThreadDir, listThreadIds, loadConfig } = require("../src/config");

function resolveApiConfig(threadId, forceApi, forceSubagent) {
  if (forceSubagent) return {};
  const config = loadConfig();
  const thread = config[threadId] || {};
  const mode = forceApi ? "api" : (thread.minerMode || "subagent");
  if (mode !== "api") return {};
  const provider = thread.apiProvider || "deepseek";
  const credentials = config.apiKeys?.[provider];
  if (!credentials?.key) {
    if (forceApi) throw new Error(`未找到 ${provider} API key`);
    console.warn(`[stmem] 未找到 ${provider} API key，回退 subagent`);
    return {};
  }
  return {
    apiKey: credentials.key,
    baseUrl: credentials.baseUrl || "https://api.deepseek.com",
    model: credentials.model || "deepseek-chat",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  const threadId = value("--thread") || listThreadIds()[0];
  if (!threadId) throw new Error("未指定线程，请用 --thread <id> 或先 stmem init");
  const apply = args.includes("--apply");
  const json = args.includes("--json");
  const before = value("--before");
  const ids = value("--ids")?.split(",").map(id => id.trim()).filter(Boolean) || [];
  const all = args.includes("--all");
  const limit = all ? Infinity : Math.max(1, Number(value("--limit")) || 20);
  const batchSize = Math.max(1, Math.min(50, Number(value("--batch-size")) || 20));
  if (apply && !before && !ids.length && !all) {
    throw new Error("--apply 必须同时指定 --before、--ids 或 --all，避免误压缩默认候选");
  }
  const apiConfig = resolveApiConfig(threadId, args.includes("--api"), args.includes("--subagent"));
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const store = new MemoryStore({ memoryDir, threadId });
  let candidates;
  try {
    const idSet = new Set(ids);
    candidates = store.listFeelings().filter(row =>
      row.summary_mode === "daily"
      && (!before || row.source_date < before)
      && (!idSet.size || idSet.has(row.id)))
      .slice(0, limit);
  } finally {
    if (!candidates?.length) store.close();
  }
  if (!candidates.length) {
    if (json) console.log(JSON.stringify({ threadId, apply, candidates: [], results: [] }, null, 2));
    else console.log("没有符合条件的 daily feelings");
    return;
  }

  const compressor = new MemoryCompressor({ threadId, apiConfig });
  const results = [];
  try {
    for (let index = 0; index < candidates.length; index += batchSize) {
      results.push(...await compressor.compress(candidates.slice(index, index + batchSize)));
    }
    const updated = apply ? store.applyCoarseSummaries(results) : 0;
    if (json) {
      console.log(JSON.stringify({ threadId, mode: apiConfig.apiKey ? "api" : "subagent", apply, updated, candidates, results }, null, 2));
    } else {
      console.log(`Feeling 压缩 ${apply ? "已应用" : "dry-run"} — ${threadId}（${apiConfig.apiKey ? "api" : "subagent"}）`);
      for (const row of candidates) {
        const result = results.find(item => item.id === row.id);
        console.log(`\n${row.source_date} ${row.id} [importance ${row.importance}]`);
        console.log(`  原文: ${row.content}`);
        console.log(`  压缩: ${result.coarseSummary}`);
      }
      if (!apply) console.log("\n未修改数据库；确认后加 --apply。");
      else console.log(`\n已更新 ${updated} 条 feelings 为 coarse。`);
    }
  } finally {
    store.close();
  }
}

main().catch(error => { console.error(error.message); process.exit(1); });
