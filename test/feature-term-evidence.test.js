const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { dateFilePath } = require("../src/lib/archive-paths");
const { scanTermEvidence, aggregateFeelingEvidence } = require("../src/services/feature-term-evidence");

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

test("aggregates term archive evidence back onto matched feelings", () => {
  const feelings = [
    { id: "f2", source_date: "2026-07-02", content: "她和石头聊记忆连续性。", importance: 5, summary_mode: "daily" },
    { id: "f1", source_date: "2026-07-01", content: "她点了寿司。", importance: 3, summary_mode: "coarse" },
    { id: "unmatched", source_date: "2026-07-03", content: "普通一天。", importance: 2 },
  ];
  const rows = aggregateFeelingEvidence({
    feelings,
    termEvidence: [
      { term: "石头", normalizedTerm: "石头", category: "relation", featureIds: ["r1"], importance: 5,
        messageCount: 18, activeDays: 9, firstSeen: "2026-05-01", lastSeen: "2026-07-02", feelingIds: ["f2"] },
      { term: "石頭", normalizedTerm: "石头", category: "preference", featureIds: ["p1"], importance: 3,
        messageCount: 18, activeDays: 9, firstSeen: "2026-05-01", lastSeen: "2026-07-02", feelingIds: ["f2"] },
      { term: "寿司", normalizedTerm: "寿司", category: "eat", featureIds: ["e1"], importance: 3,
        messageCount: 5, activeDays: 5, firstSeen: "2026-06-01", lastSeen: "2026-07-01", feelingIds: ["f1"] },
    ],
  });
  assert.deepEqual(rows.map(row => row.feelingId), ["f1", "f2"]);
  assert.equal(rows[0].summaryMode, "coarse");
  assert.deepEqual(rows[1].matchedTerms[0], {
    term: "石头", normalizedTerm: "石头", categories: ["relation", "preference"],
    featureIds: ["r1", "p1"], featureImportance: 5,
    messageCount: 18, activeDays: 9, firstSeen: "2026-05-01", lastSeen: "2026-07-02",
  });
});
