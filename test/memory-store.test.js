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

test("remine candidates replace current automatic results transactionally", t => {
  const { store } = tempStore(t);
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO feelings
    (id,thread_id,source_date,event_time,order_key,content,importance,source,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("old", "thread-test", "2026-06-12", null, "1", "old", 3, "auto", now, now);
  const job = store.createJob({ sourceDate: "2026-06-12", mode: "remine", publishStrategy: "replace" });
  store.addCandidates(job.id, { feelings: [{ content: "new", eventTime: "2026-06-12T15:00:00+08:00", importance: 4 }] });
  const result = store.publishCandidates(job.id);
  assert.deepEqual(result.feelings.map(f => f.content), ["new"]);
  assert.equal(result.job.status, "completed");
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM memory_revisions").get().n, 1);
});

test("discarding candidates leaves current memories untouched", t => {
  const { store } = tempStore(t);
  const job = store.createJob({ sourceDate: "2026-06-12", mode: "targeted", publishStrategy: "append" });
  store.addCandidates(job.id, { feelings: [{ content: "candidate", importance: 3 }] });
  assert.equal(store.discardCandidates(job.id).status, "discarded");
  assert.equal(store.listFeelings().length, 0);
});
