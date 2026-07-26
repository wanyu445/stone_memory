const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createAutomaticRebuildCoordinator,
  parseIntegrityOutput,
  runRebuildProcess,
} = require("../src/services/automatic-rebuild-coordinator");
const { withFileLock } = require("../src/lib/file-lock");
const { processAlive } = require("../src/lib/process-identity");

function threadConfig() {
  return {
    runtime: "codex",
    automaticRebuild: {
      lifecycle: {
        mode: "supervisor",
        stopCommand: "stop",
        startCommand: "start",
        healthCheckCommand: "health",
      },
    },
  };
}

function pendingState(events) {
  return {
    read: () => ({ rebuildPending: true }),
    setPhase(_threadId, phase) {
      events.push(`phase:${phase}`);
    },
    markCompleted() {
      events.push("completed");
    },
    markFailed() {
      events.push("failed");
    },
    observeUsage() {},
  };
}

test("TURN_SETTLED runs the protected lifecycle and clears pending only after healthy check and start", async () => {
  const events = [];
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() { events.push("rebuild"); return { stdout: "rebuilt" }; },
      async check() { events.push("check"); return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  const result = await coordinator.executePendingRebuild("thread-1", { turnSettled: true });

  assert.equal(result.executed, true);
  assert.deepEqual(events, [
    "phase:stopping", "phase:stopping", "stop",
    "phase:rebuilding", "rebuild",
    "phase:checking", "check",
    "phase:starting", "start",
    "completed",
  ]);
});

test("unhealthy integrity result keeps pending and still restarts the runtime", async () => {
  const events = [];
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() { events.push("rebuild"); return { stdout: "rebuilt" }; },
      async check() { events.push("check"); return { healthy: false, issues: 1 }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  await assert.rejects(
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    /healthy:true/,
  );
  assert.deepEqual(events.slice(-3), ["phase:recovering", "start", "failed"]);
  assert.equal(events.includes("completed"), false);
});

test("integrity output must contain valid JSON with healthy true", () => {
  assert.deepEqual(parseIntegrityOutput('{"healthy":true,"issues":0}'), {
    healthy: true,
    issues: 0,
  });
  assert.throws(() => parseIntegrityOutput('{"healthy":false,"issues":1}'), /healthy:true/);
});

test("a timed-out rebuild rejects only after its whole process group exits", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-timeout-"));
  const pidFile = path.join(root, "child.pid");
  const fixture = path.join(
    __dirname,
    "..",
    "test-fixtures",
    "ignore-term-descendant.js",
  );
  let descendantPid = null;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(runRebuildProcess("thread-1", [], {
    timeoutMs: 100,
    scriptPath: fixture,
    env: {
      ...process.env,
      STMEM_TIMEOUT_PID_FILE: pidFile,
    },
  }), /timed out/);
  descendantPid = Number(fs.readFileSync(pidFile, "utf8"));

  assert.equal(processAlive(descendantPid), false);
});

test("a stop attempt that reports failure still triggers a start recovery", async () => {
  const events = [];
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() {
        events.push("stop");
        throw new Error("stop timed out");
      },
      async start() { events.push("start"); },
    }),
    withThreadLock: async (_threadId, operation) => operation(),
  });

  await assert.rejects(
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    /stop timed out/,
  );
  assert.deepEqual(events.slice(-3), ["phase:recovering", "start", "failed"]);
});

test("an unconfirmed timed-out process group prevents an unsafe restart", async () => {
  const events = [];
  const unsafeError = new Error("process group still alive");
  unsafeError.unsafeToRestart = true;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() {
        events.push("stop");
        throw unsafeError;
      },
      async start() { events.push("start"); },
    }),
    withThreadLock: async (_threadId, operation) => operation(),
  });

  await assert.rejects(
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    /process group still alive/,
  );
  assert.equal(events.includes("start"), false);
  assert.equal(events.includes("completed"), false);
  assert.equal(events.includes("failed"), true);
});

