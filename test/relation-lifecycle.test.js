const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTermTimeline, buildCooccurrenceSignatures } = require("../src/services/term-timeline");
const { buildRelationLifecycles, classifyRelationTimeline, classifyRelationPoint, detectStableOnset } = require("../src/services/relation-lifecycle");

function timeline(term, dates, { category = "relation", from = "2026-06-01", to = "2026-06-30" } = {}) {
  return buildTermTimeline({
    requestedTerms: [term],
    extractedTerms: category ? [{ normalizedTerm: term, category, featureIds: [] }] : [],
    messages: dates.map((date, index) => ({ date, timestamp: `t${index}`, text: term })),
    feelings: dates.map((date, index) => ({ id: `${term}-${index}`, source_date: date, importance: 3, content: term })), from, to,
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

  const establishedAfterOldRevival = timeline("石头", ["2026-06-01", "2026-06-20", "2026-06-21", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28", "2026-06-29", "2026-06-30"]);
  assert.equal(classifyRelationTimeline(establishedAfterOldRevival).state, "established");

  const burstThenCallbacks = timeline("暗石", ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-15", "2026-06-20", "2026-06-25", "2026-06-29"]);
  assert.deepEqual([classifyRelationTimeline(burstThenCallbacks).state, classifyRelationTimeline(burstThenCallbacks).shape], ["established", "episodic"]);

  const postPlateau = timeline("老公", ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06", "2026-06-07", "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-07-12"], { to: "2026-07-15" });
  const postPlateauLifecycle = classifyRelationTimeline(postPlateau);
  assert.deepEqual([postPlateauLifecycle.state, postPlateauLifecycle.shape], ["established", "post_plateau"]);
  assert.equal(classifyRelationPoint(postPlateau, postPlateauLifecycle, "2026-07-12"), "post_plateau_callback");
});

test("places relation feelings on rare early, formation, stable, episodic, and revival points", () => {
  const continuous = timeline("老公", ["2026-06-01", "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28", "2026-06-29", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13", "2026-07-14"], { to: "2026-07-15" });
  const continuousLifecycle = classifyRelationTimeline(continuous);
  assert.equal(continuousLifecycle.metrics.stableOnsetDate, "2026-06-15");
  assert.equal(classifyRelationPoint(continuous, continuousLifecycle, "2026-06-01"), "rare_early");
  assert.equal(classifyRelationPoint(continuous, continuousLifecycle, "2026-06-18"), "formation");
  assert.equal(classifyRelationPoint(continuous, continuousLifecycle, "2026-06-25"), "stable_repeat");

  const episodic = timeline("暗石", ["2026-06-01", "2026-06-02", "2026-06-10", "2026-06-15", "2026-06-20", "2026-06-29"]);
  assert.equal(classifyRelationPoint(episodic, classifyRelationTimeline(episodic), "2026-06-20"), "episodic_recurrence");

  const revived = timeline("旧称呼", ["2026-06-01", "2026-06-02", "2026-06-28", "2026-06-29"]);
  assert.equal(classifyRelationPoint(revived, classifyRelationTimeline(revived), "2026-06-28"), "revival");
});

test("infers a missing paired role only from high-affinity relation co-occurrence", () => {
  const messages = [
    { date: "2026-06-01", text: "少爷和女仆" },
    { date: "2026-06-02", text: "少爷和女仆" },
    { date: "2026-06-03", text: "少爷和女仆" },
  ];
  const feelings = [
    { id: "pair-1", source_date: "2026-06-01", importance: 4, content: "少爷和女仆" },
    { id: "pair-2", source_date: "2026-06-02", importance: 4, content: "少爷和女仆" },
    { id: "pair-3", source_date: "2026-06-03", importance: 4, content: "少爷和女仆" },
    { id: "pair-4", source_date: "2026-06-04", importance: 4, content: "少爷和女仆" },
    { id: "pair-5", source_date: "2026-06-05", importance: 4, content: "少爷和女仆" },
  ];
  const rows = buildTermTimeline({
    requestedTerms: ["少爷", "女仆"],
    extractedTerms: [{ normalizedTerm: "女仆", category: "relation", featureIds: [] }],
    messages, feelings, from: "2026-06-01", to: "2026-06-10",
  });
  const intersections = buildCooccurrenceSignatures({ termTimelines: rows, messages, feelings });
  const result = buildRelationLifecycles({ termTimelines: rows, intersections });
  assert.equal(result.terms.find(row => row.term === "少爷").inferredRelation, true);
  assert.equal(result.pairs[0].shape, "episodic_pair");
});
