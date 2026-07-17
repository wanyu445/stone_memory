const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryStore } = require("../src/storage/memory-store");

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-store-"));
  const store = new MemoryStore({ memoryDir: dir, threadId: "thread-test" });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}

test("shared SQLite waits for short writes from per-thread watcher workers", t => {
  const { store } = tempStore(t);
  assert.equal(store.db.pragma("busy_timeout", { simple: true }), 30000);
  assert.equal(store.db.pragma("journal_mode", { simple: true }).toLowerCase(), "wal");
});

test("legacy migration is idempotent and dynamic seq follows event time", t => {
  const { store, dir } = tempStore(t);
  const feelingsDir = path.join(dir, "mined", "feelings");
  fs.mkdirSync(feelingsDir, { recursive: true });
  fs.writeFileSync(path.join(feelingsDir, "days.jsonl"), [
    { id: "f-late", type: "feeling", sourceDate: "2026-06-12", eventTime: "2026-06-12T20:00:00+08:00", seq: 1, content: "6月12日，晚上。", importance: 3 },
    { id: "f-early", type: "feeling", sourceDate: "2026-06-12", eventTime: "2026-06-12T09:00:00+08:00", seq: 2, content: "6月12日，上午。", importance: 4 },
  ].map(JSON.stringify).join("\n") + "\n");
  assert.equal(store.migrateLegacy().feelingCount, 2);
  assert.equal(store.migrateLegacy().feelingCount, 0);
  const rows = store.listFeelings({ date: "2026-06-12" });
  assert.deepEqual(rows.map(r => [r.id, r.seq, r.daySeq]), [["f-early", 1, 1], ["f-late", 2, 2]]);
});

test("legacy normalized archive migrates once into SQLite messages", t => {
  const { store, dir } = tempStore(t);
  const archiveFile = path.join(dir, "archive", "2026", "06", "2026-06-12.jsonl");
  fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
  fs.writeFileSync(archiveFile, JSON.stringify({ timestamp: "2026-06-12T08:00:00.123Z", type: "user", text: "hello" }) + "\n");
  assert.equal(store.migrateLegacy().messageCount, 1);
  assert.equal(store.migrateLegacy().messageCount, 0);
  assert.deepEqual(store.listMessages({ date: "2026-06-12" }).map(row => [row.timestamp, row.text]), [["2026-06-12T08:00:00.123Z", "hello"]]);
});

test("remine directly replaces current results without version data", t => {
  const { store } = tempStore(t);
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO feelings
    (id,thread_id,source_date,event_time,order_key,content,importance,source,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("old", "thread-test", "2026-06-12", null, "1", "old", 3, "auto", now, now);
  const result = store.replaceDay("2026-06-12", { feelings: [{ content: "new", eventTime: "2026-06-12T15:00:00+08:00", importance: 4 }] });
  assert.deepEqual(result.feelings.map(f => f.content), ["new"]);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.equal(tables.includes("memory_candidates"), false);
  assert.equal(tables.includes("memory_revisions"), false);
  assert.equal(fs.existsSync(path.join(store.memoryDir, "mined", "feelings", "days.jsonl")), false);
});

test("targeted storage appends to the current day and preserves existing memories", t => {
  const { store } = tempStore(t);
  store.appendTargeted("2026-06-12", { feelings: [{ content: "first", eventTime: "2026-06-12T18:00:00+08:00", importance: 3 }] });
  const result = store.appendTargeted("2026-06-12", { feelings: [{ content: "earlier", eventTime: "2026-06-12T09:00:00+08:00", importance: 3 }] });
  assert.deepEqual(result.feelings.map(row => [row.content, row.daySeq]), [["earlier", 1], ["first", 2]]);
});
