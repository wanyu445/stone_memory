const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  enqueueRebuild,
  readQueue,
  removeQueuedRebuild,
  discardQueuedRebuild,
  claimQueuedRebuilds,
  finishQueuedRebuildClaim,
  buildQueuedApplyArgs,
} = require("../src/services/rebuild-queue");
const { isUnsafeActiveClaudeApply } = require("../src/services/rebuild-request");

test("direct apply is blocked only inside an active Claude Code session", () => {
  assert.equal(isUnsafeActiveClaudeApply("claude", { CLAUDE_CODE_SESSION_ID: "session-1" }), true);
  assert.equal(isUnsafeActiveClaudeApply("claude", { CLAUDE_CODE_SESSION_ID: "  " }), false);
  assert.equal(isUnsafeActiveClaudeApply("claude", {}), false);
  assert.equal(isUnsafeActiveClaudeApply("codex", { CLAUDE_CODE_SESSION_ID: "session-1" }), false);
});

test("direct apply distinguishes the running session from inherited env vars", () => {
  const alive = () => true;
  const dead = () => false;
  const unknown = () => null;
  const env = { CLAUDE_CODE_SESSION_ID: "session-1", CLAUDE_PID: "12345" };
  // same thread, session still running: block
  assert.equal(isUnsafeActiveClaudeApply("claude", env, { threadId: "session-1", isProcessAlive: alive }), true);
  // same thread, but the session that exported the vars already exited (detached script): allow
  assert.equal(isUnsafeActiveClaudeApply("claude", env, { threadId: "session-1", isProcessAlive: dead }), false);
  // rebuilding a different thread from inside a session never touches this session's chain: allow
  assert.equal(isUnsafeActiveClaudeApply("claude", env, { threadId: "other-thread", isProcessAlive: alive }), false);
  // liveness unknown (no CLAUDE_PID): stay conservative
  assert.equal(isUnsafeActiveClaudeApply("claude", { CLAUDE_CODE_SESSION_ID: "session-1" }, { threadId: "session-1", isProcessAlive: unknown }), true);
  assert.equal(isUnsafeActiveClaudeApply("claude", { CLAUDE_CODE_SESSION_ID: "session-1" }, { threadId: "session-1" }), true);
});

test("rebuild queue keeps one latest request per thread and applies through CLI args", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-queue-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  enqueueRebuild({ threadId: "a", window: 3, toolPairs: 10 }, file);
  enqueueRebuild({ threadId: "b", window: 4, toolPairs: 20 }, file);
  enqueueRebuild({ threadId: "a", window: 7, toolPairs: 30, watermark: true }, file);
  const rows = readQueue(file);
  assert.deepEqual(rows.map(row => row.threadId), ["b", "a"]);
  assert.notEqual(rows[0].requestId, rows[1].requestId);
  assert.deepEqual(buildQueuedApplyArgs(rows[1]), [
    "rebuild", "--thread", "a", "--window", "7", "--tool-pairs", "30",
    "--summary-limit", "0", "--min-importance", "0", "--trigger", "mcp", "--watermark", "--apply",
  ]);
  removeQueuedRebuild("a", file);
  assert.deepEqual(readQueue(file).map(row => row.threadId), ["b"]);
});

test("Codex apply cleanup discards stale pending and processing rows for one thread", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-discard-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  enqueueRebuild({ threadId: "codex-a", window: 3 }, file);
  enqueueRebuild({ threadId: "claude-b", window: 4 }, file);
  const claim = claimQueuedRebuilds(file, { marker: path.basename(process.argv[1]) });
  enqueueRebuild({ threadId: "codex-a", window: 9 }, file);
  discardQueuedRebuild("codex-a", file);
  assert.deepEqual(readQueue(file).map(row => row.threadId), []);
  assert.deepEqual(readQueue(claim.processingFile).map(row => row.threadId), ["claude-b"]);
  finishQueuedRebuildClaim(claim, file);
  assert.deepEqual(readQueue(file).map(row => row.threadId), ["claude-b"]);
});

test("an old consumer cannot remove a newer request for the same thread", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-queue-race-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldRequest = enqueueRebuild({ threadId: "thread-race", window: 3 }, file);
  const newRequest = enqueueRebuild({ threadId: "thread-race", window: 9 }, file);
  removeQueuedRebuild("thread-race", file, oldRequest);
  assert.deepEqual(readQueue(file).map(row => [row.threadId, row.context.windowDays]), [["thread-race", 9]]);
  removeQueuedRebuild("thread-race", file, newRequest);
  assert.deepEqual(readQueue(file), []);
});

