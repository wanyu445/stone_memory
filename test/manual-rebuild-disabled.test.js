const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("manual CLI rebuild check remains available when automatic rebuild is disabled", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-manual-rebuild-"));
  const configDir = path.join(home, ".stone_memory");
  const sessionDir = path.join(home, "sessions");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "stmem.json"), JSON.stringify({
    "thread-1": {
      runtime: "codex",
      purpose: "accompany",
      sessionDir,
      automaticRebuild: { enabled: false },
    },
  }));
  fs.writeFileSync(path.join(sessionDir, "thread-1.jsonl"), `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: "thread-1",
      session_id: "thread-1",
      base_instructions: "test",
    },
  })}\n`);

  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, "../scripts/stmem-rebuild.js"),
    "rebuild",
    "--thread",
    "thread-1",
    "--check",
  ], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).healthy, true);
});

test("manual Web rebuild routes call the ordinary rebuild command without the automatic gate", () => {
  const server = fs.readFileSync(
    path.resolve(__dirname, "../src/web/server.js"),
    "utf8",
  );
  const route = server.slice(
    server.indexOf("const rebuildMatch"),
    server.indexOf('if (req.method === "POST" && url.pathname === "/api/imports/preview")'),
  );

  assert.match(route, /runStmem\(\["rebuild", "--thread", threadId, "--check"\]\)/);
  assert.match(route, /"--trigger", "web", "--apply"/);
  assert.doesNotMatch(route, /automaticRebuild|isTurnBlocked|--gate/);
});
