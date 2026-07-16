const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTermTimeline, countOccurrences } = require("../src/services/term-timeline");

test("counts daily archive occurrences, fills zero days, and overlays feelings", () => {
  const [row] = buildTermTimeline({
    requestedTerms: ["茶叶"],
    extractedTerms: [
      { normalizedTerm: "茶叶", category: "eat", featureIds: ["e1"] },
      { normalizedTerm: "茶叶", category: "body", featureIds: ["b1"] },
    ],
    messages: [
      { date: "2026-04-15", text: "茶叶喝多了，茶叶很浓" },
      { date: "2026-04-17", text: "又提茶葉" },
    ],
    feelings: [{ id: "f1", source_date: "2026-04-15", importance: 4, summary_mode: "daily", content: "4月15日，晚上九点。她喝了茶叶。" }],
    anchors: { retain: { f1: {} }, eventAnchors: {} },
  });
  assert.deepEqual(row.categories, ["body", "eat"]);
  assert.deepEqual(row.timeline, [
    { date: "2026-04-15", messageCount: 1, occurrenceCount: 2 },
    { date: "2026-04-16", messageCount: 0, occurrenceCount: 0 },
    { date: "2026-04-17", messageCount: 1, occurrenceCount: 1 },
  ]);
  assert.equal(row.feelings[0].retainAnchor, true);
  assert.equal(row.activeDays, 2);
});

test("counts non-overlapping normalized occurrences", () => {
  assert.equal(countOccurrences("外卖外卖和外卖", "外卖"), 3);
});