test("recovery still restarts when failure-state reporting itself throws", async () => {
  const events = [];
  const state = pendingState(events);
  state.setPhase = (_threadId, phase) => {
    events.push(`phase:${phase}`);
    if (phase === "recovering") throw new Error("state file unavailable");
  };
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state,
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() { throw new Error("rebuild failed"); },
      async check() { return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  await assert.rejects(
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    /rebuild failed/,
  );
  assert.equal(events.includes("start"), true);
});

test("Windows refuses pending automatic rebuild before stopping the runtime", async () => {
  const events = [];
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state: pendingState(events),
    platform: "win32",
    lifecycleFactory: () => {
      events.push("lifecycle");
      throw new Error("must not create lifecycle");
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  await assert.rejects(
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    /Windows 暂不支持安全的自动 rebuild/,
  );
  assert.equal(events.includes("lifecycle"), false);
  assert.equal(events.includes("completed"), false);
});

test("two TURN_SETTLED processes serialize and only one consumes a pending rebuild", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-coordinator-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let pending = true;
  let stopCount = 0;
  const state = {
    read: () => ({ rebuildPending: pending }),
    setPhase() {},
    markCompleted() { pending = false; },
    markFailed() {},
    observeUsage() {},
  };
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state,
    lifecycleFactory: () => ({
      async stop() {
        stopCount += 1;
        await new Promise(resolve => setTimeout(resolve, 30));
      },
      async start() {},
    }),
    rebuildRunner: {
      async apply() { return { stdout: "rebuilt" }; },
      async check() { return { healthy: true }; },
    },
    withThreadLock: (_threadId, operation) => withFileLock(
      path.join(root, "thread.lock"),
      operation,
      { timeoutMs: 500 },
    ),
  });

  const results = await Promise.all([
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
  ]);

  assert.equal(stopCount, 1);
  assert.deepEqual(results.map(result => result.executed).sort(), [false, true]);
});

test("turn gate closes as soon as a rebuild is pending, before lifecycle work starts", () => {
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state: {
      read: () => ({ rebuildPending: true, status: "rebuild_pending" }),
      setPhase() {},
      markCompleted() {},
      markFailed() {},
      observeUsage() {},
    },
  });

  assert.equal(coordinator.isTurnBlocked("thread-1"), true);
});

test("turn gate stays open when lifecycle is not configured", () => {
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({ runtime: "claude" }),
    state: {
      read: () => ({ rebuildPending: true, status: "rebuild_pending" }),
      setPhase() {},
      markCompleted() {},
      markFailed() {},
      observeUsage() {},
    },
  });

  assert.equal(coordinator.isTurnBlocked("thread-1"), false);
});

test("disabling automatic rebuild opens the turn gate without mutating pending state", () => {
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      runtime: "codex",
      automaticRebuild: { enabled: false },
    }),
    state: {
      read: () => ({ rebuildPending: true, status: "rebuild_pending" }),
      setPhase() {},
      markCompleted() {},
      markFailed() {},
      observeUsage() {},
    },
  });

  assert.equal(coordinator.isTurnBlocked("thread-1"), false);
});

test("disabled settled hook returns before touching rebuild state or context usage", async () => {
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      runtime: "codex",
      automaticRebuild: { enabled: false },
    }),
    state: {
      read() { throw new Error("state must not be read"); },
    },
    readContextUsage() { throw new Error("usage must not be read"); },
  });

  assert.deepEqual(
    await coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    { executed: false, reason: "disabled" },
  );
});

test("re-enabled paused pending admits exactly one turn before blocking again", () => {
  let admission = "available";
  let admissionCalls = 0;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state: {
      read: () => ({
        rebuildPending: true,
        resumeTurnAdmission: admission,
      }),
      admitResumeTurn() {
        admissionCalls += 1;
        if (admission !== "available") return { admitted: false };
        admission = "admitted";
        return { admitted: true };
      },
    },
  });

  assert.equal(coordinator.isTurnBlocked("thread-1", { admitResume: false }), false);
  assert.equal(admissionCalls, 0);
  assert.equal(coordinator.isTurnBlocked("thread-1"), false);
  assert.equal(coordinator.isTurnBlocked("thread-1"), true);
  assert.equal(admissionCalls, 1);
});

