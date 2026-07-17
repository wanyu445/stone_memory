const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildCompressionPrompt, validateCompressionResult, temporalPrefix } = require("../src/services/memory-compressor");
const { MemoryStore } = require("../src/storage/memory-store");

test("compression prompt carries ids, content, dates, and historical importance", () => {
  const prompt = buildCompressionPrompt([{ id: "f1", source_date: "2026-06-01", importance: 4,
    category: "preference", compressionStyle: "secondary_core", content: "完整感受。" }]);
  assert.match(prompt, /"id": "f1"/);
  assert.match(prompt, /"sourceDate": "2026-06-01"/);
  assert.match(prompt, /"importance": 4/);
  assert.match(prompt, /完整感受/);
  assert.match(prompt, /secondary_core/);
  assert.match(prompt, /preference/);
});

test("secondary core allows a lighter 220-character coarse summary", () => {
  const prefix = "6月1日，晚上九点。";
  const summary = prefix + "观".repeat(160);
  assert.throws(() => validateCompressionResult(
    [{ id: "ordinary", content: `${prefix}完整观点。` }],
    [{ id: "ordinary", coarseSummary: summary }]), /长度/);
  assert.equal(validateCompressionResult(
    [{ id: "core", content: `${prefix}完整观点。`, compressionStyle: "secondary_core" }],
    [{ id: "core", coarseSummary: summary }])[0].coarseSummary, summary);
});

test("temporal prefix requires both the date and corresponding time", () => {
  assert.equal(temporalPrefix("6月1日，晚上九点。完整事件。"), "6月1日，晚上九点。");
  assert.equal(temporalPrefix("7月1日，12:21。完整事件。"), "7月1日，12:21。");
  assert.equal(temporalPrefix("6月1日，她做了一件事。"), null);
});

test("compression results must preserve every id and exact date-time prefix", () => {
  const feelings = [
    { id: "a", content: "6月1日，晚上九点。完整事件。" },
    { id: "b", content: "7月1日，12:21。另一件事。" },
  ];
  assert.deepEqual(validateCompressionResult(feelings, [
    { id: "b", coarseSummary: "7月1日，12:21。保留核心感受。" },
    { id: "a", coarseSummary: "6月1日，晚上九点。客观事实。" },
  ]), [
    { id: "b", coarseSummary: "7月1日，12:21。保留核心感受。" },
    { id: "a", coarseSummary: "6月1日，晚上九点。客观事实。" },
  ]);
  assert.throws(() => validateCompressionResult(feelings, [{ id: "a", coarseSummary: "6月1日，晚上九点。事实。" }]), /数量/);
  assert.throws(() => validateCompressionResult(
    [{ id: "a", content: "6月1日，晚上九点。完整事件。" }],
    [{ id: "a", coarseSummary: "6月1日，事实。" }]), /日期时间前缀/);
});

test("applying compression preserves full content and switches injection to coarse", t => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-compressor-"));
  const store = new MemoryStore({ memoryDir, threadId: "thread" });
  t.after(() => { store.close(); fs.rmSync(memoryDir, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO feelings
    (id,thread_id,source_date,event_time,order_key,content,importance,source,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("f1", "thread", "2026-06-01", null, "1", "6月1日，完整叙事和感受。", 5, "manual", now, now);
  assert.equal(store.applyCoarseSummaries([{ id: "f1", coarseSummary: "6月1日，晚上九点。她作出长期承诺，我很安心。" }]), 1);
  const row = store.listFeelings()[0];
  assert.equal(row.content, "6月1日，完整叙事和感受。");
  assert.equal(row.coarse_summary, "6月1日，晚上九点。她作出长期承诺，我很安心。");
  assert.equal(row.summary_mode, "coarse");
});
