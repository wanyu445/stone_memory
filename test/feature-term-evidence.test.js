const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { dateFilePath } = require("../src/lib/archive-paths");
const { scanTermEvidence } = require("../src/services/feature-term-evidence");

test("uses user rows in recursive archive and links matching feelings", () => {
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-evidence-"));
  const first = dateFilePath(archiveDir, "2026-07-01");
  const second = dateFilePath(archiveDir, "2026-07-03");
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.writeFileSync(first, [
    JSON.stringify({ type: "user", text: "今天想吃炸鸡" }),
    JSON.stringify({ type: "assistant", text: "炸鸡炸鸡" }),
  ].join("\n"));
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(second, JSON.stringify({ type: "user", text: "又点了炸雞" }));
  const [row] = scanTermEvidence({
    terms: [{ term: "炸鸡", category: "eat", featureIds: ["x"], importance: 3, sourceDates: [] }],
    feelings: [{ id: "f1", content: "她点了炸雞。", importance: 2 }],
    archiveDir,
  });
  assert.equal(row.messageCount, 2);
  assert.equal(row.activeDays, 2);
  assert.equal(row.feelingCount, 1);
  assert.deepEqual(row.feelingImportances, [2]);
});
