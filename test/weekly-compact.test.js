const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { rankCompressionWeeks, measureInjectedCharacters, estimateWeekCharacters } = require("../src/services/weekly-compact");
const { MemoryStore } = require("../src/storage/memory-store");

test("ranks stable seven-day buckets by compressible character ratio, saving, then age", () => {
  const feelings = [
    { id: "anchor", source_date: "2026-06-01", content: "x" },
    { id: "a-coarse", source_date: "2026-06-02", content: "a".repeat(80) },
    { id: "a-keep", source_date: "2026-06-03", content: "k".repeat(20) },
    { id: "b-coarse", source_date: "2026-06-09", content: "b".repeat(90) },
    { id: "b-keep", source_date: "2026-06-10", content: "k".repeat(10) },
    { id: "c-coarse", source_date: "2026-06-16", content: "c".repeat(90) },
    { id: "c-keep", source_date: "2026-06-17", content: "k".repeat(10) },
  ];
  const decisions = feelings.slice(1).map(row => ({
    feelingId: row.id, sourceDate: row.source_date, content: row.content,
    action: row.id.endsWith("keep") ? "keep_daily" : "compress_coarse",
    route: row.id === "c-keep" ? "anchor" : "fact",
  }));
  const ranked = rankCompressionWeeks(decisions, feelings, 7, 0.5);
  assert.deepEqual(ranked.map(row => row.from), ["2026-06-08", "2026-06-15", "2026-06-01"]);
  assert.equal(ranked[0].compressibleRatio, 0.9);
  assert.equal(ranked[0].estimatedSaving, 45);
  assert.equal(ranked[1].anchorCharacters, 10);
});

test("week boundaries stay anchored to full history after an older feeling becomes coarse", () => {
  const feelings = [
    { id: "old", source_date: "2026-04-15", summary_mode: "coarse", content: "old" },
    { id: "next", source_date: "2026-04-16", summary_mode: "daily", content: "next" },
    { id: "later", source_date: "2026-04-22", summary_mode: "daily", content: "later" },
  ];
  const ranked = rankCompressionWeeks([
    { feelingId: "next", sourceDate: "2026-04-16", content: "next", action: "compress_coarse" },
    { feelingId: "later", sourceDate: "2026-04-22", content: "later", action: "compress_coarse" },
  ], feelings);
  assert.deepEqual(ranked.map(row => [row.from, row.to]), [
    ["2026-04-15", "2026-04-21"], ["2026-04-22", "2026-04-28"],
  ]);
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
    { id: "a", coarseSummary: "short a", coreTerms: ["项目甲"] },
    { id: "b", coarseSummary: "short b", coreTerms: ["项目乙"] },
  ]), /原子写入失败/);
  assert.equal(store.db.prepare("SELECT summary_mode FROM feelings WHERE id='a'").get().summary_mode, "daily");
  store.close();
});
