const test = require("node:test");
const assert = require("node:assert/strict");

const {
  recordWatcherContextUsage,
  runWatcherFlushPass,
} = require("../src/services/watcher-context-usage");
const {
  createAutomaticRebuildCoordinator,
} = require("../src/services/automatic-rebuild-coordinator");

test("disabled automatic rebuild still records watcher usage without creating pending", () => {
  const events = [];
  let pending = false;
  const config = {
    runtime: "codex",
    automaticRebuild: { enabled: false },
  };
  const coordinator = createAutomaticRebuildCoordinator({
    loadThreadConfig: () => config,
    readContextUsage: () => ({ detectedMaxTokens: 100 }),
    state: {
      read: () => ({ rebuildPending: pending }),
      observeUsage() {
        pending = true;
        return { rebuildPending: pending };
      },
    },
  });

  const result = recordWatcherContextUsage("thread-1", {
    usedTokens: 90,
    detectedMaxTokens: 100,
  }, config, {
    update(_threadId, usage) {
      events.push("usage-updated");
      return usage;
    },
    observe: coordinator.observeThreadUsage,
  });

  assert.deepEqual(events, ["usage-updated"]);
  assert.equal(result.automaticRebuild.enabled, false);
  assert.equal(pending, false);
});

test("disabled automatic rebuild does not stop watcher archive, mining, or usage work", async () => {
  const events = [];
  const config = {
    runtime: "codex",
    automaticRebuild: { enabled: false },
  };

  const result = await runWatcherFlushPass("thread-1", config, {
    archiveEnabled: true,
    async sync() { events.push("archive"); },
    scanLatestArchiveDate() {
      events.push("scan");
      return "2026-07-26";
    },
    previousArchiveDate: "2026-07-25",
    async mine() { events.push("mine"); },
    readUsage() {
      events.push("read-usage");
      return { usedTokens: 90, detectedMaxTokens: 100 };
    },
    recordUsage(_threadId, _usage, threadConfig) {
      events.push(`record-usage:${threadConfig.automaticRebuild.enabled}`);
    },
  });

  assert.deepEqual(events, [
    "archive",
    "scan",
    "mine",
    "read-usage",
    "record-usage:false",
  ]);
  assert.equal(result.latestArchiveDate, "2026-07-26");
});
