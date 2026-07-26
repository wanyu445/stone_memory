const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { withFileLock } = require("../src/lib/file-lock");
const {
  automaticRebuildPolicyWaitMs,
  withThreadConfigPolicyLock,
} = require("../src/services/thread-setup");

test("policy lock wait budget covers slow stop and health probes", () => {
  assert.equal(automaticRebuildPolicyWaitMs({
    timeoutMs: 20,
    healthTimeoutMs: 30,
    healthIntervalMs: 40,
  }), (2 * 20) + 30 + (2 * 40) + 15_000);
});

test("policy lock acquisition retries with a longer freshly committed config", () => {
  const short = {
    automaticRebuild: {
      lifecycle: {
        timeoutMs: 20,
        healthTimeoutMs: 30,
        healthIntervalMs: 40,
      },
    },
  };
  const long = {
    automaticRebuild: {
      lifecycle: {
        timeoutMs: 600_000,
        healthTimeoutMs: 300_000,
        healthIntervalMs: 10_000,
      },
    },
  };
  let configReads = 0;
  const attemptedBudgets = [];

  const result = withThreadConfigPolicyLock("thread-1", () => "saved", {
    loadThreadConfig() {
      configReads += 1;
      return configReads === 1 ? short : long;
    },
    policyLock(_threadId, operation, { timeoutMs }) {
      attemptedBudgets.push(timeoutMs);
      if (attemptedBudgets.length === 1) {
        const error = new Error("simulated stale-budget timeout");
        error.code = "FILE_LOCK_TIMEOUT";
        throw error;
      }
      return operation();
    },
  });

  assert.equal(result, "saved");
  assert.deepEqual(attemptedBudgets, [
    automaticRebuildPolicyWaitMs(short.automaticRebuild.lifecycle),
    automaticRebuildPolicyWaitMs(long.automaticRebuild.lifecycle),
  ]);
});

test("an invalid thread id is rejected before any policy lock path is created", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-invalid-thread-id-"));
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, "../test-fixtures/invalid-thread-id.js"),
  ], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).error, /真实线程 ID 只能包含/);
  assert.equal(
    fs.existsSync(path.join(home, ".stone_memory", "runtimes", "lock-escape")),
    false,
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test("a failed disabled config save leaves automatic rebuild state exactly unchanged", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-config-failure-"));
  const stone = path.join(home, ".stone_memory");
  const stateDir = path.join(
    stone,
    "runtimes",
    "codex",
    "accompany",
    "thread-1",
    "logs",
  );
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
    "thread-1": {
      ai: "Stone",
      user: "User",
      userGender: "unspecified",
      label: "Thread One",
      runtime: "codex",
      purpose: "accompany",
      sessionDir: path.join(home, "sessions"),
      minerMode: "subagent",
      windowDays: 3,
      keepToolPairs: 30,
      automaticRebuild: {
        enabled: true,
        lifecycle: {
          mode: "managed",
          startCommand: "node agent.js",
          cwd: "/srv/agent",
        },
      },
    },
  }));
  const before = {
    contextUsage: { usedTokens: 90 },
    automaticRebuild: {
      status: "rebuilding",
      rebuildPending: true,
      disableGeneration: 7,
      resumeTurnAdmission: "admitted",
      disableRequestedAt: "2026-07-26T01:00:00.000Z",
      runtimeRunning: false,
      stopAttempted: true,
    },
    updatedAt: "2026-07-26T01:00:00.000Z",
  };
  fs.writeFileSync(
    path.join(stateDir, "rebuild-state.json"),
    JSON.stringify(before),
  );

  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, "../test-fixtures/config-save-failure.js"),
  ], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.match(report.error, /设置未保存.*simulated stmem\.json save failure/);
  assert.equal(report.errorCode, "CONFIG_SAVE_FAILED");
  assert.deepEqual(report.state, before);
});

