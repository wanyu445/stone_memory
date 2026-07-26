const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  handleClaudeStop,
  handleClaudeTurnGate,
  handleCodexNotification,
  reportClaudeContextWindow,
  resolveClaudeThreadId,
} = require("../src/services/automatic-rebuild-adapters");
const {
  installClaudeAdapters,
  uninstallClaudeAdapters,
} = require("../src/services/claude-adapter-installation");
const {
  parseNotification,
} = require("../scripts/stmem-codex-adapter");

test("Claude status-line payload records the effective maximum for its registered session", () => {
  const updates = [];
  const result = reportClaudeContextWindow({
    session_id: "claude-thread",
    context_window: { context_window_size: 200_000 },
  }, {
    config: { "claude-thread": { runtime: "claude" } },
    updateDetected: (threadId, detected) => updates.push({ threadId, detected }),
  });

  assert.equal(result.threadId, "claude-thread");
  assert.equal(updates[0].detected.detectedMaxTokens, 200_000);
  assert.equal(updates[0].detected.detectedSource, "claude_status_line");
});

test("Claude transcript matching never guesses between prefix-related thread ids", () => {
  const config = {
    "abc-123": { runtime: "claude" },
    "abc-123-longer": { runtime: "claude" },
  };

  assert.equal(resolveClaudeThreadId({
    transcript_path: "/tmp/abc-123-longer.jsonl",
  }, config), "abc-123-longer");
  assert.equal(resolveClaudeThreadId({
    transcript_path: "/tmp/archive-abc-123-longer-copy.jsonl",
  }, config), null);
});

test("Claude prompt gate blocks a registered thread while rebuild is pending", () => {
  const result = handleClaudeTurnGate({
    session_id: "claude-thread",
    hook_event_name: "UserPromptSubmit",
  }, {
    config: { "claude-thread": { runtime: "claude" } },
    blocked: threadId => threadId === "claude-thread",
  });

  assert.deepEqual(result, {
    handled: true,
    threadId: "claude-thread",
    blocked: true,
  });
});

test("Claude Stop and Codex turn/completed normalize to the same settled-turn entry", async () => {
  const calls = [];
  const execute = async threadId => {
    calls.push(threadId);
    return { executed: true };
  };

  await handleClaudeStop({ session_id: "claude-thread", hook_event_name: "Stop" }, {
    config: { "claude-thread": { runtime: "claude" } },
    execute,
  });
  await handleCodexNotification({
    method: "turn/completed",
    params: {
      threadId: "codex-thread",
      turn: { id: "turn-1", status: "completed" },
    },
  }, {
    config: { "codex-thread": { runtime: "codex" } },
    execute,
  });

  assert.deepEqual(calls, ["claude-thread", "codex-thread"]);
});

test("Codex adapter ignores non-terminal notifications", async () => {
  let called = false;
  const result = await handleCodexNotification({
    method: "turn/started",
    params: { threadId: "codex-thread", turn: { status: "inProgress" } },
  }, { execute: async () => { called = true; } });

  assert.equal(result.handled, false);
  assert.equal(called, false);
});

test("Codex CLI agent-turn-complete notify payload reaches the same settled-turn entry", async () => {
  const calls = [];
  const result = await handleCodexNotification({
    type: "agent-turn-complete",
    "thread-id": "codex-cli-thread",
    "turn-id": "turn-2",
  }, {
    config: { "codex-cli-thread": { runtime: "codex" } },
    execute: async threadId => {
      calls.push(threadId);
      return { executed: false, reason: "not_pending" };
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["codex-cli-thread"]);
});

test("Codex adapter refuses a registered Claude thread id", async () => {
  let called = false;
  const result = await handleCodexNotification({
    method: "turn/completed",
    params: {
      threadId: "claude-thread",
      turn: { id: "turn-1", status: "completed" },
    },
  }, {
    config: { "claude-thread": { runtime: "claude" } },
    execute: async () => { called = true; },
  });

  assert.equal(result.handled, false);
  assert.equal(result.reason, "runtime_mismatch");
  assert.equal(called, false);
});

test("Codex notify bridge accepts the JSON command-line argument used by the CLI", () => {
  const payload = parseNotification([
    JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": "codex-cli-thread",
      "turn-id": "turn-3",
    }),
  ], () => {
    throw new Error("stdin must not be read when Codex supplies an argument");
  });

  assert.equal(payload.type, "agent-turn-complete");
  assert.equal(payload["thread-id"], "codex-cli-thread");
});

test("Claude adapter installation preserves and restores existing status line and Stop hooks", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-claude-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, "settings.json");
  const statePath = path.join(root, "adapter.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    statusLine: { type: "command", command: "existing-status", padding: 2 },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "existing-stop" }] }],
      UserPromptSubmit: [{
        hooks: [{ type: "command", command: "existing-prompt-hook" }],
      }],
    },
  }));
  const options = {
    settingsPath,
    statePath,
    nodePath: "/usr/bin/node",
    adapterScriptPath: "/opt/stone/scripts/stmem-claude-adapter.js",
  };

  installClaudeAdapters(options);
  installClaudeAdapters(options);
  installClaudeAdapters({
    ...options,
    nodePath: "/new/node",
    adapterScriptPath: "/new/stone/scripts/stmem-claude-adapter.js",
  });
  const installed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(installed.statusLine.padding, 2);
  assert.match(installed.statusLine.command, /--status-line/);
  assert.match(installed.statusLine.command, /new\/stone/);
  assert.equal(installed.hooks.Stop.length, 2);
  assert.equal(installed.hooks.Stop[1].hooks[0].timeout, 35 * 60);
  assert.equal(installed.hooks.UserPromptSubmit.length, 2);
  assert.match(installed.hooks.UserPromptSubmit[1].hooks[0].command, /--gate/);

  uninstallClaudeAdapters({
    ...options,
    nodePath: "/new/node",
    adapterScriptPath: "/new/stone/scripts/stmem-claude-adapter.js",
  });
  const restored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(restored.statusLine, {
    type: "command",
    command: "existing-status",
    padding: 2,
  });
  assert.deepEqual(restored.hooks.Stop, [
    { hooks: [{ type: "command", command: "existing-stop" }] },
  ]);
  assert.deepEqual(restored.hooks.UserPromptSubmit, [
    { hooks: [{ type: "command", command: "existing-prompt-hook" }] },
  ]);
});

test("Claude adapter refuses to overwrite malformed user settings", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-claude-malformed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, "settings.json");
  const statePath = path.join(root, "adapter.json");
  fs.writeFileSync(settingsPath, '{"statusLine":');

  assert.throws(() => installClaudeAdapters({
    settingsPath,
    statePath,
    nodePath: "/usr/bin/node",
    adapterScriptPath: "/opt/stone/scripts/stmem-claude-adapter.js",
  }), /JSON|Unexpected/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), '{"statusLine":');
  assert.equal(fs.existsSync(statePath), false);
});

test("Claude adapter refuses an orphaned Stone wrapper without migration state", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-claude-orphan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, "settings.json");
  const statePath = path.join(root, "adapter.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    statusLine: {
      type: "command",
      command: '"/usr/bin/node" "/opt/stone/scripts/stmem-claude-adapter.js" --status-line',
    },
  }));

  assert.throws(() => installClaudeAdapters({
    settingsPath,
    statePath,
    nodePath: "/usr/bin/node",
    adapterScriptPath: "/opt/stone/scripts/stmem-claude-adapter.js",
  }), /迁移状态缺失/);
});
