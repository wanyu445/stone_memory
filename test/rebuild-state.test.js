const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { createRebuildStateStore } = require("../src/services/rebuild-log");

test("all rebuild-state mutations preserve fields written by other subsystems", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRebuildStateStore({
    resolveStateFile: threadId => path.join(root, threadId, "rebuild-state.json"),
  });

  store.update("thread-1", state => ({ ...state, automaticRebuild: { rebuildPending: true } }));
  store.updateContextUsage("thread-1", {
    usedTokens: 80,
    detectedMaxTokens: 100,
    observedAt: "2026-07-26T01:00:00.000Z",
  });
  store.appendRebuildLog("thread-1", { status: "completed", runtime: "codex" });

  const state = store.read("thread-1");
  assert.equal(state.automaticRebuild.rebuildPending, true);
  assert.equal(state.contextUsage.usedTokens, 80);
  assert.equal(state.lastCompleted.status, "completed");
});

test("watcher usage updates preserve a context maximum detected by an adapter", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-max-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRebuildStateStore({
    resolveStateFile: threadId => path.join(root, threadId, "rebuild-state.json"),
  });

  store.updateDetectedContextWindow("thread-1", {
    detectedMaxTokens: 200_000,
    detectedSource: "claude_status_line",
    detectedAt: "2026-07-26T01:00:00.000Z",
  });
  store.updateContextUsage("thread-1", {
    usedTokens: 120_000,
    observedAt: "2026-07-26T01:01:00.000Z",
  });

  const usage = store.read("thread-1").contextUsage;
  assert.equal(usage.usedTokens, 120_000);
  assert.equal(usage.detectedMaxTokens, 200_000);
  assert.equal(usage.detectedSource, "claude_status_line");
});

test("state store isolates stale usage observations after a successful rebuild", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRebuildStateStore({
    resolveStateFile: threadId => path.join(root, threadId, "rebuild-state.json"),
  });

  store.update("thread-1", state => ({
    ...state,
    automaticRebuild: { ignoreUsageBefore: "2026-07-26T02:00:00.000Z" },
    contextUsage: { detectedMaxTokens: 200_000 },
  }));
  store.updateContextUsage("thread-1", {
    usedTokens: 190_000,
    observedAt: "2026-07-26T01:59:00.000Z",
  });
  store.updateContextUsage("thread-1", {
    usedTokens: 195_000,
    observedAt: null,
  });

  assert.deepEqual(store.read("thread-1").contextUsage, {
    detectedMaxTokens: 200_000,
  });
});

test("separate processes cannot overwrite each other's rebuild-state fields", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-processes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rebuild-state.json");
  const modulePath = path.resolve(__dirname, "../src/services/rebuild-log.js");
  const source = `
    const { createRebuildStateStore } = require(${JSON.stringify(modulePath)});
    const store = createRebuildStateStore({ resolveStateFile: () => process.env.STMEM_TEST_STATE_FILE });
    for (let index = 0; index < 25; index += 1) {
      if (process.env.STMEM_TEST_ROLE === "usage") {
        store.updateContextUsage("thread-1", { usedTokens: index, observedAt: new Date(Date.now() + index).toISOString() });
      } else {
        store.update("thread-1", state => ({ ...state, automaticRebuild: { rebuildPending: true, highWaterTokens: index } }));
      }
    }
  `;
  const run = role => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source], {
      env: {
        ...process.env,
        STMEM_TEST_ROLE: role,
        STMEM_TEST_STATE_FILE: file,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `worker exited ${code}`));
    });
  });

  await Promise.all([run("usage"), run("automatic")]);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(state.contextUsage.usedTokens, 24);
  assert.equal(state.automaticRebuild.rebuildPending, true);
  assert.equal(state.automaticRebuild.highWaterTokens, 24);
});
