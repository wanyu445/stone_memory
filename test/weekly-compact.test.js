const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { selectEarliestWeek, measureInjectedCharacters, estimateWeekCharacters } = require("../src/services/weekly-compact");
const { MemoryStore } = require("../src/storage/memory-store");

test("earliest week starts at first compressible feeling and includes seven calendar days", () => {
  const week = selectEarliestWeek([
    { feelingId: "kept-old", sourceDate: "2026-06-01", action: "keep_daily" },
    { feelingId: "first", sourceDate: "2026-06-10", action: "compress_coarse" },
    { feelingId: "kept", sourceDate: "2026-06-12", action: "keep_daily" },
    { feelingId: "later", sourceDate: "2026-06-17", action: "compress_coarse" },
  ]);
  assert.equal(week.from, "2026-06-10");
  assert.equal(week.to, "2026-06-16");
  assert.deepEqual(week.decisions.map(row => row.feelingId), ["first", "kept"]);
  assert.deepEqual(week.coarse.map(row => row.feelingId), ["first"]);
});

test("character measurement uses the currently injected representation", () => {
  const feelings = [
    { summary_mode: "daily", content: "12345" },
    { summary_mode: "coarse", content: "long original", coarse_summary: "123" },
    { summary_mode: "hidden", content: "ignored" },
  ];
  assert.equal(measureInjectedCharacters(feelings), 8);
  const estimate = estimateWeekCharacters({ decisions: [
    { feelingId: "a", action: "compress_coarse" }, { feelingId: "b", action: "keep_daily" },
  ] }, [{ id: "a", content: "1234567890" }, { id: "b", content: "1234" }], 0.5);
  assert.deepEqual(estimate, { before: 14, estimatedAfter: 9, estimatedSaving: 5 });
});

test("whole-week coarse writes roll back when any feeling is no longer daily", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-week-"));
  const store = new MemoryStore({ memoryDir: root, threadId: "t" });
  const now = new Date().toISOString();
  const insert = store.db.prepare(`INSERT INTO feelings
    (id,thread_id,source_date,event_time,order_key,content,summary_mode,importance,source,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run("a", "t", "2026-07-01", null, "1", "full a", "daily", 2, "manual", now, now);
  insert.run("b", "t", "2026-07-02", null, "2", "full b", "coarse", 2, "manual", now, now);
  assert.throws(() => store.applyCoarseWeek([
    { id: "a", coarseSummary: "short a" }, { id: "b", coarseSummary: "short b" },
  ]), /原子写入失败/);
  assert.equal(store.db.prepare("SELECT summary_mode FROM feelings WHERE id='a'").get().summary_mode, "daily");
  store.close();
});
