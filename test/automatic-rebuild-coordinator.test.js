const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createAutomaticRebuildCoordinator,
  parseIntegrityOutput,
} = require("../src/services/automatic-rebuild-coordinator");
const { withFileLock } = require("../src/lib/file-lock");

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
    "phase:stopping", "stop",
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
