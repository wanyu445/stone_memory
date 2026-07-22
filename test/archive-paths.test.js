const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDateFile, resolveDateFile, listDates, listJsonlRecursive, migrateFlatFiles } = require("../src/lib/archive-paths");
const { MemoryArchive, FullArchive } = require("../src/services/memory-archive");

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

test("MemoryArchive stores normalized messages in SQLite", t => {
  const memoryDir = tempDir(t);
  const archive = new MemoryArchive(memoryDir, { threadId: "thread-test" });
  const msg = { timestamp: "2026-05-12T10:00:00+08:00", type: "user", text: "hello" };
  archive.archiveMessage(msg);
  assert.deepEqual(archive.readDay("2026-05-12").map(row => row.text), ["hello"]);
  archive.close();
  assert.equal(fs.existsSync(path.join(memoryDir, "archive", "2026", "05", "2026-05-12.jsonl")), false);
});

test("FullArchive writes only recursive raw backup", t => {
  const memoryDir = tempDir(t);
  const archive = new FullArchive(memoryDir);
  archive.archiveFull({ timestamp: "2026-05-12T10:00:00+08:00", extra: [1, 2] });
  assert.equal(fs.existsSync(path.join(memoryDir, "archive", "full", "2026", "05", "2026-05-12.jsonl")), true);
});

test("FullArchive incrementally backs up rebuild input with Beijing date grouping", t => {
  const memoryDir = tempDir(t);
  const archive = new FullArchive(memoryDir);
  const first = { timestamp: "2026-05-12T15:59:00Z", value: "first" };
  const nextDay = { timestamp: "2026-05-12T16:01:00Z", value: "next-day" };
  assert.equal(archive.archiveNewFullBatch([first, nextDay]), 2);
  assert.equal(archive.archiveNewFullBatch([first, nextDay]), 0);
  const lateOlderRecord = { timestamp: "2026-05-12T01:00:00Z", value: "late-but-older" };
  assert.equal(archive.archiveNewFullBatch([lateOlderRecord]), 1);
  assert.equal(archive.archiveNewFullBatch([lateOlderRecord]), 0);
  assert.equal(fs.existsSync(path.join(memoryDir, "archive", "full", "2026", "05", "2026-05-12.jsonl")), true);
  assert.equal(fs.existsSync(path.join(memoryDir, "archive", "full", "2026", "05", "2026-05-13.jsonl")), true);
});

test("recursive import discovery includes nested jsonl files", t => {
  const root = tempDir(t);
  const nested = path.join(root, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "thread.jsonl"), "{}\n");
  assert.deepEqual(listJsonlRecursive(root), [path.join(nested, "thread.jsonl")]);
});
