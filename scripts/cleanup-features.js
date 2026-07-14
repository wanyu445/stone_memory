#!/usr/bin/env node
const path = require("path");
const { getThreadDir, listThreadIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");

const ONE_TIME_PATTERNS = [/今天/, /昨天/, /刚才/, /刚刚/, /这次/, /那次/, /^\d+月/, /^\d+日/, /星期/, /周[一二三四五六日]/];
const TOO_VAGUE = [/^她容易感到困倦$/, /^她喜欢打王者荣耀$/, /^她玩王者荣耀$/, /^她刷小红书$/, /^她容易熬夜$/];

function ngrams(value, size = 3) {
  const result = new Set();
  for (let i = 0; i <= value.length - size; i++) result.add(value.slice(i, i + size));
  return result;
}

function overlap(a, b) {
  const aa = ngrams(a), bb = ngrams(b);
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const item of aa) if (bb.has(item)) common++;
  return common / new Set([...aa, ...bb]).size;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const index = args.indexOf("--thread");
  const tid = index >= 0 ? args[index + 1] : listThreadIds()[0];
  if (!tid) throw new Error("未指定线程");
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(tid), "memory"), threadId: tid });
  try {
    const rows = store.listFeatures();
    const remove = new Set();
    const kept = [];
    for (const row of rows) {
      if (ONE_TIME_PATTERNS.some(re => re.test(row.content)) || TOO_VAGUE.some(re => re.test(row.content))) { remove.add(row.id); continue; }
      const duplicate = kept.find(item => item.category === row.category && overlap(item.content, row.content) > 0.55);
      if (!duplicate) kept.push(row);
      else if (row.importance > duplicate.importance) { remove.add(duplicate.id); kept.splice(kept.indexOf(duplicate), 1, row); }
      else remove.add(row.id);
    }
    if (!dryRun && remove.size) {
      const del = store.db.prepare("DELETE FROM features WHERE thread_id=? AND id=?");
      store.db.transaction(() => { for (const id of remove) del.run(tid, id); })();
    }
    console.log(`[cleanup-features] ${dryRun ? "would remove" : "removed"} ${remove.size}, kept ${rows.length - remove.size}`);
  } finally { store.close(); }
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