test("a resumed pending cannot execute until its admitted turn settles", async () => {
  const events = [];
  let admission = "available";
  const state = pendingState(events);
  state.read = () => ({
    rebuildPending: true,
    disableGeneration: 1,
    resumeTurnAdmission: admission,
  });
  state.admitResumeTurn = () => {
    if (admission !== "available") return { admitted: false };
    admission = "admitted";
    return { admitted: true };
  };
  state.consumeResumeTurn = () => {
    if (admission !== "admitted") return { consumed: false };
    admission = "settling";
    return { consumed: true };
  };
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state,
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() { events.push("rebuild"); return { stdout: "rebuilt" }; },
      async check() { events.push("check"); return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  const staleSettled = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });
  assert.equal(staleSettled.reason, "resume_turn_not_admitted");
  assert.equal(events.includes("stop"), false);

  assert.equal(coordinator.isTurnBlocked("thread-1"), false);
  const admittedSettled = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });
  assert.equal(admittedSettled.executed, true);
  assert.equal(events.includes("stop"), true);
  assert.equal(admission, "settling");
});

test("a failed resumed turn releases admission for a later reliable turn", async () => {
  const events = [];
  let admission = "admitted";
  const state = pendingState(events);
  state.read = () => ({
    rebuildPending: true,
    disableGeneration: 1,
    resumeTurnAdmission: admission,
  });
  state.consumeResumeTurn = () => {
    admission = "settling";
    return { consumed: true };
  };
  state.releaseResumeTurn = () => {
    admission = "available";
    return { resumeTurnAdmission: admission };
  };
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state,
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() { throw new Error("rebuild failed"); },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  await assert.rejects(
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    /rebuild failed/,
  );
  assert.equal(admission, "available");
  assert.equal(events.includes("start"), true);
});

test("a resumed turn is not consumed when lifecycle construction fails", async () => {
  let admission = "admitted";
  const state = pendingState([]);
  state.read = () => ({
    rebuildPending: true,
    disableGeneration: 1,
    resumeTurnAdmission: admission,
  });
  state.consumeResumeTurn = () => {
    admission = "settling";
    return { consumed: true };
  };
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state,
    lifecycleFactory() {
      throw new Error("invalid lifecycle");
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  await assert.rejects(
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    /invalid lifecycle/,
  );
  assert.equal(admission, "admitted");
});

test("a completion-state failure releases a consumed resumed turn", async () => {
  let admission = "admitted";
  const state = pendingState([]);
  state.read = () => ({
    rebuildPending: true,
    disableGeneration: 1,
    resumeTurnAdmission: admission,
  });
  state.consumeResumeTurn = () => {
    admission = "settling";
    return { consumed: true };
  };
  state.releaseResumeTurn = () => {
    admission = "available";
    return { resumeTurnAdmission: admission };
  };
  state.markCompleted = () => {
    throw new Error("completion state failed");
  };
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state,
    lifecycleFactory: () => ({
      async stop() {},
      async start() {},
    }),
    rebuildRunner: {
      async apply() { return { stdout: "rebuilt" }; },
      async check() { return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  await assert.rejects(
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    /completion state failed/,
  );
  assert.equal(admission, "available");
});

test("a settled callback that waited through disable and re-enable cannot use the new generation", async () => {
  const events = [];
  let generation = 0;
  const state = pendingState(events);
  state.read = () => ({
    rebuildPending: true,
    disableGeneration: generation,
    resumeTurnAdmission: generation ? "available" : null,
  });
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state,
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    withThreadLock: async (_threadId, operation) => {
      generation += 1;
      return operation();
    },
  });

  const result = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });

  assert.equal(result.reason, "policy_changed_waiting_next_settled");
  assert.equal(events.includes("stop"), false);
});

