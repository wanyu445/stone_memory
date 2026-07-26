const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { withFileLock } = require("../src/lib/file-lock");

const {
  createRuntimeLifecycleController,
  processIdentity,
  runCommand,
} = require("../src/services/runtime-lifecycle");
const { processAlive } = require("../src/lib/process-identity");

test("process identity distinguishes the current process incarnation from its PID", () => {
  assert.match(processIdentity(process.pid), /starttime|created|started/);
});

test("supervisor lifecycle confirms stopped and healthy states with the configured probe", async () => {
  let healthy = true;
  const commands = [];
  const controller = createRuntimeLifecycleController({
    mode: "supervisor",
    stopCommand: "svc stop",
    startCommand: "svc start",
    healthCheckCommand: "svc health",
    cwd: "/srv/agent",
    timeoutMs: 100,
    healthTimeoutMs: 100,
    healthIntervalMs: 1,
  }, {
    commandRunner: async command => {
      commands.push(command);
      if (command === "svc stop") healthy = false;
      if (command === "svc start") healthy = true;
      return { status: command === "svc health" && !healthy ? 1 : 0, stdout: "", stderr: "" };
    },
  });

  await controller.stop();
  await controller.start();

  assert.deepEqual(commands, ["svc stop", "svc health", "svc start", "svc health"]);
});

test("a timed-out lifecycle command rejects only after its whole process group exits", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-command-timeout-"));
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

  await assert.rejects(runCommand(
    `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} parent `
      + JSON.stringify(pidFile),
    { timeoutMs: 100 },
  ), /timed out/);
  descendantPid = Number(fs.readFileSync(pidFile, "utf8"));

  assert.equal(processAlive(descendantPid), false);
});

test("managed lifecycle refuses to stop a process Stone did not start", async () => {
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: "node agent.js",
    cwd: "/srv/agent",
    timeoutMs: 100,
    healthTimeoutMs: 100,
    healthIntervalMs: 1,
  }, {
    threadId: "thread-1",
    state: {
      read: () => ({}),
      setManagedRuntime() {
        throw new Error("must not mutate runtime ownership");
      },
    },
  });

  await assert.rejects(controller.stop(), /没有由 Stone 启动的 runtime/);
});

test("managed lifecycle rejects a shell pipeline it cannot identify safely", () => {
  assert.throws(() => createRuntimeLifecycleController({
    mode: "managed",
    startCommand: "node agent.js | tee agent.log",
    cwd: "/srv/agent",
  }, {
    threadId: "thread-1",
  }), /无法安全识别|直接启动命令/);
});

test("managed lifecycle refuses to start when the same runtime already exists without ownership", async () => {
  let spawned = false;
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: "node agent.js --token very-secret-value",
    cwd: "/srv/agent",
    healthCheckCommand: "curl health",
    healthTimeoutMs: 20,
    healthIntervalMs: 1,
  }, {
    threadId: "thread-1",
    commandRunner: async () => ({ status: 0, stdout: "", stderr: "" }),
    state: {
      read: () => ({}),
      setManagedRuntime() {},
    },
    managedProcess: {
      findMatches: () => [{
        pid: 456,
        executable: "/usr/bin/node",
        cwd: "/srv/agent",
      }],
      async start() { spawned = true; },
      isAlive: () => false,
      status: () => "stopped",
      async stop() {},
    },
  });

  await assert.rejects(controller.start(), error => {
    assert.match(error.message, /拒绝启动/);
    assert.match(error.message, /已有.*runtime|外部.*runtime/);
    assert.doesNotMatch(error.message, /very-secret-value/);
    return true;
  });
  assert.equal(spawned, false);
});

test("managed lifecycle detects a real unowned process with the same command and cwd", async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-managed-duplicate-"));
  const script = "setInterval(() => {}, 1000)";
  const external = spawn(process.execPath, ["-e", script], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  let saved = null;
  t.after(() => {
    for (const pid of [external.pid, saved?.pid].filter(Boolean)) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  await new Promise(resolve => external.once("spawn", resolve));

  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    cwd,
    timeoutMs: 100,
    healthTimeoutMs: 100,
    healthIntervalMs: 5,
  }, {
    threadId: "thread-real-duplicate",
    state: {
      read: () => ({ managedRuntime: saved }),
      setManagedRuntime(_threadId, runtime) { saved = runtime; },
    },
  });

  await assert.rejects(controller.start(), /检测到已有外部 runtime/);
  assert.equal(saved, null);
});

