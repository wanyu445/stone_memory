const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryMiner } = require("../src/services/memory-miner");

function minerFixture(t, messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-miner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MemoryMiner({
    memoryDir: dir, threadId: "test", archive: { readDay: () => messages }, deepseekConfig: {},
    personaConfig: { purpose: "accompany" },
  });
}

test("insufficient messages are explicitly skipped", async t => {
  const miner = minerFixture(t, [{}, {}]);
  const result = await miner.mine("2026-06-12");
  assert.equal(result.status, "skipped");
  assert.equal(result.skippedReason, "insufficient_messages");
});

test("mining errors propagate to callers", async t => {
  const miner = minerFixture(t, Array.from({ length: 5 }, () => ({ text: "x" })));
  miner._mineDayWithSubagent = async () => { throw new Error("model unavailable"); };
  await assert.rejects(() => miner.mine("2026-06-12"), err => err.code === "MINING_FAILED" && /model unavailable/.test(err.message));
});

test("active date lock returns locked status", async t => {
  const miner = minerFixture(t, Array.from({ length: 5 }, () => ({ text: "x" })));
  fs.mkdirSync(path.join(miner.memoryDir, ".mining-lock-2026-06-12"));
  const result = await miner.mine("2026-06-12");
  assert.equal(result.status, "locked");
});
