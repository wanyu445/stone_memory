const test = require("node:test");
const assert = require("node:assert/strict");

const {
  inspectManagedRuntimeOwnership,
} = require("../src/services/managed-runtime-inspector");

const runtime = {
  pid: 123,
  processGroupId: 123,
  processIdentity: "owned-incarnation",
};
const lifecycle = {
  startCommand: "node agent.js --token very-secret-value",
  cwd: "/srv/agent",
};

function inspect(overrides = {}) {
  return inspectManagedRuntimeOwnership(runtime, lifecycle, {
    alive: () => true,
    identity: () => "owned-incarnation",
    parseStartCommand: () => ({ command: "/usr/bin/node", args: ["agent.js"], cwd: "/srv/agent" }),
    findMatches: () => [{ ...runtime }],
    ...overrides,
  });
}

test("managed ownership inspection reports a live unique owned runtime", () => {
  assert.deepEqual(inspect(), {
    running: true,
    reason: "owned_unique_runtime",
  });
});

test("managed ownership inspection reports a recorded process that has exited", () => {
  assert.deepEqual(inspect({ alive: () => false }), {
    running: false,
    reason: "owned_runtime_exited",
  });
});

test("a stopped ownership record stays unknown when a matching instance exists", () => {
  const stopped = {
    ...runtime,
    stoppedAt: "2026-07-26T02:00:00.000Z",
  };
  const clear = inspectManagedRuntimeOwnership(stopped, lifecycle, {
    parseStartCommand: () => ({ command: "/usr/bin/node", args: ["agent.js"], cwd: "/srv/agent" }),
    findMatches: () => [],
  });
  const conflict = inspectManagedRuntimeOwnership(stopped, lifecycle, {
    parseStartCommand: () => ({ command: "/usr/bin/node", args: ["agent.js"], cwd: "/srv/agent" }),
    findMatches: () => [{ ...runtime }],
  });

  assert.deepEqual(clear, {
    running: false,
    reason: "owned_runtime_recorded_stopped",
  });
  assert.deepEqual(conflict, {
    running: null,
    reason: "runtime_instances_present_after_recorded_stop",
  });
});

test("managed ownership inspection keeps identity loss and duplicates unknown", () => {
  const identityLost = inspect({ identity: () => "replacement-incarnation" });
  const duplicate = inspect({
    findMatches: () => [{ ...runtime }, {
      pid: 456,
      processGroupId: 456,
      processIdentity: "other-incarnation",
    }],
  });

  assert.deepEqual(identityLost, {
    running: null,
    reason: "runtime_identity_mismatch",
  });
  assert.deepEqual(duplicate, {
    running: null,
    reason: "duplicate_runtime_instances",
  });
});

test("managed ownership inspection never exposes a configured command secret", () => {
  const result = inspect({
    parseStartCommand() {
      throw new Error("very-secret-value could not be parsed");
    },
  });

  assert.deepEqual(result, {
    running: null,
    reason: "runtime_inspection_unavailable",
  });
  assert.doesNotMatch(JSON.stringify(result), /very-secret-value/);
});
