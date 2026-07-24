const test = require("node:test");
const assert = require("node:assert/strict");
const { qualifyRelationConcepts } = require("../src/services/relation-concept-qualification");
const { findRelationSignaturePeers } = require("../src/services/relation-signature-context");

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

test("single-term relation analysis discovers its repeated feeling signature peer", () => {
  const feelings = Array.from({ length: 5 }, (_, index) => ({
    id: `pair-${index}`, content: `少爷和女仆第${index}次角色扮演`,
  }));
  const peers = findRelationSignaturePeers({
    requestedTerms: ["女仆"],
    extractedTerms: [
      { term: "少爷", normalizedTerm: "少爷", category: "misc" },
      { term: "角色扮演", normalizedTerm: "角色扮演", category: "relation" },
      { term: "女仆", normalizedTerm: "女仆", category: "relation" },
    ],
    feelings,
  });
  assert.equal(peers.find(row => row.term === "少爷").sameFeelings, 5);
  assert.equal(peers.some(row => row.term === "女仆"), false);
});