test("enabled config reconciles a stale disabled state before any lifecycle work", async () => {
  const events = [];
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state: {
      ...pendingState(events),
      read: () => ({
        status: "disabled_handoff_required",
        rebuildPending: true,
        disableGeneration: 1,
      }),
      noteConfigEnabled() {
        events.push("reconciled");
        return {
          status: "rebuild_pending",
          rebuildPending: true,
          disableGeneration: 1,
          resumeTurnAdmission: "available",
        };
      },
    },
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
  });

  const result = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });

  assert.equal(result.reason, "policy_state_reconciled_waiting_next_settled");
  assert.equal(events.includes("reconciled"), true);
  assert.equal(events.includes("stop"), false);
});

test("enabled config also reconciles a stale disable_requested state", async () => {
  const events = [];
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state: {
      ...pendingState(events),
      read: () => ({
        status: "disable_requested",
        rebuildPending: true,
        disableGeneration: 1,
      }),
      noteConfigEnabled() {
        events.push("reconciled");
        return {
          status: "rebuild_pending",
          rebuildPending: true,
          resumeTurnAdmission: "available",
        };
      },
    },
  });

  const result = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });

  assert.equal(result.reason, "policy_state_reconciled_waiting_next_settled");
  assert.deepEqual(events, ["reconciled"]);
});

test("a disable and re-enable during rebuild stops the old flow at its safe boundary", async () => {
  const events = [];
  let disableGeneration = 0;
  const state = pendingState(events);
  state.read = () => ({
    rebuildPending: true,
    disableGeneration,
    resumeTurnAdmission: disableGeneration ? "available" : null,
  });
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state,
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() {
        events.push("rebuild");
        disableGeneration += 1;
        return { stdout: "rebuilt" };
      },
      async check() { events.push("check"); return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  const result = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });

  assert.equal(result.reason, "policy_changed_waiting_next_settled");
  assert.equal(events.includes("check"), false);
  assert.equal(events.includes("start"), true);
  assert.equal(events.includes("completed"), false);
  assert.equal(events.includes("phase:rebuild_pending"), true);
});

test("disabled usage observation keeps telemetry readable without creating pending", () => {
  let observeCalls = 0;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      runtime: "codex",
      automaticRebuild: { enabled: false },
    }),
    readContextUsage: () => ({
      usedTokens: 80,
      detectedMaxTokens: 100,
    }),
    state: {
      read: () => ({ rebuildPending: false }),
      observeUsage() {
        observeCalls += 1;
        return { rebuildPending: true };
      },
    },
  });

  const result = coordinator.observeThreadUsage("thread-1", {
    usedTokens: 90,
    detectedMaxTokens: 100,
  });

  assert.equal(result.enabled, false);
  assert.equal(result.state.rebuildPending, false);
  assert.equal(observeCalls, 0);
});

test("a settled callback that waited for the lock reloads disabled config before stop", async () => {
  const events = [];
  let enabled = true;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      ...threadConfig(),
      automaticRebuild: {
        ...threadConfig().automaticRebuild,
        enabled,
      },
    }),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    withThreadLock: async (_threadId, operation) => {
      enabled = false;
      return operation();
    },
  });

  const result = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });

  assert.equal(result.executed, false);
  assert.equal(result.reason, "disabled_before_stop");
  assert.equal(events.includes("stop"), false);
  assert.equal(events.includes("start"), false);
  assert.equal(events.includes("completed"), false);
});

