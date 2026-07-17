const test = require("node:test");
const assert = require("node:assert/strict");
const { activeTerms, buildCompressionPlan, buildFeelingIntersections } = require("../src/services/compression-planner");

test("planner only starts relation/work timelines for terms matched by daily feelings", () => {
  const features = [
    { id: "r1", category: "relation", content: "称呼：老公", importance: 5 },
    { id: "w1", category: "work", content: "项目：论文", importance: 3 },
    { id: "e1", category: "eat", content: "食物：寿司", importance: 2 },
  ];
  const feelings = [
    { id: "daily", source_date: "2026-07-01", summary_mode: "daily", importance: 3, content: "7月1日，上午九点。她吃了寿司。" },
    { id: "old", source_date: "2026-06-01", summary_mode: "coarse", importance: 5, content: "6月1日，上午九点。她叫我老公。" },
  ];
  const terms = require("../src/services/feature-phrase-extractor").extractFeatureTerms(features);
  assert.ok(activeTerms(terms, feelings.filter(row => row.summary_mode === "daily")).includes("寿司"));
  const plan = buildCompressionPlan({ features, feelings, messages: [], anchors: {} });
  assert.equal(plan.candidateTerms, 0);
  assert.deepEqual(plan.decisions.map(row => [row.feelingId, row.route, row.action]), [
    ["daily", "fact", "compress_coarse"],
  ]);
  assert.equal(plan.termTimelines.some(row => row.normalizedTerm === "老公"), false);
  assert.equal(plan.termTimelines.some(row => row.normalizedTerm === "寿司"), false);
});

test("planner keeps anchors even when no feature term matches", () => {
  const feelings = [{ id: "anchor", source_date: "2026-07-01", summary_mode: "daily", importance: 2, content: "7月1日，上午九点。一件事。" }];
  const plan = buildCompressionPlan({ feelings, anchors: { eventAnchors: { anchor: {} } } });
  assert.equal(plan.decisions[0].action, "keep_daily");
});

test("planner builds sparse co-occurrence signatures from feeling points", () => {
  const common = { id: "f1", sourceDate: "2026-07-01", importance: 5, content: "老公爱你" };
  const intersections = buildFeelingIntersections([
    { term: "老公", normalizedTerm: "老公", feelings: [common] },
    { term: "爱你", normalizedTerm: "爱你", feelings: [common] },
    { term: "论文", normalizedTerm: "论文", feelings: [] },
  ]);
  assert.equal(intersections.length, 1);
  assert.deepEqual(intersections[0].terms, ["爱你", "老公"]);
  assert.equal(intersections[0].sameFeelings[0].id, "f1");
});
