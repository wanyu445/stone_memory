#!/usr/bin/env node
/**
 * 特征库清洗脚本 — 去重、去一次性事件、合并相似条目。
 * 每天 miner 跑完之后执行。
 *
 * 用法:
 *   node scripts/cleanup-features.js --thread <id>           # 清洗指定线程
 *   node scripts/cleanup-features.js --thread <id> --dry-run # 只看不改
 */

const fs = require("fs");
const path = require("path");
const { getThreadDir, listThreadIds } = require("../src/config");

// 一次性事件的标志词 — 含这些的条目直接删除
const ONE_TIME_PATTERNS = [
  /今天/, /昨天/, /刚才/, /刚刚/, /这次/, /那次/,
  /^\d+月/, /^\d+日/, /星期/, /周[一二三四五六日]/,
  /洗了澡$/, /洗了头$/, /睡了觉$/,
  /吃了.*作为/, /点了.*外卖/,
  /^她[早上中午晚上].*吃了?/,
  /^她[点数]了.*(?:作为|当)/,
];

// 太短/太泛 — 没啥用的
const TOO_VAGUE = [
  /^她容易感到困倦$/,
  /^她喜欢打王者荣耀$/,
  /^她玩王者荣耀$/,
  /^她刷小红书$/,
  /^她希望今晚睡好觉$/,
  /^她昨晚没睡好$/,
  /^她作息不自律$/,
  /^她容易熬夜$/,
];

function isOneTimeEvent(content) {
  return ONE_TIME_PATTERNS.some((p) => p.test(content));
}

function isTooVague(content) {
  return TOO_VAGUE.some((p) => p.test(content));
}

// 余弦相似度 — 用向量做语义去重
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// 字符级 n-gram 兜底（向量不可用或太短）
function textOverlap(a, b) {
  function ngrams(s, n) {
    const set = new Set();
    for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
    return set;
  }
  const aGrams = ngrams(a, 3);
  const bGrams = ngrams(b, 3);
  if (!aGrams.size || !bGrams.size) return 0;
  let overlap = 0;
  for (const g of aGrams) { if (bGrams.has(g)) overlap++; }
  const union = new Set([...aGrams, ...bGrams]);
  return overlap / union.size;
}

function isSemanticDuplicate(a, b) {
  // 优先用向量
  if (a.vector && b.vector && a.vector.length > 10 && b.vector.length > 10) {
    return cosineSimilarity(a.vector, b.vector) > 0.85;
  }
  // 兜底用文本
  return textOverlap(a.content, b.content) > 0.55;
}

function cleanupCategory(filePath, dryRun) {
  const entries = [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
  } catch { return { removed: 0, merged: 0 }; }

  const catName = path.basename(filePath, ".jsonl");
  let removed = 0;
  let merged = 0;

  // Step 1: 删除一次性事件和太泛的
  const afterFilter = entries.filter((e) => {
    if (isOneTimeEvent(e.content)) {
      console.log(`  [remove one-time] [${catName}] ${e.content}`);
      removed++;
      return false;
    }
    if (isTooVague(e.content)) {
      console.log(`  [remove vague] [${catName}] ${e.content}`);
      removed++;
      return false;
    }
    return true;
  });

  // Step 2: 向量去重 — 相似度 > 0.85 的合并
  const deduped = [];
  for (const e of afterFilter) {
    let found = false;
    for (const existing of deduped) {
      if (isSemanticDuplicate(e, existing)) {
        // 合并：保留 importance 更高的
        if (e.importance > existing.importance) {
          existing.content = e.content;
          existing.importance = e.importance;
          console.log(`  [merge] [${catName}] "${existing.content.slice(0, 50)}..." ← higher importance`);
        } else {
          console.log(`  [merge] [${catName}] "${e.content.slice(0, 50)}..." (dup of existing)`);
        }
        merged++;
        found = true;
        break;
      }
    }
    if (!found) deduped.push(e);
  }

  // Step 3: 按重要性降序排列
  deduped.sort((a, b) => (b.importance || 0) - (a.importance || 0));

  // Step 4: 更新 id 和 createdAt（被合并/删除的不保留）
  const now = new Date().toISOString();
  for (const e of deduped) {
    if (!e.id || !e.createdAt) {
      e.id = e.id || `feat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      e.createdAt = e.createdAt || now;
    }
    e.accessedAt = e.accessedAt || now;
  }

  if (!dryRun) {
    const lines = deduped.map((e) => JSON.stringify(e) + "\n").join("");
    fs.writeFileSync(filePath, lines, "utf8");
  }

  return { removed, merged, kept: deduped.length };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const threadIdx = args.indexOf("--thread");
  const tid = threadIdx >= 0 ? args[threadIdx + 1] : listThreadIds()[0];
  if (!tid) { console.error("未指定线程，请用 --thread <id> 或先 stmem init"); process.exit(1); }

  const featuresDir = path.join(getThreadDir(tid), "memory", "mined", "features");

  if (dryRun) console.log(`[cleanup-features] DRY RUN [${tid}]\n`);
  else console.log(`[cleanup-features] cleaning [${tid}]...\n`);

  if (!fs.existsSync(featuresDir)) {
    console.log("No features directory yet.");
    return;
  }

  const files = fs.readdirSync(featuresDir).filter((f) => f.endsWith(".jsonl")).sort();
  let totalRemoved = 0, totalMerged = 0, totalKept = 0;

  for (const f of files) {
    const filePath = path.join(featuresDir, f);
    const { removed, merged, kept } = cleanupCategory(filePath, dryRun);
    totalRemoved += removed;
    totalMerged += merged;
    totalKept += kept;
    if (removed + merged > 0) {
      console.log(`  ${f}: ${kept} kept, ${removed} removed, ${merged} merged`);
    }
  }

  console.log(`\n[cleanup-features] ${dryRun ? "DRY RUN — would " : ""}remove ${totalRemoved}, merge ${totalMerged}, keep ${totalKept}`);
}

main();
