const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../src/storage/memory-store");
const { updateTermEvidenceCache } = require("../src/services/term-evidence-cache");

function fixture(t) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-term-cache-"));
  const store = new MemoryStore({ memoryDir, threadId: "thread" });
  t.after(() => { store.close(); fs.rmSync(memoryDir, { recursive: true, force: true }); });
  return store;
}

test("caches zero days, incrementally scans new dates, and backfills new terms", t => {
  const store = fixture(t);
  store.insertMessages([
    { timestamp: "2026-04-15T01:00:00Z", sourceDate: "2026-04-15", role: "user", text: "喝茶喝茶" },
    { timestamp: "2026-04-16T01:00:00Z", sourceDate: "2026-04-16", role: "assistant", text: "喝茶" },
  ]);

  const first = updateTermEvidenceCache({ store, terms: ["喝茶"] });
  assert.equal(first.rows, 2);
  assert.deepEqual(store.listTermDailyStats(["喝茶"]), [
    { normalizedTerm: "喝茶", sourceDate: "2026-04-15", messageCount: 1, occurrenceCount: 2 },
    { normalizedTerm: "喝茶", sourceDate: "2026-04-16", messageCount: 0, occurrenceCount: 0 },
  ]);
  assert.equal(updateTermEvidenceCache({ store, terms: ["喝茶"] }).rows, 0);

  store.insertMessages([{ timestamp: "2026-04-17T01:00:00Z", sourceDate: "2026-04-17", role: "user", text: "通宵喝茶" }]);
  assert.equal(updateTermEvidenceCache({ store, terms: ["喝茶"] }).rows, 1);
  const backfill = updateTermEvidenceCache({ store, terms: ["通宵"] });
  assert.equal(backfill.rows, 3);
  assert.equal(store.listTermDailyStats(["通宵"]).at(-1).occurrenceCount, 1);
});
