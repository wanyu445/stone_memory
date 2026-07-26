const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRuntimeLifecycleController,
  processIdentity,
} = require("../src/services/runtime-lifecycle");

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

test("managed lifecycle records and stops only the process group it started", async () => {
  let saved = null;
  let alive = false;
  const state = {
    read: () => ({ managedRuntime: saved }),
    setManagedRuntime(_threadId, runtime) {
      saved = runtime;
    },
  };
  const managedProcess = {
    async start() {
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

  await controller.start();
  assert.deepEqual(saved, { pid: 123, processGroupId: 123 });
  await controller.stop();
  assert.equal(saved, null);
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
