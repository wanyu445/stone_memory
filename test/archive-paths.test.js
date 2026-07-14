const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDateFile, resolveDateFile, listDates, listJsonlRecursive, migrateFlatFiles } = require("../src/lib/archive-paths");
const { MemoryArchive } = require("../src/services/memory-archive");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-archive-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("archive paths are routed into year/month directories", t => {
  const root = tempDir(t);
  const file = ensureDateFile(root, "2026-05-12");
  assert.equal(file, path.join(root, "2026", "05", "2026-05-12.jsonl"));
  fs.writeFileSync(file, "{}\n");
  assert.equal(resolveDateFile(root, "2026-05-12"), file);
  assert.deepEqual(listDates(root), ["2026-05-12"]);
});

test("legacy flat files migrate without changing their content", t => {
  const root = tempDir(t);
  const legacy = path.join(root, "2026-05-12.jsonl");
  fs.writeFileSync(legacy, "legacy\n");
  assert.equal(migrateFlatFiles(root), 1);
  const nested = path.join(root, "2026", "05", "2026-05-12.jsonl");
  assert.equal(fs.readFileSync(nested, "utf8"), "legacy\n");
  assert.equal(fs.existsSync(legacy), false);
});

test("MemoryArchive writes and reads archive and full recursively", t => {
  const memoryDir = tempDir(t);
  const archive = new MemoryArchive(memoryDir);
  const msg = { timestamp: "2026-05-12T10:00:00+08:00", type: "user", text: "hello" };
  archive.archiveMessage(msg);
  archive.archiveFull(msg);
  assert.deepEqual(archive.readDay("2026-05-12"), [msg]);
  assert.equal(fs.existsSync(path.join(memoryDir, "archive", "2026", "05", "2026-05-12.jsonl")), true);
  assert.equal(fs.existsSync(path.join(memoryDir, "archive", "full", "2026", "05", "2026-05-12.jsonl")), true);
});

test("recursive import discovery includes nested jsonl files", t => {
  const root = tempDir(t);
  const nested = path.join(root, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "thread.jsonl"), "{}\n");
  assert.deepEqual(listJsonlRecursive(root), [path.join(nested, "thread.jsonl")]);
});