test("managed lifecycle reports a duplicate when an owned runtime has an extra matching instance", async () => {
  const owned = { pid: 123, processGroupId: 123, processIdentity: "owned" };
  let stopCalled = false;
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: "node agent.js",
    cwd: "/srv/agent",
    healthTimeoutMs: 20,
    healthIntervalMs: 1,
  }, {
    threadId: "thread-1",
    state: {
      read: () => ({ managedRuntime: owned }),
      setManagedRuntime() {},
    },
    managedProcess: {
      status: () => "owned",
      isAlive: () => true,
      findMatches: () => [
        { pid: 123, executable: "/usr/bin/node", cwd: "/srv/agent" },
        { pid: 456, executable: "/usr/bin/node", cwd: "/srv/agent" },
      ],
      async start() { throw new Error("must not spawn"); },
      async stop() { stopCalled = true; },
    },
  });

  await assert.rejects(controller.start(), /duplicate|额外.*runtime|重复/);
  await assert.rejects(controller.stop(), /duplicate|额外.*runtime|重复/);
  assert.equal(stopCalled, false);
});

test("managed lifecycle refuses recorded ownership when the owned PID no longer matches the launch spec", async () => {
  const owned = {
    pid: 41,
    processGroupId: 41,
    processIdentity: "starttime:1",
  };
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: `${process.execPath} agent.js`,
    cwd: process.cwd(),
    healthTimeoutMs: 20,
    healthIntervalMs: 1,
  }, {
    threadId: "thread-owned-spec-mismatch",
    state: {
      read: () => ({ managedRuntime: owned }),
      setManagedRuntime() {},
    },
    managedProcess: {
      status: () => "owned",
      isAlive: () => true,
      findMatches: async () => [],
      async start() { throw new Error("must not spawn"); },
      async stop() { throw new Error("must not stop"); },
    },
  });

  await assert.rejects(controller.start(), /身份|归属|匹配/);
  await assert.rejects(controller.stop(), /身份|归属|匹配/);
});

test("managed lifecycle records and stops only the process group it started", async () => {
  let saved = null;
  let alive = false;
  let spawnCount = 0;
  const state = {
    read: () => ({ managedRuntime: saved }),
    setManagedRuntime(_threadId, runtime) {
      saved = runtime;
    },
  };
  const managedProcess = {
    async start() {
      spawnCount += 1;
      alive = true;
      return { pid: 123, processGroupId: 123 };
    },
    isAlive: () => alive,
    async stop(runtime) {
      assert.equal(runtime.processGroupId, 123);
      alive = false;
    },
  };
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: "node agent.js",
    cwd: "/srv/agent",
    timeoutMs: 100,
    healthTimeoutMs: 100,
    healthIntervalMs: 1,
  }, { threadId: "thread-1", state, managedProcess });

  const first = await controller.start();
  assert.deepEqual(saved, { pid: 123, processGroupId: 123 });
  const second = await controller.start();
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(spawnCount, 1);
  await controller.stop();
  assert.equal(saved.pid, 123);
  assert.equal(saved.processGroupId, 123);
  assert.match(saved.stoppedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(await controller.health().then(result => result.healthy), false);
});

test("managed lifecycle refuses a live PID whose process identity no longer matches", async () => {
  const runtime = {
    pid: process.pid,
    processIdentity: "a-different-process-incarnation",
  };
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: "node agent.js",
    cwd: "/srv/agent",
    timeoutMs: 100,
    healthTimeoutMs: 100,
    healthIntervalMs: 1,
  }, {
    threadId: "thread-1",
    state: {
      read: () => ({ managedRuntime: runtime }),
      setManagedRuntime() {
        throw new Error("must not replace unverifiable ownership");
      },
    },
    managedProcess: {
      status: () => "unknown",
      isAlive: () => false,
      async start() {
        throw new Error("must not start a duplicate runtime");
      },
      async stop() {
        throw new Error("must not stop an unknown runtime");
      },
    },
  });

  await assert.rejects(controller.stop(), /无法确认.*归属/);
  await assert.rejects(controller.start(), /无法确认.*归属/);
});

test("managed lifecycle does not call a just-spawned process healthy unless it stays alive", async () => {
  let saved = null;
  let probes = 0;
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: "node broken-agent.js",
    cwd: "/srv/agent",
    timeoutMs: 20,
    healthTimeoutMs: 20,
    healthIntervalMs: 1,
  }, {
    threadId: "thread-1",
    state: {
      read: () => ({ managedRuntime: saved }),
      setManagedRuntime(_threadId, runtime) { saved = runtime; },
    },
    managedProcess: {
      status: () => "stopped",
      async start() { return { pid: 123, processIdentity: "test" }; },
      isAlive() {
        probes += 1;
        return probes < 2;
      },
      async stop() {},
    },
  });

  await assert.rejects(controller.start(), /did not remain healthy/);
});

test("managed lifecycle does not accept an old healthy endpoint when the new owned process exited", async () => {
  let saved = null;
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: "node agent.js",
    cwd: "/srv/agent",
    healthCheckCommand: "curl health",
    timeoutMs: 20,
    healthTimeoutMs: 20,
    healthIntervalMs: 1,
  }, {
    threadId: "thread-1",
    state: {
      read: () => ({ managedRuntime: saved }),
      setManagedRuntime(_threadId, runtime) { saved = runtime; },
    },
    commandRunner: async () => ({ status: 0, stdout: "", stderr: "" }),
    managedProcess: {
      status: runtime => runtime ? "stopped" : "stopped",
      findMatches: () => saved ? [{ pid: saved.pid }] : [],
      async start() {
        return { pid: 123, processGroupId: 123, processIdentity: "spawned" };
      },
      isAlive: () => false,
      async stop() {},
    },
  });

  await assert.rejects(controller.start(), /owned|归属|存活|healthy/);
});

