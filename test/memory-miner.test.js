const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryMiner } = require("../src/services/memory-miner");

function minerFixture(t, messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-miner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const miner = new MemoryMiner({
    memoryDir: dir, threadId: "test", archive: { readDay: () => messages }, deepseekConfig: {},
    personaConfig: { purpose: "accompany" },
  });
  miner.store.insertMessages(messages.map((row, i) => ({
    timestamp: row.timestamp || `2026-06-12T00:00:0${i}.000Z`, sourceDate: "2026-06-12",
    role: row.type || "user", text: row.text || `message ${i}`,
  })));
  return miner;
}

test("a short day is still mined and an empty model result completes successfully", async t => {
  const miner = minerFixture(t, [{}, {}]);
  let called = 0;
  miner._mineDayWithSubagent = async targetDate => {
    called++;
    miner._saveState({ [`feeling:${targetDate}`]: Date.now(), [`feature:${targetDate}`]: Date.now() });
  };
  const result = await miner.mine("2026-06-12");
  assert.equal(called, 1);
  assert.equal(result.status, "completed_empty");
  assert.equal(result.feelingCount, 0);
  assert.equal(result.featureCount, 0);
  const state = miner.store.getDayState("2026-06-12");
  assert.equal(state.status, "completed_empty");
  assert.equal(state.message_count, 2);
});

test("mining errors propagate to callers", async t => {
  const miner = minerFixture(t, Array.from({ length: 5 }, () => ({ text: "x" })));
  miner._mineDayWithSubagent = async () => { throw new Error("model unavailable"); };
  await assert.rejects(() => miner.mine("2026-06-12"), err => err.code === "MINING_FAILED" && /model unavailable/.test(err.message));
  const state = miner.store.getDayState("2026-06-12");
  assert.equal(state.status, "failed");
  assert.match(state.next_retry_at, /^\d{4}-/);
});

test("three consecutive failures block automatic retries and enqueue a notification", async t => {
  const miner = minerFixture(t, [{ text: "x" }]);
  miner._mineDayWithSubagent = async () => { throw new Error("model unavailable"); };
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(() => miner.mine("2026-06-12"));
  }
  const day = miner.store.getDayState("2026-06-12");
  assert.equal(day.status, "blocked");
  assert.equal(day.attempt, 3);
  assert.equal(day.next_retry_at, null);
  const notifications = miner.store.db.prepare("SELECT * FROM notifications WHERE thread_id=?").all("test");
  assert.deepEqual(notifications.map(item => [item.type, item.source_date, item.is_read]), [["mining_blocked", "2026-06-12", 0]]);
});

test("active date lock returns locked status", async t => {
  const miner = minerFixture(t, Array.from({ length: 5 }, () => ({ text: "x" })));
  fs.mkdirSync(path.join(miner.memoryDir, ".mining-lock-2026-06-12"));
  const result = await miner.mine("2026-06-12");
  assert.equal(result.status, "locked");
});

test("forced remine replaces a completed day directly", async t => {
  const miner = minerFixture(t, [{ text: "new conversation" }]);
  const date = "2026-06-12";
  miner.store.replaceDay(date, { feelings: [{ content: "old", importance: 3 }] });
  miner.store.setDayState(date, { status: "completed" });
  miner._mineDayWithSubagent = async targetDate => {
    await miner._saveEntries([{ content: "new", importance: 4 }], { targetDate, stateKey: `feeling:${targetDate}`, label: "feelings", isFeature: false });
    miner._saveState({ [`feature:${targetDate}`]: Date.now() });
  };
  const result = await miner.mine(date, { force: true });
  assert.equal(result.status, "completed");
  const rows = miner.store.listFeelings({ date });
  assert.deepEqual(rows.map(row => row.content), ["new"]);
});

test("failed forced remine restores the previous result and completion state", async t => {
  const miner = minerFixture(t, [{ text: "conversation" }]);
  const date = "2026-06-12";
  miner.store.replaceDay(date, { feelings: [{ content: "old", importance: 3 }] });
  miner.store.setDayState(date, { status: "completed", feelingCount: 1 });
  miner._mineDayWithSubagent = async () => { throw new Error("remine failed"); };
  await assert.rejects(() => miner.mine(date, { force: true }), /remine failed/);
  assert.deepEqual(miner.store.listFeelings({ date }).map(row => row.content), ["old"]);
  assert.equal(miner.store.getDayState(date).status, "completed");
});
