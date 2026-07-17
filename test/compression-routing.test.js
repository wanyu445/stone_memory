const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCompressionRouting, summarizeCompressionRouting } = require("../src/services/compression-routing");

test("routes high-importance overlap relation before work and keeps low importance factual", () => {
  const feelings = [
    { id: "low-relation", source_date: "2026-06-01", importance: 3, summary_mode: "daily", content: "老公点外卖" },
    { id: "high-both", source_date: "2026-06-02", importance: 5, summary_mode: "daily", content: "老公说不讲论文只讲爱你" },
    { id: "high-work", source_date: "2026-06-03", importance: 4, summary_mode: "daily", content: "论文完成" },
    { id: "high-fact", source_date: "2026-06-04", importance: 4, summary_mode: "daily", content: "喝茶" },
  ];
  const rows = buildCompressionRouting({ feelings,
    relationPlan: [{ feelingId: "low-relation", action: "keep_daily", reason: "relation" }, { feelingId: "high-both", action: "keep_daily", reason: "relation" }],
    workPlan: [{ feelingId: "high-both", action: "compress_coarse", reason: "work" }, { feelingId: "high-work", action: "keep_daily", reason: "work" }],
  });
  assert.deepEqual(rows.map(row => [row.feelingId, row.route, row.action]), [
    ["low-relation", "fact", "compress_coarse"],
    ["high-both", "relation", "keep_daily"],
    ["high-work", "work", "keep_daily"],
    ["high-fact", "fact", "compress_coarse"],
  ]);
  assert.deepEqual(summarizeCompressionRouting(rows).routes, { fact: 2, relation: 1, work: 1 });
});

test("stable relation background yields ownership to work or fact", () => {
  const feelings = [
    { id: "husband-food", source_date: "2026-06-20", importance: 5, summary_mode: "daily", content: "老公叫我吃糖醋排骨" },
    { id: "husband-work", source_date: "2026-06-21", importance: 5, summary_mode: "daily", content: "老公催我写论文" },
  ];
  const rows = buildCompressionRouting({
    feelings,
    relationPlan: feelings.map(row => ({ feelingId: row.id, action: "compress_coarse", takeover: false, reason: "稳定平台背景词" })),
    workPlan: [{ feelingId: "husband-work", action: "keep_daily", reason: "项目关键进展" }],
  });
  assert.deepEqual(rows.map(row => [row.feelingId, row.route, row.action]), [
    ["husband-food", "fact", "compress_coarse"],
    ["husband-work", "work", "keep_daily"],
  ]);
});

test("event and retain anchors bypass category routing until the marker is removed", () => {
  const feelings = [
    { id: "event", source_date: "2026-05-01", importance: 2, summary_mode: "daily", content: "event" },
    { id: "retain", source_date: "2026-05-02", importance: 2, summary_mode: "daily", content: "retain" },
  ];
  const anchored = buildCompressionRouting({ feelings, anchors: { eventAnchors: { event: {} }, retain: { retain: {} } } });
  assert.deepEqual(anchored.map(row => [row.feelingId, row.route, row.action]), [
    ["event", "anchor", "keep_daily"], ["retain", "anchor", "keep_daily"],
  ]);
  const afterRemoval = buildCompressionRouting({ feelings, anchors: { eventAnchors: {}, retain: {} } });
  assert.deepEqual(afterRemoval.map(row => row.action), ["compress_coarse", "compress_coarse"]);
});

test("relation wins over secondary core, which wins over legacy work and fact", () => {
  const feelings = [
    { id: "relation", source_date: "2026-06-01", importance: 5, content: "老公聊论文" },
    { id: "secondary", source_date: "2026-06-02", importance: 3, content: "论文进展" },
  ];
  const rows = buildCompressionRouting({
    feelings,
    relationPlan: [{ feelingId: "relation", takeover: true, action: "keep_daily", reason: "relation" }],
    secondaryCorePlan: feelings.map(row => ({ feelingId: row.id, category: "work",
      compressionStyle: "secondary_core", action: "compress_coarse", reason: "secondary" })),
    workPlan: feelings.map(row => ({ feelingId: row.id, action: "keep_daily", reason: "legacy work" })),
  });
  assert.deepEqual(rows.map(row => [row.feelingId, row.route, row.action]), [
    ["relation", "relation", "keep_daily"],
    ["secondary", "secondary_core", "compress_coarse"],
  ]);
  assert.equal(rows[1].compressionStyle, "secondary_core");
});