test("a state failure before the real stop call never triggers recovery start", async () => {
  const events = [];
  const state = pendingState(events);
  state.setPhase = (_threadId, phase, extra = {}) => {
    events.push(`phase:${phase}`);
    if (phase === "stopping" && extra.stopAttempted === true) {
      throw new Error("state write failed before stop");
    }
  };
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => threadConfig(),
    state,
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    withThreadLock: async (_threadId, operation) => operation(),
  });

  await assert.rejects(
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    /state write failed before stop/,
  );
  assert.equal(events.includes("stop"), false);
  assert.equal(events.includes("start"), false);
});

test("disabling supervisor after stop skips rebuild and compensates without clearing pending", async () => {
  const events = [];
  let enabled = true;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      ...threadConfig(),
      automaticRebuild: {
        ...threadConfig().automaticRebuild,
        enabled,
      },
    }),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() {
        events.push("stop");
        enabled = false;
      },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() { events.push("rebuild"); return { stdout: "rebuilt" }; },
      async check() { events.push("check"); return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  const result = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });

  assert.equal(result.executed, false);
  assert.equal(result.reason, "disabled_supervisor_restored");
  assert.equal(result.disabledAt, "after_stop");
  assert.equal(events.includes("rebuild"), false);
  assert.equal(events.includes("check"), false);
  assert.equal(events.includes("start"), true);
  assert.equal(events.includes("completed"), false);
  assert.equal(events.includes("failed"), false);
  assert.equal(events.includes("phase:disabled_supervisor_rollback"), true);
  assert.equal(events.includes("phase:disabled_supervisor_restored"), true);
});

test("disabling supervisor during rebuild waits for apply then restores without checking", async () => {
  const events = [];
  let enabled = true;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      ...threadConfig(),
      automaticRebuild: {
        ...threadConfig().automaticRebuild,
        enabled,
      },
    }),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() {
        events.push("rebuild");
        enabled = false;
        return { stdout: "rebuilt" };
      },
      async check() { events.push("check"); return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  const result = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });

  assert.equal(result.executed, false);
  assert.equal(result.reason, "disabled_supervisor_restored");
  assert.equal(result.disabledAt, "after_rebuild");
  assert.equal(events.includes("check"), false);
  assert.equal(events.includes("start"), true);
  assert.equal(events.includes("completed"), false);
});

test("disabling while supervisor start confirms health keeps pending paused", async () => {
  const events = [];
  let enabled = true;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      ...threadConfig(),
      automaticRebuild: {
        ...threadConfig().automaticRebuild,
        enabled,
      },
    }),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() {
        events.push("start");
        enabled = false;
      },
    }),
    rebuildRunner: {
      async apply() { events.push("rebuild"); return { stdout: "rebuilt" }; },
      async check() { events.push("check"); return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  const result = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });

  assert.equal(result.executed, false);
  assert.equal(result.reason, "disabled_supervisor_restored");
  assert.equal(result.disabledAt, "during_start");
  assert.equal(events.includes("completed"), false);
  assert.equal(events.includes("phase:disabled_supervisor_restored"), true);
});

test("managed disable after stop hands control back without automatic start", async () => {
  const events = [];
  let enabled = true;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      runtime: "codex",
      automaticRebuild: {
        enabled,
        lifecycle: {
          mode: "managed",
          startCommand: `${process.execPath} agent.js`,
          cwd: process.cwd(),
        },
      },
    }),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() {
        events.push("stop");
        enabled = false;
      },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() { events.push("rebuild"); return { stdout: "rebuilt" }; },
      async check() { events.push("check"); return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  const result = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });

  assert.equal(result.executed, false);
  assert.equal(result.reason, "disabled_managed_handoff");
  assert.equal(events.includes("start"), false);
  assert.equal(events.includes("rebuild"), false);
  assert.equal(events.includes("completed"), false);
  assert.equal(events.includes("phase:disabled_handoff_required"), true);
});

