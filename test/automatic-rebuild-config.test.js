const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_TRIGGER_RATIO,
  resolveAutomaticRebuildConfig,
  resolveTriggerThreshold,
} = require("../src/services/automatic-rebuild-config");
const {
  automaticRebuildConfig,
  validateThreadInput,
} = require("../src/services/thread-setup");
const { INIT_SCHEMA, buildInitTemplate } = require("../src/services/init-contract");

test("automatic rebuild defaults on but cannot execute without an explicit lifecycle", () => {
  const config = resolveAutomaticRebuildConfig({});

  assert.equal(config.enabled, true);
  assert.equal(config.triggerRatio, DEFAULT_TRIGGER_RATIO);
  assert.equal(config.ready, false);
  assert.match(config.errors.join("\n"), /lifecycle/);
});

test("triggerTokens overrides ratio and a manual context maximum overrides detection", () => {
  const result = resolveTriggerThreshold({
    contextWindowTokens: 1_000_000,
    automaticRebuild: {
      triggerTokens: 700_000,
      lifecycle: {
        mode: "supervisor",
        stopCommand: "stop",
        startCommand: "start",
        healthCheckCommand: "health",
      },
    },
  }, { detectedMaxTokens: 200_000 });

  assert.equal(result.maxTokens, 1_000_000);
  assert.equal(result.thresholdTokens, 700_000);
  assert.equal(result.config.ready, true);
});

test("ratio uses the detected maximum when no overrides are configured", () => {
  const result = resolveTriggerThreshold({
    automaticRebuild: {
      lifecycle: {
        mode: "managed",
        startCommand: "node agent.js",
        cwd: "/srv/agent",
      },
    },
  }, { detectedMaxTokens: 200_000 });

  assert.equal(result.thresholdTokens, 172_000);
  assert.equal(result.config.ready, true);
});

test("disabled automatic rebuild needs no lifecycle and leaves other validation quiet", () => {
  const config = resolveAutomaticRebuildConfig({
    automaticRebuild: { enabled: false },
  });

  assert.equal(config.enabled, false);
  assert.equal(config.ready, false);
  assert.deepEqual(config.errors, []);
});

test("supervisor mode requires stop, start, and health commands", () => {
  const config = resolveAutomaticRebuildConfig({
    automaticRebuild: {
      lifecycle: { mode: "supervisor", startCommand: "start" },
    },
  });

  assert.match(config.errors.join("\n"), /stopCommand/);
  assert.match(config.errors.join("\n"), /healthCheckCommand/);
});

test("init schema and storage keep automatic rebuild enabled without inventing lifecycle commands", () => {
  assert.equal(INIT_SCHEMA.properties.automaticRebuild.properties.enabled.default, true);
  assert.deepEqual(buildInitTemplate("codex").automaticRebuild, { enabled: true });
  assert.deepEqual(automaticRebuildConfig(undefined), { enabled: true });
  assert.deepEqual(automaticRebuildConfig({
    enabled: true,
    lifecycle: {
      mode: "managed",
      startCommand: "node agent.js",
      cwd: "/srv/agent",
    },
  }), {
    enabled: true,
    lifecycle: {
      mode: "managed",
      startCommand: "node agent.js",
      stopCommand: null,
      healthCheckCommand: null,
      cwd: "/srv/agent",
    },
  });
});

test("batch validation rejects automatic rebuild values outside the published schema", () => {
  const base = {
    libraryName: "Test",
    threadId: "thread-1",
    ai: "AI",
    user: "User",
    runtime: "codex",
    purpose: "coding",
    sessionDir: "/tmp/sessions",
    minerMode: "subagent",
  };

  assert.throws(() => validateThreadInput({
    ...base,
    automaticRebuild: {
      lifecycle: { mode: "mystery" },
    },
  }, {}), /mode/);
  assert.throws(() => automaticRebuildConfig({
    enabled: true,
    unexpected: true,
  }), /unexpected/);
  assert.throws(() => automaticRebuildConfig({
    lifecycle: {
      mode: "managed",
      startCommand: "node agent.js",
      cwd: "/srv/agent",
      timeoutMs: 1.5,
    },
  }), /timeoutMs/);
});
