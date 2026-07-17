const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTermTimeline, buildCooccurrenceSignatures } = require("../src/services/term-timeline");
const { buildRelationLifecycles, classifyRelationTimeline } = require("../src/services/relation-lifecycle");

function timeline(term, dates, { category = "relation", from = "2026-06-01", to = "2026-06-30" } = {}) {
  return buildTermTimeline({
    requestedTerms: [term],
    extractedTerms: category ? [{ normalizedTerm: term, category, featureIds: [] }] : [],
    messages: dates.map((date, index) => ({ date, timestamp: `t${index}`, text: term })),
    feelings: [], from, to,
  })[0];
}

test("classifies continuous, episodic, retired, and revived relation shapes", () => {
  const continuous = timeline("老公", ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21", "2026-06-22", "2026-06-23", "2026-06-24"]);
  assert.deepEqual([classifyRelationTimeline(continuous).state, classifyRelationTimeline(continuous).shape], ["established", "continuous"]);

  const episodic = timeline("少爷", ["2026-06-05", "2026-06-06", "2026-06-15", "2026-06-16", "2026-06-28"]);
  assert.deepEqual([classifyRelationTimeline(episodic).state, classifyRelationTimeline(episodic).shape], ["established", "episodic"]);

  const retired = timeline("神父", ["2026-06-01", "2026-06-02", "2026-06-07"]);
  assert.equal(classifyRelationTimeline(retired).state, "retired");

  const revived = timeline("旧称呼", ["2026-06-01", "2026-06-02", "2026-06-28", "2026-06-29"]);
  assert.equal(classifyRelationTimeline(revived).state, "revived");
});

test("infers a missing paired role only from high-affinity relation co-occurrence", () => {
  const messages = [
    { date: "2026-06-01", text: "少爷和女仆" },
    { date: "2026-06-02", text: "少爷和女仆" },
    { date: "2026-06-03", text: "少爷和女仆" },
  ];
  const rows = buildTermTimeline({
    requestedTerms: ["少爷", "女仆"],
    extractedTerms: [{ normalizedTerm: "女仆", category: "relation", featureIds: [] }],
    messages, feelings: [], from: "2026-06-01", to: "2026-06-10",
  });
  const intersections = buildCooccurrenceSignatures({ termTimelines: rows, messages, feelings: [] });
  const result = buildRelationLifecycles({ termTimelines: rows, intersections });
  assert.equal(result.terms.find(row => row.term === "少爷").inferredRelation, true);
  assert.equal(result.pairs[0].shape, "paired_experiment");
});