test("managed disable during rebuild waits for apply but never checks or starts", async () => {
  const events = [];
  let enabled = true;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      runtime: "codex",
      automaticRebuild: {
        enabled,
        lifecycle: {
          mode: "managed",
          startCommand: `${process.execPath} agent.js`,
          cwd: process.cwd(),
        },
      },
    }),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() {
        events.push("rebuild");
        enabled = false;
        return { stdout: "rebuilt" };
      },
      async check() { events.push("check"); return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  const result = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });

  assert.equal(result.reason, "disabled_managed_handoff");
  assert.equal(events.includes("check"), false);
  assert.equal(events.includes("start"), false);
  assert.equal(events.includes("phase:disabled_handoff_required"), true);
});

test("managed disable immediately before start never launches the runtime", async () => {
  const events = [];
  let enabled = true;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      runtime: "codex",
      automaticRebuild: {
        enabled,
        lifecycle: {
          mode: "managed",
          startCommand: `${process.execPath} agent.js`,
          cwd: process.cwd(),
        },
      },
    }),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() { events.push("rebuild"); return { stdout: "rebuilt" }; },
      async check() { events.push("check"); return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  const result = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
    logger(message) {
      if (message === "starting runtime") enabled = false;
    },
  });

  assert.equal(result.reason, "disabled_managed_handoff");
  assert.equal(events.includes("start"), false);
});

test("disabled supervisor rollback failure preserves pending and reports manual recovery state", async () => {
  const events = [];
  let enabled = true;
  const state = pendingState(events);
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      ...threadConfig(),
      automaticRebuild: {
        ...threadConfig().automaticRebuild,
        enabled,
      },
    }),
    state,
    lifecycleFactory: () => ({
      async stop() {
        events.push("stop");
        enabled = false;
      },
      async start() {
        events.push("start");
        throw new Error("start failed: --token very-secret-value");
      },
    }),
    withThreadLock: async (_threadId, operation) => operation(),
  });

  await assert.rejects(
    coordinator.executePendingRebuild("thread-1", { turnSettled: true }),
    /runtime recovery failed/,
  );
  assert.equal(events.includes("phase:disabled_supervisor_rollback_failed"), true);
  assert.doesNotMatch(
    events.find(event => event.includes("disabled_supervisor_rollback_failed")),
    /very-secret-value/,
  );
  assert.equal(events.includes("completed"), false);
});

test("re-enabled paused pending executes only on the next settled callback", async () => {
  const events = [];
  let enabled = false;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      ...threadConfig(),
      automaticRebuild: {
        ...threadConfig().automaticRebuild,
        enabled,
      },
    }),
    state: pendingState(events),
    lifecycleFactory: () => ({
      async stop() { events.push("stop"); },
      async start() { events.push("start"); },
    }),
    rebuildRunner: {
      async apply() { events.push("rebuild"); return { stdout: "rebuilt" }; },
      async check() { events.push("check"); return { healthy: true }; },
    },
    withThreadLock: async (_threadId, operation) => operation(),
  });

  const disabled = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });
  enabled = true;
  assert.equal(events.includes("stop"), false);

  const resumed = await coordinator.executePendingRebuild("thread-1", {
    turnSettled: true,
  });

  assert.equal(disabled.reason, "disabled");
  assert.equal(resumed.executed, true);
  assert.equal(events.includes("stop"), true);
});

test("Claude usage observation reuses the maximum previously detected by status line", () => {
  let observedThreshold = null;
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => ({
      runtime: "claude",
      automaticRebuild: {
        lifecycle: {
          mode: "managed",
          startCommand: "node agent.js",
          cwd: "/srv/agent",
        },
      },
    }),
    readContextUsage: () => ({ detectedMaxTokens: 100 }),
    state: {
      read: () => ({}),
      setPhase() {},
      markCompleted() {},
      markFailed() {},
      observeUsage(_threadId, _usage, threshold) {
        observedThreshold = threshold;
        return {};
      },
    },
  });

  coordinator.observeThreadUsage("thread-1", {
    usedTokens: 90,
    detectedMaxTokens: null,
    observedAt: "2026-07-26T02:00:00.000Z",
  });

  assert.equal(observedThreshold, 86);
});
