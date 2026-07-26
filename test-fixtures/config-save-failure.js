const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const configPath = path.join(os.homedir(), ".stone_memory", "stmem.json");
const statePath = path.join(
  os.homedir(),
  ".stone_memory",
  "runtimes",
  "codex",
  "accompany",
  "thread-1",
  "logs",
  "rebuild-state.json",
);
const originalRename = fs.renameSync;
fs.renameSync = function failConfigRename(source, target) {
  const failTarget = process.env.STMEM_FAIL_RENAME_TARGET || "stmem.json";
  if (path.basename(target) === failTarget) {
    const error = new Error(`simulated ${failTarget} save failure`);
    error.code = "EIO";
    throw error;
  }
  return originalRename.call(this, source, target);
};

function disabledThreadInput(lifecycleMode) {
  const supervisor = lifecycleMode === "supervisor";
  const enabled = process.env.STMEM_TARGET_ENABLED === "1";
  return {
    libraryName: "Thread One",
    threadId: "thread-1",
    ai: "Stone",
    user: "User",
    userGender: "unspecified",
    runtime: "codex",
    purpose: "accompany",
    sessionDir: path.join(os.homedir(), "sessions"),
    minerMode: "subagent",
    windowDays: 3,
    keepToolPairs: 30,
    automaticRebuild: {
      enabled,
      lifecycle: {
        mode: lifecycleMode,
        startCommand: supervisor ? "svc start" : "node agent.js",
        stopCommand: supervisor ? "svc stop" : null,
        healthCheckCommand: supervisor ? "svc health" : null,
        cwd: supervisor ? null : "/srv/agent",
        timeoutMs: enabled ? 20 : undefined,
        healthTimeoutMs: enabled ? 30 : undefined,
        healthIntervalMs: enabled ? 40 : undefined,
      },
    },
  };
}

function attemptDisable(lifecycleMode) {
  const { createThread } = require("../src/services/thread-setup");
  if (process.env.STMEM_SIGNAL_FILE) {
    fs.writeFileSync(process.env.STMEM_SIGNAL_FILE, "ready");
  }
  try {
    createThread(disabledThreadInput(lifecycleMode), {
      allowExisting: true,
      requireSession: false,
    });
    return null;
  } catch (cause) {
    return cause;
  }
}

async function runInFlightSaveFailure(events, lifecycleMode) {
  const {
    createAutomaticRebuildCoordinator,
  } = require("../src/services/automatic-rebuild-coordinator");
  try {
    let disableError = null;
    const coordinator = createAutomaticRebuildCoordinator({
      lifecycleFactory: () => ({
        async stop() {
          events.push("stop");
          disableError = attemptDisable(lifecycleMode);
        },
        async start() { events.push("start"); },
      }),
      rebuildRunner: {
        async apply() { events.push("rebuild"); return { stdout: "rebuilt" }; },
        async check() { events.push("check"); return { healthy: true }; },
      },
      withThreadLock: async (_threadId, operation) => operation(),
      withPolicyLock: async (_threadId, operation) => operation(),
    });
    const coordinatorResult = await coordinator.executePendingRebuild("thread-1", {
      turnSettled: true,
    });
    return { error: disableError, coordinatorResult };
  } catch (error) {
    return { error, coordinatorResult: null };
  }
}

async function main() {
  const events = [];
  const lifecycleMode = process.env.STMEM_LIFECYCLE_MODE || "managed";
  let error = null;
  let coordinatorResult = null;
  if (process.env.STMEM_IN_FLIGHT === "1") {
    ({ error, coordinatorResult } = await runInFlightSaveFailure(
      events,
      lifecycleMode,
    ));
  } else {
    error = attemptDisable(lifecycleMode);
  }
  fs.renameSync = originalRename;

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (process.env.STMEM_RUN_COORDINATOR === "1") {
    const {
      createAutomaticRebuildCoordinator,
    } = require("../src/services/automatic-rebuild-coordinator");
    const coordinator = createAutomaticRebuildCoordinator({
      loadThreadConfig: threadId => config[threadId] || {},
      state: {
        read() { throw new Error("disabled coordinator must not read state"); },
      },
      lifecycleFactory: () => ({
        async stop() { events.push("stop"); },
        async start() { events.push("start"); },
      }),
      rebuildRunner: {
        async apply() { events.push("rebuild"); return { stdout: "" }; },
      },
    });
    coordinatorResult = await coordinator.executePendingRebuild("thread-1", {
      turnSettled: true,
    });
  }
  process.stdout.write(JSON.stringify({
    error: error?.message || null,
    errorCode: error?.code || null,
    config,
    state: JSON.parse(fs.readFileSync(statePath, "utf8")),
    coordinatorResult,
    events,
  }));
}

main().catch(error => {
  process.stderr.write(error.stack || error.message);
  process.exit(1);
});
