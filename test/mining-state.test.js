const test = require("node:test");
const assert = require("node:assert/strict");
const { isCompleted, shouldAttempt, retryDelayMs, listBlockedDays } = require("../src/services/mining-state");

test("legacy skipped+mined date is not treated as completed", () => {
  const state = { "mined:2026-06-12": 1, "skipped:2026-06-12": 1 };
  assert.equal(isCompleted(state, "2026-06-12"), false);
  assert.equal(shouldAttempt(state, "2026-06-12", Array.from({ length: 5 }, (_, i) => ({ text: String(i) }))), true);
});

test("completed_empty is a terminal successful state", () => {
  const state = { "day:2026-06-12": { status: "completed_empty", messageCount: 2 } };
  assert.equal(isCompleted(state, "2026-06-12"), true);
  assert.equal(shouldAttempt(state, "2026-06-12", [{ text: "a" }, { text: "b" }]), false);
});

test("failed date observes retry backoff", () => {
  const now = Date.parse("2026-06-12T00:00:00Z");
  const state = { "day:2026-06-12": { status: "failed", nextRetryAt: "2026-06-12T00:05:00Z" } };
  assert.equal(shouldAttempt(state, "2026-06-12", [], now), false);
  assert.equal(shouldAttempt(state, "2026-06-12", [], now + retryDelayMs(2)), true);
});

test("blocked date is excluded from automatic scheduling and exposed for inspection", () => {
  const state = { "day:2026-06-12": { status: "blocked", attempt: 3, errorCode: "OUTPUT_INVALID", errorMessage: "bad json" } };
  assert.equal(shouldAttempt(state, "2026-06-12", [], Date.now() + 86400000), false);
  assert.deepEqual(listBlockedDays(state).map(item => [item.date, item.errorCode]), [["2026-06-12", "OUTPUT_INVALID"]]);
});
