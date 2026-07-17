const test = require("node:test");
const assert = require("node:assert/strict");
const { qualifyRelationConcepts } = require("../src/services/relation-concept-qualification");

function timeline(term, dates, importance = 5) {
  return { term, normalizedTerm: term, feelings: dates.map((date, index) => ({ id: `${term}-${index}`, sourceDate: date, importance })) };
}

test("separates independent platforms, paired episodes, and unsupported words", () => {
  const platformDates = Array.from({ length: 15 }, (_, index) => `2026-06-${String(index + 1).padStart(2, "0")}`);
  const roleDates = ["2026-06-01", "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];
  const rows = qualifyRelationConcepts([
    timeline("老公", platformDates),
    { term: "神父", normalizedTerm: "神父", feelings: roleDates.map((date, index) => ({ id: `role-${index}`, sourceDate: date, importance: 4 })) },
    { term: "修女", normalizedTerm: "修女", feelings: roleDates.slice(0, 3).map((date, index) => ({ id: `role-${index}`, sourceDate: date, importance: 4 })) },
    timeline("随机", ["2026-06-01", "2026-07-20"], 3),
  ]);
  const byTerm = new Map(rows.map(row => [row.term, row]));
  assert.equal(byTerm.get("老公").qualification, "independent");
  assert.equal(byTerm.get("神父").qualification, "signature_only");
  assert.equal(byTerm.get("神父").signature.term, "修女");
  assert.equal(byTerm.get("随机").qualification, "rejected");
});

test("ignores substring containment as a false signature", () => {
  const rows = qualifyRelationConcepts([
    timeline("有没有", ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]),
    timeline("没有", ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]),
  ]);
  assert.equal(rows.find(row => row.term === "有没有").signature, null);
});
