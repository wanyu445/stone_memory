const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRelationCompressionPlan, summarizeRelationCompressionPlan } = require("../src/services/relation-compression-plan");

function fixture({ state = "established", points }) {
  return {
    termTimelines: [{ term: "老公", normalizedTerm: "老公", feelings: points.map(point => ({
      id: point.id, sourceDate: point.date, importance: point.importance, content: point.id,
    })) }],
    relation: { terms: [{ term: "老公", normalizedTerm: "老公", state, shape: "continuous", feelingPoints: points.map(point => ({
      feelingId: point.id, sourceDate: point.date, importance: point.importance, position: point.position,
    })) }] },
  };
}

test("established relation keeps the day with the most importance 5 feelings, not every importance 5", () => {
  const input = fixture({ points: [
    { id: "one-five", date: "2026-06-01", importance: 5, position: "formation" },
    { id: "peak-a", date: "2026-06-02", importance: 5, position: "formation" },
    { id: "peak-b", date: "2026-06-02", importance: 5, position: "formation" },
    { id: "same-day-three", date: "2026-06-02", importance: 3, position: "formation" },
    { id: "ordinary", date: "2026-06-03", importance: 4, position: "formation" },
  ] });
  const rows = buildRelationCompressionPlan(input);
  assert.deepEqual(rows.map(row => [row.feelingId, row.action]), [
    ["one-five", "compress_coarse"],
    ["peak-a", "keep_daily"],
    ["peak-b", "keep_daily"],
    ["same-day-three", "keep_daily"],
    ["ordinary", "compress_coarse"],
  ]);
  assert.deepEqual(summarizeRelationCompressionPlan(rows).actions, { compress_coarse: 2, keep_daily: 3 });
});

test("computes peaks separately for lifecycle stages", () => {
  const input = fixture({ points: [
    { id: "formation", date: "2026-06-01", importance: 5, position: "formation" },
    { id: "stable-old", date: "2026-06-20", importance: 5, position: "stable_repeat" },
    { id: "stable-peak-a", date: "2026-06-21", importance: 5, position: "stable_repeat" },
    { id: "stable-peak-b", date: "2026-06-21", importance: 5, position: "stable_repeat" },
  ] });
  const rows = buildRelationCompressionPlan(input);
  assert.deepEqual(rows.map(row => [row.feelingId, row.action]), [
    ["formation", "keep_daily"],
    ["stable-old", "compress_coarse"],
    ["stable-peak-a", "keep_daily"],
    ["stable-peak-b", "keep_daily"],
  ]);
  assert.equal(rows.find(row => row.feelingId === "stable-old").takeover, false);
  assert.equal(rows.find(row => row.feelingId === "formation").takeover, true);
});

test("keeps unsettled relation stages conservatively and event anchors unconditionally", () => {
  const forming = fixture({ state: "forming", points: [
    { id: "forming-low", date: "2026-06-01", importance: 2, position: "formation" },
  ] });
  assert.equal(buildRelationCompressionPlan(forming)[0].action, "keep_daily");

  const established = fixture({ points: [
    { id: "anchor", date: "2026-06-20", importance: 2, position: "stable_repeat" },
  ] });
  const anchored = buildRelationCompressionPlan({
    ...established, anchors: { eventAnchors: { anchor: {} } },
  });
  assert.equal(anchored[0].action, "keep_daily");
  assert.match(anchored[0].reason, /event anchor/);

  const retained = buildRelationCompressionPlan({
    ...established, anchors: { retain: { anchor: {} } },
  });
  assert.equal(retained[0].action, "keep_daily");
  assert.match(retained[0].reason, /原文锚点/);
});
