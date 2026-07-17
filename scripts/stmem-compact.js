#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getThreadDir, listThreadIds, loadConfig } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { MemoryCompressor } = require("../src/services/memory-compressor");
const { buildCompressionPlan } = require("../src/services/compression-planner");
const { rankCompressionWeeks, measureInjectedCharacters, estimateWeekCharacters } = require("../src/services/weekly-compact");

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };

async function main() {
  const threadId = value("--thread") || listThreadIds()[0];
  if (!threadId) throw new Error("没有已配置线程，请使用 --thread <id>");
  const apply = args.includes("--apply");
  const automatic = args.includes("--auto");
  const json = args.includes("--json");
  const weekDays = positiveNumber(value("--week-days"), 7);
  const maxWeeks = automatic ? Infinity : positiveNumber(value("--weeks"), 1);
  const maxChars = optionalNumber(value("--max-chars"));
  const stopChars = optionalNumber(value("--stop-chars")) ?? maxChars;
  if (automatic && (!apply || maxChars == null || stopChars == null)) {
    throw new Error("--auto 需要同时提供 --apply、--max-chars 和可选的 --stop-chars");
  }
  if (maxChars != null && stopChars != null && stopChars > maxChars) {
    throw new Error("--stop-chars 不能高于 --max-chars");
  }

  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const store = new MemoryStore({ memoryDir, threadId });
  const compressor = apply ? new MemoryCompressor({ threadId, apiConfig: resolveApiConfig(threadId) }) : null;
  const reports = [];
  try {
    let currentChars = measureInjectedCharacters(store.listFeelings());
    if (automatic && currentChars <= maxChars) return print({ threadId, apply, automatic, currentChars, reports }, json);

    for (let count = 0; count < maxWeeks; count++) {
      const context = buildLatestPlan(store, memoryDir);
      const rankedWeeks = rankCompressionWeeks(context.plan.decisions, context.feelings, weekDays);
      const week = rankedWeeks[0];
      if (!week) break;
      const estimate = estimateWeekCharacters(week, context.feelings);
      const report = {
        from: week.from,
        to: week.to,
        candidates: week.decisions.length,
        keep: week.keep.length,
        coarse: week.coarse.length,
        routes: countBy(week.decisions, "route"),
        rank: week.rank,
        eligibleWeeks: rankedWeeks.length,
        totalCharacters: week.totalCharacters,
        coarseCharacters: week.coarseCharacters,
        keepCharacters: week.keepCharacters,
        anchorCharacters: week.anchorCharacters,
        compressibleRatio: week.compressibleRatio,
        candidateTerms: context.plan.candidateTerms,
        allDailyDecisions: context.plan.summary,
        keepExamples: week.keep.slice(0, 5).map(decisionExample),
        coarseExamples: week.coarse.slice(0, 5).map(decisionExample),
        beforeChars: currentChars,
        windowCharacters: estimate,
        applied: false,
      };
      reports.push(report);
      if (!apply) break;

      // 所有模型调用先完成；只有结果齐全后才开启单个数据库事务。
      const coarseFeelings = week.coarse.map(row => context.feelingsById.get(row.feelingId));
      const results = await compressInBatches(compressor, coarseFeelings, positiveNumber(value("--batch-size"), 20));
      report.updated = store.applyCoarseWeek(results);
      report.applied = true;
      currentChars = measureInjectedCharacters(store.listFeelings());
      report.afterChars = currentChars;
      report.actualSaving = report.beforeChars - currentChars;
      if (automatic && currentChars <= stopChars) break;
    }
    print({ threadId, apply, automatic, currentChars, reports }, json);
  } finally {
    store.close();
  }
}

function buildLatestPlan(store, memoryDir) {
  const features = store.listFeatures();
  const feelings = store.listFeelings();
  let anchors = { retain: {}, eventAnchors: {} };
  try { anchors = JSON.parse(fs.readFileSync(path.join(memoryDir, "retain-config.json"), "utf8")); } catch {}
  // Planner 内部只用 daily feelings 反筛 term；历史 coarse feelings 仍作为完整曲线证据。
  // archive 逐日词频供前端展示，不参与 relation/work 生命周期拟合。
  const plan = buildCompressionPlan({ features, feelings, messages: [], anchors });
  return { feelings, feelingsById: new Map(feelings.map(row => [row.id, row])), plan };
}

async function compressInBatches(compressor, feelings, batchSize) {
  const results = [];
  for (let index = 0; index < feelings.length; index += batchSize) {
    results.push(...await compressor.compress(feelings.slice(index, index + batchSize)));
  }
  if (results.length !== feelings.length) throw new Error("整周压缩结果数量不完整，已取消写入");
  return results;
}

function resolveApiConfig(threadId) {
  if (args.includes("--subagent")) return {};
  const config = loadConfig();
  const thread = config[threadId] || {};
  const mode = args.includes("--api") ? "api" : (thread.minerMode || "subagent");
  if (mode !== "api") return {};
  const provider = thread.apiProvider || "deepseek";
  const credentials = config.apiKeys?.[provider];
  if (!credentials?.key) {
    if (args.includes("--api")) throw new Error(`未找到 ${provider} API key`);
    return {};
  }
  return { apiKey: credentials.key, baseUrl: credentials.baseUrl, model: credentials.model };
}

function print(result, json) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  console.log(`周级 Compact ${result.apply ? "执行" : "dry-run"} — ${result.threadId}`);
  console.log(`当前可注入字符量：${result.currentChars}`);
  if (!result.reports.length) return console.log("没有需要 coarse 的 daily feelings，或尚未超过自动触发阈值。");
  for (const row of result.reports) {
    console.log(`\n${row.from} ~ ${row.to}：候选周排名 ${row.rank}/${row.eligibleWeeks}，keep ${row.keep}，coarse ${row.coarse}`);
    console.log(`  可压缩字符占比：${(row.compressibleRatio * 100).toFixed(1)}%（${row.coarseCharacters}/${row.totalCharacters}），锚点字符 ${row.anchorCharacters}`);
    console.log(`  摘要反筛后进入拟合的 term：${row.candidateTerms}`);
    console.log(`  路由：${Object.entries(row.routes).map(([key, count]) => `${key}=${count}`).join("；")}`);
    console.log(`  窗口字符：${row.windowCharacters.before} → 预计 ${row.windowCharacters.estimatedAfter}`);
    console.log("  keep 示例:");
    for (const item of row.keepExamples) console.log(`    ${item.sourceDate} [${item.route}/${item.importance}] ${item.content}`);
    console.log("  coarse 示例:");
    for (const item of row.coarseExamples) console.log(`    ${item.sourceDate} [${item.route}/${item.importance}] ${item.content}`);
    if (row.applied) console.log(`  已原子更新 ${row.updated} 条；总量 ${row.beforeChars} → ${row.afterChars}（减少 ${row.actualSaving}）`);
  }
  if (!result.apply) console.log("\n未调用模型、未修改数据库；确认后添加 --apply。");
}

function countBy(rows, key) {
  return rows.reduce((counts, row) => ((counts[row[key]] = (counts[row[key]] || 0) + 1), counts), {});
}

function decisionExample(row) {
  return { feelingId: row.feelingId, sourceDate: row.sourceDate, route: row.route,
    importance: row.importance, reason: row.reason, content: row.content };
}

function positiveNumber(raw, fallback) {
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function optionalNumber(raw) {
  if (raw == null) return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) throw new Error(`无效数值: ${raw}`);
  return Math.floor(number);
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
