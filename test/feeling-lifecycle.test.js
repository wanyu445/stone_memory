const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeFeelingLifecycle, summarizeLifecycle } = require("../src/services/feeling-lifecycle");

function feeling(id, importance, sourceDate, lastSeen, activeDays = 1) {
  return {
    feelingId: id, importance, sourceDate, content: `${sourceDate} 的完整叙事内容`.repeat(5), summaryMode: "daily",
    matchedTerms: [{ term: "词", messageCount: 3, activeDays, firstSeen: sourceDate, lastSeen }],
  };
}

test("lifecycle applies importance and time rules without touching unmatched feelings", () => {
  const rows = analyzeFeelingLifecycle({
    referenceDate: "2026-07-15",
    feelingEvidence: [
      feeling("low", 2, "2026-06-01", "2026-07-14"),
      feeling("recent", 3, "2026-06-01", "2026-07-10"),
      feeling("idle", 3, "2026-05-01", "2026-05-20", 2),
      feeling("legacy", 4, "2026-05-01", "2026-07-01"),
      feeling("key", 5, "2026-05-01", "2026-07-01"),
    ],
  });
  assert.deepEqual(rows.map(row => row.action), [
    "coarse_candidate", "keep", "coarse_candidate", "compatibility_review", "main_agent_review",
  ]);
  assert.equal(rows[3].proposedImportance, 5);
  assert.equal(rows[4].ageDays, 75);
});

test("event and retain anchors both exclude feelings from automatic compression", () => {
  const [eventRow] = analyzeFeelingLifecycle({
    referenceDate: "2026-07-15",
    feelingEvidence: [feeling("anchor", 2, "2026-05-01", "2026-05-02")],
    eventAnchorIds: ["anchor"],
  });
  assert.equal(eventRow.action, "event_protected");
  const [retainRow] = analyzeFeelingLifecycle({
    referenceDate: "2026-07-15",
    feelingEvidence: [feeling("anchor", 2, "2026-05-01", "2026-05-02")],
    retainAnchorIds: ["anchor"],
  });
  assert.equal(retainRow.action, "retain_protected");
});

test("summary counts actions and estimated coarse savings", () => {
  const rows = analyzeFeelingLifecycle({
    referenceDate: "2026-07-15",
    feelingEvidence: [feeling("a", 2, "2026-05-01", "2026-05-01"), feeling("b", 5, "2026-07-01", "2026-07-01")],
  });
  const summary = summarizeLifecycle(rows);
  assert.deepEqual(summary.actions, { coarse_candidate: 1, keep: 1 });
  assert.equal(summary.estimatedSavingsChars > 0, true);
});
