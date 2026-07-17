const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWorkCompressionPlan } = require("../src/services/work-compression-plan");

test("keeps only anchors while exposing project evidence and excluding relation-owned decisions", () => {
  const work = {
    terms: [{ normalizedTerm: "论文", state: "active" }],
    groups: [{
      firstSeen: "2026-04-01",
      members: [{ term: "论文" }, { term: "毕设" }],
      evidenceFeelingIds: ["start", "old", "milestone", "recent", "relation", "retain"],
      timeline: [
        { date: "2026-04-01", feelingIds: ["start"] },
        { date: "2026-05-01", feelingIds: ["old"] },
        { date: "2026-05-03", feelingIds: ["milestone"] },
        { date: "2026-07-15", feelingIds: ["recent"] },
      ],
    }],
  };
  const termTimelines = [{ term: "论文", normalizedTerm: "论文", to: "2026-07-20", feelings: [
    { id: "start", sourceDate: "2026-04-01", importance: 3, content: "项目开始" },
    { id: "old", sourceDate: "2026-05-01", importance: 3, content: "旧进度" },
    { id: "relation", sourceDate: "2026-05-02", importance: 5, content: "关系接管事件" },
    { id: "milestone", sourceDate: "2026-05-03", importance: 5, content: "突破" },
    { id: "retain", sourceDate: "2026-05-04", importance: 2, content: "原文锚点" },
    { id: "recent", sourceDate: "2026-07-15", importance: 3, content: "近期普通进度" },
  ] }];
  const rows = buildWorkCompressionPlan({
    work, termTimelines, relationFeelingIds: ["relation"], anchors: { retain: { retain: {} } },
  });
  assert.deepEqual(rows.map(row => [row.feelingId, row.action]), [
    ["start", "compress_coarse"], ["old", "compress_coarse"], ["milestone", "compress_coarse"],
    ["retain", "keep_daily"], ["recent", "compress_coarse"],
  ]);
  assert.equal(rows.find(row => row.feelingId === "start").projectStart, true);
  assert.equal(rows.find(row => row.feelingId === "milestone").milestonePeak, true);
  assert.equal(rows.some(row => row.feelingId === "relation"), false);
});

test("does not keep every importance 5 or protect recent work automatically", () => {
  const work = { terms: [{ normalizedTerm: "论文", state: "active" }], groups: [{
    firstSeen: "2026-05-01", members: [{ term: "论文" }], evidenceFeelingIds: ["five", "recent"],
    timeline: [{ date: "2026-05-01", feelingIds: ["five"] }],
  }] };
  const termTimelines = [{ term: "论文", normalizedTerm: "论文", to: "2026-07-20", feelings: [
    { id: "five", sourceDate: "2026-05-01", importance: 5, content: "普通高分旧进度" },
    { id: "recent", sourceDate: "2026-07-19", importance: 3, content: "最近进度" },
  ] }];
  const rows = buildWorkCompressionPlan({ work, termTimelines });
  assert.deepEqual(rows.map(row => row.action), ["compress_coarse", "compress_coarse"]);
});
