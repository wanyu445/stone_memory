const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryStore } = require("../src/storage/memory-store");
const { readFeelings } = require("../src/storage/memory-reader");
const { loadTieredFeelings } = require("../src/services/thread-rebuilder");

test("SQLite reader applies daily, coarse, and hidden modes without destroying full content", t => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-reader-"));
  const store = new MemoryStore({ memoryDir, threadId: "thread-test" });
  t.after(() => { store.close(); fs.rmSync(memoryDir, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const insert = store.db.prepare(`INSERT INTO feelings
    (id,thread_id,source_date,event_time,order_key,content,importance,source,created_at,updated_at,summary_mode,coarse_summary)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run("daily", "thread-test", "2026-06-10", null, "1", "6月10日，完整日摘要。", 3, "manual", now, now, "daily", null);
  insert.run("coarse", "thread-test", "2026-06-11", null, "2", "6月11日，带感受的完整摘要。", 3, "manual", now, now, "coarse", "发生了一件事。");
  insert.run("hidden", "thread-test", "2026-06-12", null, "3", "6月12日，隐藏但仍保留。", 3, "manual", now, now, "hidden", null);

  const all = readFeelings(memoryDir, { threadId: "thread-test" });
  assert.deepEqual(all.map(row => row.fullContent), ["6月10日，完整日摘要。", "6月11日，带感受的完整摘要。", "6月12日，隐藏但仍保留。"]);
  const injected = readFeelings(memoryDir, { threadId: "thread-test", forInjection: true });
  assert.deepEqual(injected.map(row => [row.id, row.content]), [
    ["daily", "6月10日，完整日摘要。"],
    ["coarse", "6月11日，发生了一件事。"],
  ]);

  const rebuilt = loadTieredFeelings(memoryDir, "thread-test");
  assert.deepEqual(rebuilt.map(row => row.id), ["daily", "coarse"]);
});
