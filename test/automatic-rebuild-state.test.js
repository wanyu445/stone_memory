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

test("disable and re-enable transitions preserve pending and managed ownership", () => {
  const store = memoryStore({
    automaticRebuild: {
      status: "rebuilding",
      rebuildPending: true,
      highWaterTokens: 90,
      managedRuntime: { pid: 123, processIdentity: "owned" },
    },
  });
  const automatic = createAutomaticRebuildState({
    store,
    now: () => "2026-07-26T02:05:00.000Z",
  });

  const disabled = automatic.noteConfigEnabled("thread-1", false, {
    lifecycleMode: "managed",
  });
  assert.equal(disabled.status, "disabled_waiting_safe_rebuild_exit");
  assert.equal(disabled.disableGeneration, 1);
  assert.equal(disabled.rebuildPending, true);
  assert.equal(disabled.managedRuntime.pid, 123);

  const reenabled = automatic.noteConfigEnabled("thread-1", true);
  assert.equal(reenabled.status, "rebuild_pending");
  assert.equal(reenabled.rebuildPending, true);
  assert.equal(reenabled.managedRuntime.pid, 123);
  assert.equal(reenabled.resumeTurnAdmission, "available");

  const first = automatic.admitResumeTurn("thread-1");
  const second = automatic.admitResumeTurn("thread-1");
  const consumed = automatic.consumeResumeTurn("thread-1");
  const consumedAgain = automatic.consumeResumeTurn("thread-1");
  const released = automatic.releaseResumeTurn("thread-1");
  assert.equal(first.admitted, true);
  assert.equal(first.state.resumeTurnAdmission, "admitted");
  assert.equal(second.admitted, false);
  assert.equal(consumed.consumed, true);
  assert.equal(consumed.state.resumeTurnAdmission, "settling");
  assert.equal(consumedAgain.consumed, false);
  assert.equal(released.resumeTurnAdmission, "available");
});

test("an idle disable records that Stone did not change the running runtime", () => {
  const store = memoryStore({
    automaticRebuild: {
      status: "watching",
      rebuildPending: false,
      runtimeRunning: true,
    },
  });
  const automatic = createAutomaticRebuildState({ store });

  const disabled = automatic.noteConfigEnabled("thread-1", false, {
    lifecycleMode: "managed",
  });

  assert.equal(disabled.status, "disabled_idle_runtime_running");
  assert.equal(disabled.runtimeRunning, true);
  assert.equal(disabled.stopAttempted, false);
  assert.equal(disabled.lifecycleMode, "managed");
});

test("an idle managed disable reports a retained stopped runtime without pretending it is healthy", () => {
  const store = memoryStore({
    automaticRebuild: {
      status: "watching",
      rebuildPending: false,
      managedRuntime: { pid: 123, stoppedAt: "2026-07-26T02:00:00.000Z" },
    },
  });
  const automatic = createAutomaticRebuildState({ store });

  const disabled = automatic.noteConfigEnabled("thread-1", false, {
    lifecycleMode: "managed",
  });

  assert.equal(disabled.status, "disabled_idle_runtime_stopped");
  assert.equal(disabled.runtimeRunning, false);
});

test("disable while preparing stop records that no stop command was executed", () => {
  const store = memoryStore({
    automaticRebuild: {
      status: "stopping",
      rebuildPending: true,
      stopAttempted: false,
    },
  });
  const automatic = createAutomaticRebuildState({ store });

  const disabled = automatic.noteConfigEnabled("thread-1", false, {
    lifecycleMode: "supervisor",
  });

  assert.equal(disabled.status, "disabled_cancelled_before_stop");
  assert.equal(disabled.runtimeRunning, null);
  assert.equal(disabled.stopAttempted, false);
});
