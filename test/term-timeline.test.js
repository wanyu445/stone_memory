const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTermTimeline, buildCooccurrenceSignatures, countOccurrences } = require("../src/services/term-timeline");

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
  assert.deepEqual(row.categorySupport, { body: 1, eat: 1 });
  assert.equal(row.categoryPurity.eat, 0.5);
  assert.equal(row.activeDays, 2);
  assert.equal(row.baseline.calendarDailyMean, 1);
  assert.equal(row.baseline.activeDailyMean, 1.5);
});

test("uses cached daily evidence without changing feeling overlays", () => {
  const [row] = buildTermTimeline({
    requestedTerms: ["喝茶"], extractedTerms: [],
    messages: [{ date: "2026-04-15", text: "不应重新统计" }, { date: "2026-04-16", text: "喝茶" }],
    dailyStats: [
      { normalizedTerm: "喝茶", sourceDate: "2026-04-15", messageCount: 2, occurrenceCount: 3 },
      { normalizedTerm: "喝茶", sourceDate: "2026-04-16", messageCount: 0, occurrenceCount: 0 },
    ],
    feelings: [{ id: "f1", source_date: "2026-04-15", importance: 3, content: "4月15日，喝茶。" }],
  });
  assert.equal(row.messageCount, 2);
  assert.equal(row.occurrenceCount, 3);
  assert.equal(row.feelings.length, 1);
});

test("counts non-overlapping normalized occurrences", () => {
  assert.equal(countOccurrences("外卖外卖和外卖", "外卖"), 3);
});

test("builds pair and full-set temporal co-occurrence signatures", () => {
  const messages = [
    { date: "2026-06-01", timestamp: "t1", text: "老公帮我点外卖" },
    { date: "2026-06-02", timestamp: "t2", text: "老公，今天不想讲论文" },
  ];
  const feelings = [
    { id: "f1", source_date: "2026-06-02", importance: 5, content: "6月2日。老公说先不讲论文，只讲爱。" },
  ];
  const termTimelines = buildTermTimeline({
    requestedTerms: ["老公", "外卖", "论文"],
    extractedTerms: [
      { normalizedTerm: "老公", category: "relation", featureIds: [] },
      { normalizedTerm: "外卖", category: "eat", featureIds: [] },
      { normalizedTerm: "论文", category: "work", featureIds: [] },
    ],
    messages,
    feelings,
  });
  const signatures = buildCooccurrenceSignatures({ termTimelines, messages, feelings });
  assert.equal(signatures.length, 4);
  const relationWork = signatures.find(row => row.terms.join("+") === "老公+论文");
  assert.equal(relationWork.sameDays.length, 1);
  assert.equal(relationWork.sameMessages.length, 1);
  assert.equal(relationWork.sameFeelings.length, 1);
  assert.equal(relationWork.sameFeelings[0].importance, 5);
  const all = signatures.find(row => row.terms.length === 3);
  assert.equal(all.sameMessages.length, 0);
});

test("detects terms split across a thirty-minute local message window", () => {
  const rows = [
    { date: "2026-07-01", timestamp: "2026-07-01T15:44:00Z", text: "还要做学术海报" },
    { date: "2026-07-02", timestamp: "2026-07-01T16:06:00Z", text: "中期检查后继续毕业论文" },
  ];
  const timelines = buildTermTimeline({ requestedTerms: ["学术海报", "中期检查"], extractedTerms: [], messages: rows, feelings: [] });
  const [signature] = buildCooccurrenceSignatures({ termTimelines: timelines, messages: rows, feelings: [] });
  assert.equal(signature.sameMessages.length, 0);
  assert.equal(signature.sameWindows.length, 1);
  assert.equal(signature.sameWindows[0].gapMinutes, 22);
});
