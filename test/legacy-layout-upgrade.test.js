const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const stmem = path.join(root, "bin", "stmem");

function run(home, args) {
  const env = { ...process.env, HOME: home };
  if (process.platform === "win32") env.USERPROFILE = home;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [stmem, ...args], { cwd: root, env, encoding: "utf8" });
}

test("formal CLI previews and upgrades a legacy layout without replacing its data", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-layout-upgrade-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stone = path.join(home, ".stone_memory");
  const legacyId = "old-window";
  const sessionRoot = path.join(home, "sessions");
  const legacyRoot = path.join(stone, "runtimes", "codex", "coding", legacyId);
  fs.mkdirSync(path.join(legacyRoot, "memory", "archive"), { recursive: true });
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, "memory", "archive", "old.jsonl"), "legacy-data\n");
  fs.writeFileSync(path.join(sessionRoot, `${legacyId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: legacyId } })}\n`);
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
    [legacyId]: { label: "旧名字", ai: "旧 AI", user: "旧用户", runtime: "codex", purpose: "coding", sessionDir: sessionRoot,
      watcherEnabled: false, automaticFullMining: false, automaticMemoryMaintenance: false },
  }));
  const batch = path.join(home, "upgrade.json");
  fs.writeFileSync(batch, JSON.stringify({ label: "新名字", ai: "阿石", user: "小万", scenario: "coding", purpose: "coding" }));

  const preview = run(home, ["memory", "migrate-layout", "--memory", legacyId, "--batch-file", batch]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).dryRun, true);
  assert.equal(fs.existsSync(path.join(stone, "memories", legacyId)), false);

  const applied = run(home, ["memory", "migrate-layout", "--memory", legacyId, "--batch-file", batch, "--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  const canonical = path.join(stone, "memories", legacyId);
  assert.equal(fs.readFileSync(path.join(canonical, "memory", "archive", "old.jsonl"), "utf8"), "legacy-data\n");
  assert.equal(fs.readFileSync(path.join(legacyRoot, "memory", "archive", "old.jsonl"), "utf8"), "legacy-data\n");
  const memory = JSON.parse(fs.readFileSync(path.join(canonical, "memory.json"), "utf8"));
  assert.equal(memory.memoryId, legacyId);
  assert.equal(memory.label, "新名字");
  assert.equal(memory.ai, "阿石");
  assert.equal(memory.user, "小万");
  assert.equal(JSON.parse(fs.readFileSync(path.join(canonical, "watcher.json"), "utf8")).enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stone, "stmem.json"), "utf8")).memories[legacyId].memoryId, legacyId);

  const binding = run(home, ["binding", "migrate-legacy", "--memory", legacyId, "--apply"]);
  assert.equal(binding.status, 0, binding.stderr);
  const bindings = JSON.parse(fs.readFileSync(path.join(canonical, "bindings.json"), "utf8"));
  assert.equal(bindings.bindings[0].externalThreadId, legacyId);
  assert.equal(bindings.bindings[0].provider, "codex");
});

test("stmem init refuses to create any new legacy layout", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-no-legacy-init-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "old-entry.jsonl"), "{}\n");
  const batch = path.join(home, "init.json");
  fs.writeFileSync(batch, JSON.stringify({ libraryName: "不应创建", threadId: "old-entry", ai: "A", user: "U",
    runtime: "codex", scenario: "coding", sessionDir: sessions, minerMode: "subagent" }));
  for (const extra of [["--validate"], []]) {
    const result = run(home, ["init", "--batch-file", batch, ...extra]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /旧布局创建入口已关闭/);
  }
  assert.equal(fs.existsSync(path.join(home, ".stone_memory", "runtimes")), false);
  assert.equal(fs.existsSync(path.join(home, ".stone_memory", "stmem.json")), false);
});

test("legacy libraries are marked for an explicit Web upgrade", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-layout-web-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stone = path.join(home, ".stone_memory");
  const id = "legacy-web";
  fs.mkdirSync(path.join(stone, "runtimes", "claude", "accompany", id, "memory"), { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({ [id]: { label: "旧记忆", ai: "A", user: "U", runtime: "claude", purpose: "accompany" } }));
  const result = run(home, ["status"]);
  assert.equal(result.status, 0, result.stderr);
  const env = { ...process.env, HOME: home };
  if (process.platform === "win32") env.USERPROFILE = home;
  delete env.NODE_TEST_CONTEXT;
  const listed = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(require('./src/web/server').listLibraries()))"], { cwd: root, env, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const library = JSON.parse(listed.stdout)[0];
  assert.equal(library.layout, "legacy-runtime-v0");
  assert.equal(library.upgradeRequired, true);
});

test("local Web upgrades a legacy card and leaves an unverifiable window unbound", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-layout-web-apply-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stone = path.join(home, ".stone_memory");
  const id = "legacy-web-apply";
  fs.mkdirSync(path.join(stone, "runtimes", "claude", "accompany", id, "memory"), { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
    [id]: { label: "旧记忆", ai: "A", user: "U", runtime: "claude", purpose: "accompany", watcherEnabled: true },
  }));
  const script = `
    const http = require("node:http");
    const { startWebServer } = require(${JSON.stringify(path.join(root, "src", "web", "server.js"))});
    (async () => {
      const server = await startWebServer({ host: "127.0.0.1", port: 0 });
      const payload = JSON.stringify({ libraryName: "升级后", ai: "新 AI", user: "新用户", scenario: "coding" });
      const result = await new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST",
          path: "/api/memories/${id}/layout-upgrade", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, res => {
          const chunks = []; res.on("data", chunk => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject); req.end(payload);
      });
      await new Promise(resolve => server.close(resolve));
      console.log(JSON.stringify(result));
    })().catch(error => { console.error(error.stack); process.exit(1); });
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const response = JSON.parse(child.stdout);
  assert.equal(response.status, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.library.upgradeRequired, false);
  assert.equal(body.library.libraryName, "升级后");
  assert.equal(body.bindingRequired, true);
  assert.equal(body.library.watcherEnabled, false);
});