test("a saved disabled config remains authoritative when state display sync fails", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-state-failure-"));
  const stone = path.join(home, ".stone_memory");
  const stateDir = path.join(
    stone,
    "runtimes",
    "codex",
    "accompany",
    "thread-1",
    "logs",
  );
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
    "thread-1": {
      ai: "Stone",
      user: "User",
      userGender: "unspecified",
      label: "Thread One",
      runtime: "codex",
      purpose: "accompany",
      sessionDir: path.join(home, "sessions"),
      minerMode: "subagent",
      automaticRebuild: {
        enabled: true,
        lifecycle: {
          mode: "managed",
          startCommand: "node agent.js",
          cwd: "/srv/agent",
        },
      },
    },
  }));
  const before = {
    automaticRebuild: {
      status: "rebuild_pending",
      rebuildPending: true,
      disableGeneration: 7,
    },
  };
  fs.writeFileSync(
    path.join(stateDir, "rebuild-state.json"),
    JSON.stringify(before),
  );

  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, "../test-fixtures/config-save-failure.js"),
  ], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      HOME: home,
      STMEM_FAIL_RENAME_TARGET: "rebuild-state.json",
      STMEM_RUN_COORDINATOR: "1",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.match(report.error, /设置已保存.*状态展示暂未同步/);
  assert.equal(report.errorCode, "AUTOMATIC_REBUILD_STATE_SYNC_FAILED");
  assert.equal(report.config["thread-1"].automaticRebuild.enabled, false);
  assert.deepEqual(report.state, before);
  assert.deepEqual(report.coordinatorResult, {
    executed: false,
    reason: "disabled",
  });
  assert.deepEqual(report.events, []);
});

for (const lifecycleMode of ["managed", "supervisor"]) {
  test(`${lifecycleMode} in-flight recovery continues when a disable config save fails`, () => {
    const home = fs.mkdtempSync(path.join(
      os.tmpdir(),
      `stmem-${lifecycleMode}-in-flight-config-failure-`,
    ));
    const stone = path.join(home, ".stone_memory");
    const stateDir = path.join(
      stone,
      "runtimes",
      "codex",
      "accompany",
      "thread-1",
      "logs",
    );
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    const supervisor = lifecycleMode === "supervisor";
    fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
      "thread-1": {
        ai: "Stone",
        user: "User",
        userGender: "unspecified",
        label: "Thread One",
        runtime: "codex",
        purpose: "accompany",
        sessionDir: path.join(home, "sessions"),
        minerMode: "subagent",
        automaticRebuild: {
          enabled: true,
          lifecycle: {
            mode: lifecycleMode,
            startCommand: supervisor ? "svc start" : "node agent.js",
            stopCommand: supervisor ? "svc stop" : null,
            healthCheckCommand: supervisor ? "svc health" : null,
            cwd: supervisor ? null : "/srv/agent",
          },
        },
      },
    }));
    fs.writeFileSync(
      path.join(stateDir, "rebuild-state.json"),
      JSON.stringify({
        automaticRebuild: {
          status: "rebuild_pending",
          rebuildPending: true,
          disableGeneration: 7,
        },
      }),
    );

    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, "../test-fixtures/config-save-failure.js"),
    ], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        HOME: home,
        STMEM_IN_FLIGHT: "1",
        STMEM_LIFECYCLE_MODE: lifecycleMode,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.match(report.error, /设置未保存.*simulated stmem\.json save failure/);
    assert.equal(report.errorCode, "CONFIG_SAVE_FAILED");
    assert.equal(report.config["thread-1"].automaticRebuild.enabled, true);
    assert.equal(report.coordinatorResult.executed, true);
    assert.deepEqual(report.events, ["stop", "rebuild", "check", "start"]);
    assert.equal(report.state.automaticRebuild.rebuildPending, false);
    assert.equal(report.state.automaticRebuild.disableGeneration, 7);
  });
}