test("managed lifecycle stops a newly spawned runtime when ownership persistence fails", async () => {
  let alive = false;
  let stopped = false;
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: "node agent.js",
    cwd: "/srv/agent",
    timeoutMs: 20,
    healthTimeoutMs: 20,
    healthIntervalMs: 1,
  }, {
    threadId: "thread-1",
    state: {
      read: () => ({}),
      setManagedRuntime() { throw new Error("state disk unavailable"); },
    },
    managedProcess: {
      status: () => alive ? "owned" : "stopped",
      findMatches: () => [],
      async start() {
        alive = true;
        return { pid: 123, processGroupId: 123, processIdentity: "spawned" };
      },
      isAlive: () => alive,
      async stop() {
        stopped = true;
        alive = false;
      },
    },
  });

  await assert.rejects(controller.start(), /state disk unavailable/);
  assert.equal(stopped, true);
  assert.equal(alive, false);
});

test("ownership persistence failure leaves no real managed process group alive", async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-managed-persist-fail-"));
  const script = "setInterval(() => {}, 1000)";
  let spawnedRuntime = null;
  t.after(() => {
    if (spawnedRuntime?.processGroupId) {
      try { process.kill(-spawnedRuntime.processGroupId, "SIGKILL"); } catch {}
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    cwd,
    timeoutMs: 500,
    healthTimeoutMs: 500,
    healthIntervalMs: 5,
  }, {
    threadId: "thread-real-persist-fail",
    state: {
      read: () => ({}),
      setManagedRuntime(_threadId, runtime) {
        spawnedRuntime = runtime;
        throw new Error("state disk unavailable");
      },
    },
  });

  await assert.rejects(controller.start(), /state disk unavailable/);
  assert.ok(spawnedRuntime?.processGroupId);
  assert.throws(
    () => process.kill(-spawnedRuntime.processGroupId, 0),
    error => error.code === "ESRCH",
  );
});

test("a duplicate appearing after spawn stops only the new owned runtime", async () => {
  let saved = null;
  let newAlive = false;
  let externalAlive = true;
  let scans = 0;
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: "node agent.js",
    cwd: "/srv/agent",
    timeoutMs: 20,
    healthTimeoutMs: 20,
    healthIntervalMs: 1,
  }, {
    threadId: "thread-1",
    state: {
      read: () => ({ managedRuntime: saved }),
      setManagedRuntime(_threadId, runtime) { saved = runtime; },
    },
    managedProcess: {
      status: runtime => runtime && newAlive ? "owned" : "stopped",
      findMatches() {
        scans += 1;
        if (scans === 1) return [];
        return [
          { pid: 123, executable: "/usr/bin/node", cwd: "/srv/agent" },
          { pid: 456, executable: "/usr/bin/node", cwd: "/srv/agent" },
        ];
      },
      async start() {
        newAlive = true;
        return { pid: 123, processGroupId: 123, processIdentity: "spawned" };
      },
      isAlive: () => newAlive,
      async stop(runtime) {
        assert.equal(runtime.pid, 123);
        newAlive = false;
      },
    },
  });

  await assert.rejects(controller.start(), /额外|重复|duplicate/);
  assert.equal(newAlive, false);
  assert.equal(externalAlive, true);
  assert.equal(saved, null);
});

test("two concurrent managed starts create at most one Stone-owned runtime", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-managed-start-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let saved = null;
  let spawnCount = 0;
  const controller = createRuntimeLifecycleController({
    mode: "managed",
    startCommand: "node agent.js",
    cwd: "/srv/agent",
    timeoutMs: 100,
    healthTimeoutMs: 20,
    healthIntervalMs: 1,
  }, {
    threadId: "thread-1",
    withLifecycleLock: (_threadId, operation) => withFileLock(
      path.join(root, "lifecycle.lock"),
      operation,
      { timeoutMs: 500 },
    ),
    state: {
      read: () => ({ managedRuntime: saved }),
      setManagedRuntime(_threadId, runtime) { saved = runtime; },
    },
    managedProcess: {
      status: runtime => runtime ? "owned" : "stopped",
      findMatches: () => saved ? [{ pid: saved.pid }] : [],
      async start() {
        spawnCount += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        return { pid: 100 + spawnCount, processIdentity: `owned-${spawnCount}` };
      },
      isAlive: runtime => Boolean(runtime),
      async stop() {},
    },
  });

  const results = await Promise.all([controller.start(), controller.start()]);

  assert.equal(spawnCount, 1);
  assert.deepEqual(results.map(result => result.started).sort(), [false, true]);
});
