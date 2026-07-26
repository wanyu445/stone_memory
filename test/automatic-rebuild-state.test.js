const test = require("node:test");
const assert = require("node:assert/strict");

const { createAutomaticRebuildState } = require("../src/services/automatic-rebuild-state");

function memoryStore(initial = {}) {
  let state = structuredClone(initial);
  return {
    read: () => structuredClone(state),
    update(_threadId, updater) {
      state = updater(structuredClone(state));
      return structuredClone(state);
    },
  };
}

test("threshold crossing creates sticky pending even after native compact lowers usage", () => {
  const store = memoryStore();
  const automatic = createAutomaticRebuildState({
    store,
    now: () => "2026-07-26T02:00:00.000Z",
  });

  automatic.observeUsage("thread-1", {
    usedTokens: 90,
    observedAt: "2026-07-26T01:59:00.000Z",
  }, 86);
  const compacted = automatic.observeUsage("thread-1", {
    usedTokens: 30,
    observedAt: "2026-07-26T02:01:00.000Z",
  }, 86);

  assert.equal(compacted.rebuildPending, true);
  assert.equal(compacted.highWaterTokens, 90);
  assert.equal(compacted.lastObservedTokens, 30);
});

test("successful rebuild clears pending and ignores usage observations from the old thread", () => {
  const store = memoryStore();
  let currentTime = "2026-07-26T02:00:00.000Z";
  const automatic = createAutomaticRebuildState({
    store,
    now: () => currentTime,
  });

  automatic.observeUsage("thread-1", {
    usedTokens: 90,
    observedAt: "2026-07-26T01:59:00.000Z",
  }, 86);
  automatic.markCompleted("thread-1", { healthy: true });
  currentTime = "2026-07-26T02:05:00.000Z";
  const ignored = automatic.observeUsage("thread-1", {
    usedTokens: 90,
    observedAt: "2026-07-26T01:59:00.000Z",
  }, 86);

  assert.equal(ignored.rebuildPending, false);
  assert.equal(ignored.highWaterTokens, 0);
  assert.equal(ignored.ignoredUsageAt, "2026-07-26T02:05:00.000Z");
});

test("usage without an observation timestamp is isolated after rebuild", () => {
  const store = memoryStore({
    automaticRebuild: {
      rebuildPending: false,
      highWaterTokens: 0,
      ignoreUsageBefore: "2026-07-26T02:00:00.000Z",
    },
  });
  const automatic = createAutomaticRebuildState({
    store,
    now: () => "2026-07-26T02:05:00.000Z",
  });

  const ignored = automatic.observeUsage("thread-1", {
    usedTokens: 90,
    observedAt: null,
  }, 86);

  assert.equal(ignored.rebuildPending, false);
  assert.equal(ignored.highWaterTokens, 0);
  assert.equal(ignored.ignoredUsageAt, "2026-07-26T02:05:00.000Z");
});