test("a successful disable save waits behind the stop policy gate", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-policy-gate-"));
  const stone = path.join(home, ".stone_memory");
  const stateDir = path.join(
    stone,
    "runtimes",
    "codex",
    "accompany",
    "thread-1",
    "logs",
  );
  const signalFile = path.join(home, "disable-ready");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
    "thread-1": {
      ai: "Stone",
      user: "User",
      userGender: "unspecified",
      label: "Thread One",
      runtime: "codex",
      purpose: "accompany",
      sessionDir: path.join(home, "sessions"),
      minerMode: "subagent",
      automaticRebuild: {
        enabled: true,
        lifecycle: {
          mode: "managed",
          startCommand: "node agent.js",
          cwd: "/srv/agent",
        },
      },
    },
  }));
  fs.writeFileSync(
    path.join(stateDir, "rebuild-state.json"),
    JSON.stringify({ automaticRebuild: { status: "watching" } }),
  );

  let child = null;
  t.after(() => {
    if (child?.exitCode == null) child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  });
  let stdout = "";
  let stderr = "";
  let completion;
  await withFileLock(
    path.join(stateDir, "automatic-rebuild-policy.lock"),
    async () => {
      child = spawn(process.execPath, [
        path.resolve(__dirname, "../test-fixtures/config-save-failure.js"),
      ], {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          HOME: home,
          STMEM_FAIL_RENAME_TARGET: "never",
          STMEM_SIGNAL_FILE: signalFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      completion = new Promise(resolve => child.once("close", status => resolve(status)));
      const started = Date.now();
      while (!fs.existsSync(signalFile)) {
        if (Date.now() - started > 2000) throw new Error("disable child did not become ready");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(child.exitCode, null);
      const during = JSON.parse(fs.readFileSync(path.join(stone, "stmem.json"), "utf8"));
      assert.equal(during["thread-1"].automaticRebuild.enabled, true);
    },
    { timeoutMs: 1000, staleMs: 30_000 },
  );

  assert.equal(await completion, 0, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.error, null);
  assert.equal(report.config["thread-1"].automaticRebuild.enabled, false);
});

test("an enabled lifecycle change also waits behind the stop policy gate", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-lifecycle-policy-gate-"));
  const stone = path.join(home, ".stone_memory");
  const stateDir = path.join(
    stone,
    "runtimes",
    "codex",
    "accompany",
    "thread-1",
    "logs",
  );
  const signalFile = path.join(home, "lifecycle-change-ready");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
    "thread-1": {
      ai: "Stone",
      user: "User",
      userGender: "unspecified",
      label: "Thread One",
      runtime: "codex",
      purpose: "accompany",
      sessionDir: path.join(home, "sessions"),
      minerMode: "subagent",
      automaticRebuild: {
        enabled: true,
        lifecycle: {
          mode: "managed",
          startCommand: "node agent.js",
          cwd: "/srv/agent",
          timeoutMs: 600_000,
          healthTimeoutMs: 300_000,
          healthIntervalMs: 10_000,
        },
      },
    },
  }));
  fs.writeFileSync(
    path.join(stateDir, "rebuild-state.json"),
    JSON.stringify({ automaticRebuild: { status: "watching" } }),
  );

  let child = null;
  t.after(() => {
    if (child?.exitCode == null) child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  });
  let stdout = "";
  let stderr = "";
  let completion;
  await withFileLock(
    path.join(stateDir, "automatic-rebuild-policy.lock"),
    async () => {
      child = spawn(process.execPath, [
        path.resolve(__dirname, "../test-fixtures/config-save-failure.js"),
      ], {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          HOME: home,
          STMEM_FAIL_RENAME_TARGET: "never",
          STMEM_SIGNAL_FILE: signalFile,
          STMEM_TARGET_ENABLED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      completion = new Promise(resolve => child.once("close", status => resolve(status)));
      const started = Date.now();
      while (!fs.existsSync(signalFile)) {
        if (Date.now() - started > 2000) throw new Error("lifecycle child did not become ready");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(child.exitCode, null);
      const during = JSON.parse(fs.readFileSync(path.join(stone, "stmem.json"), "utf8"));
      assert.equal(
        during["thread-1"].automaticRebuild.lifecycle.timeoutMs,
        600_000,
      );
    },
    { timeoutMs: 1000, staleMs: 30_000 },
  );

  assert.equal(await completion, 0, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.error, null);
  assert.equal(report.config["thread-1"].automaticRebuild.enabled, true);
  assert.equal(
    report.config["thread-1"].automaticRebuild.lifecycle.timeoutMs,
    20,
  );
});
