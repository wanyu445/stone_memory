const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  withFileLock,
  withFileLockSync,
} = require("../src/lib/file-lock");
const { processIdentity } = require("../src/lib/process-identity");

test("async file lock holds ownership until the asynchronous operation settles", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-file-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, "thread.lock");
  const order = [];

  const first = withFileLock(lock, async () => {
    order.push("first:start");
    await new Promise(resolve => setTimeout(resolve, 30));
    order.push("first:end");
  });
  const second = withFileLock(lock, async () => {
    order.push("second:start");
  }, { timeoutMs: 500 });
  await Promise.all([first, second]);

  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});

test("lock ownership is atomically published as a complete owner record", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-atomic-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, "thread.lock");

  withFileLockSync(lock, () => {
    assert.equal(fs.statSync(lock).isFile(), true);
    const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.processIdentity, processIdentity(process.pid));
  });
});

test("a lock left by a dead process is recovered immediately", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dead-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, "thread.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    processIdentity: "dead",
  }));

  const result = withFileLockSync(lock, () => "acquired", {
    timeoutMs: 100,
    staleMs: 60_000,
  });

  assert.equal(result, "acquired");
});

test("a reused PID with a different process identity cannot pin a lock", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-reused-pid-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, "thread.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: process.pid,
    processIdentity: `${processIdentity(process.pid)}-previous-incarnation`,
  }));

  assert.equal(withFileLockSync(lock, () => "acquired", {
    timeoutMs: 100,
    staleMs: 60_000,
  }), "acquired");
});

test("a live matching owner is never reaped merely because its lock is old", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-live-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, "thread.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: process.pid,
    processIdentity: processIdentity(process.pid),
  }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);

  assert.throws(() => withFileLockSync(lock, () => "must not run", {
    timeoutMs: 20,
    staleMs: 1,
  }), /file lock timeout/);
});