test("rebuild queue preserves an explicit trim plan until the next MCP startup", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-queue-plan-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  enqueueRebuild({
    threadId: "thread-plan",
    window: 3,
    toolPairs: 12,
    excludedMessages: ["message-1", "message-1"],
    excludedTools: ["tool-1"],
  }, file);
  const [row] = readQueue(file);
  assert.deepEqual(row.trim.excludedMessages, ["message-1"]);
  assert.deepEqual(row.trim.excludedTools, ["tool-1"]);
  assert.deepEqual(buildQueuedApplyArgs(row, { planFile: "/tmp/plan.json" }).slice(-3), [
    "--apply", "--plan", "/tmp/plan.json",
  ]);
});

test("rebuild queue keeps the entry trigger so immediate and delayed consumers report correctly", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-queue-trigger-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  enqueueRebuild({ threadId: "thread-web", trigger: "web" }, file);
  const [row] = readQueue(file);
  assert.equal(row.trigger, "web");
  assert.match(buildQueuedApplyArgs(row).join(" "), /--trigger web/);
});

test("rebuild queue persists the same structured request used by Web and MCP", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-structured-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  enqueueRebuild({
    threadId: "thread-structured",
    summary: { mode: "limited", limit: 200, minImportance: 3 },
    context: { mode: "watermark", windowDays: 5, toolPairs: 30 },
    trim: { excludedMessages: ["m1"], excludedTools: ["t1"] },
    trigger: "web",
  }, file);
  const [row] = readQueue(file);
  assert.deepEqual({ summary: row.summary, context: row.context, trim: row.trim, trigger: row.trigger }, {
    summary: { mode: "limited", limit: 200, minImportance: 3 },
    context: { mode: "watermark", windowDays: 5, toolPairs: 30 },
    trim: { excludedMessages: ["m1"], excludedTools: ["t1"] },
    trigger: "web",
  });
});

test("rebuild queue carries the target binding for multi-window memories", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-queue-binding-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  enqueueRebuild({ threadId: "memory-a", bindingId: "binding-2", window: 3, toolPairs: 30 }, file);
  const [row] = readQueue(file);
  assert.equal(row.bindingId, "binding-2");
  assert.deepEqual(buildQueuedApplyArgs(row), [
    "rebuild", "--thread", "memory-a", "--window", "3", "--tool-pairs", "30",
    "--summary-limit", "0", "--min-importance", "0", "--trigger", "mcp", "--binding", "binding-2", "--apply",
  ]);
  enqueueRebuild({ threadId: "memory-a", window: 3, toolPairs: 30 }, file);
  const [replaced] = readQueue(file);
  assert.equal(replaced.bindingId, null);
  assert.ok(!buildQueuedApplyArgs(replaced).includes("--binding"));
});

test("only one consumer can claim a pending rebuild batch", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-claim-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  enqueueRebuild({ threadId: "thread-a", window: 3 }, file);

  const marker = path.basename(process.argv[1]);
  const first = claimQueuedRebuilds(file, { marker });
  const second = claimQueuedRebuilds(file, { marker });
  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.processing`), true);
  assert.deepEqual(first.rows.map(row => row.threadId), ["thread-a"]);

  removeQueuedRebuild("thread-a", first.processingFile, first.rows[0]);
  finishQueuedRebuildClaim(first, file);
  assert.deepEqual(readQueue(file), []);
});

test("requests queued during processing survive and replace older failed requests", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-processing-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  enqueueRebuild({ threadId: "thread-a", window: 3 }, file);
  enqueueRebuild({ threadId: "thread-b", window: 4 }, file);

  const claim = claimQueuedRebuilds(file, { marker: path.basename(process.argv[1]) });
  removeQueuedRebuild("thread-b", claim.processingFile, claim.rows.find(row => row.threadId === "thread-b"));
  enqueueRebuild({ threadId: "thread-a", window: 9 }, file);
  enqueueRebuild({ threadId: "thread-c", window: 5 }, file);
  finishQueuedRebuildClaim(claim, file);

  assert.deepEqual(readQueue(file).map(row => [row.threadId, row.context.windowDays]), [
    ["thread-a", 9],
    ["thread-c", 5],
  ]);
  assert.equal(fs.existsSync(`${file}.processing`), false);
});
