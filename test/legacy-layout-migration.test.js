const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.join(__dirname, "..", "scripts", "migrate-legacy-memory-layout.js");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-layout-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".stone_memory");
  const source = path.join(root, "runtimes", "codex", "accompany", "legacy-one");
  fs.mkdirSync(path.join(source, "memory"), { recursive: true });
  fs.writeFileSync(path.join(source, "memory", "sample.txt"), "synthetic memory only");
  fs.writeFileSync(path.join(root, "stmem.json"), JSON.stringify({
    "legacy-one": { label: "Fixture", runtime: "codex", purpose: "accompany", scenario: "life-supervision", ai: "Test AI", watcherEnabled: false },
  }));
  return { home, root, source };
}

function run(home, ...args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  return spawnSync(process.execPath, [script, "--memory", "legacy-one", ...args], { env, encoding: "utf8" });
}

test("dry run does not create a canonical memory or backup", t => {
  const { home, root } = fixture(t);
  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).files, 1);
  assert.equal(fs.existsSync(path.join(root, "memories")), false);
  assert.equal(fs.existsSync(path.join(root, "backups")), false);
});

test("apply copies and verifies, preserves source, and requires separate binding", t => {
  const { home, root, source } = fixture(t);
  const denied = run(home, "--apply");
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /services-stopped/);
  const result = run(home, "--apply", "--services-stopped");
  assert.equal(result.status, 0, result.stderr);
  const firstLine = JSON.parse(result.stdout);
  assert.equal(firstLine.applied, true);
  const destination = path.join(root, "memories", "legacy-one");
  assert.equal(fs.readFileSync(path.join(destination, "memory", "sample.txt"), "utf8"), "synthetic memory only");
  assert.equal(fs.readFileSync(path.join(source, "memory", "sample.txt"), "utf8"), "synthetic memory only");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, "bindings.json"), "utf8")).bindings, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, "watcher.json"), "utf8")).enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, "memory.json"), "utf8")).scenario, "life-supervision");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "stmem.json"), "utf8")).memories["legacy-one"].status, "active");
  assert.equal(fs.existsSync(path.join(firstLine.backup, "stmem.json")), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(firstLine.backup, "stmem.json"), "utf8")).memories, undefined);
  assert.equal(run(home, "--apply", "--services-stopped").status, 1);
});

test("a live watcher prevents application", t => {
  const { home, root, source } = fixture(t);
  const lock = path.join(source, ".watcher.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
  const result = run(home, "--apply", "--services-stopped");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Watcher PID/);
  assert.equal(fs.existsSync(path.join(root, "memories")), false);
});

test("alias mismatch and existing destination are rejected without changing data", t => {
  const { home, root } = fixture(t);
  const configFile = path.join(root, "stmem.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config["legacy-one"].memoryId = "another-id";
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.match(run(home, "--apply", "--services-stopped").stderr, /alias differs/);
  delete config["legacy-one"].memoryId;
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.mkdirSync(path.join(root, "memories", "legacy-one"), { recursive: true });
  assert.match(run(home, "--apply", "--services-stopped").stderr, /already exists/);
  assert.equal(fs.existsSync(path.join(root, "backups")), false);
});
