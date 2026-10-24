const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../src/storage/memory-store");
const { readImportSource } = require("../src/services/import-source");
const { ingestRecords } = require("../src/services/thread-ingest");
const { newBatchId, sourceFingerprint, recordConversationImport, listConversationImports, previewConversationImportRevert, revertConversationImport } = require("../src/services/conversation-imports");

test("conversation import batches track rows and permit safe scoped reimport and revert", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-import-batches-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const source = path.join(root, "conversation.json"), retained = path.join(root, "done-conversation.json");
  const store = new MemoryStore({ memoryDir: root, threadId: "import-batch-fixture" });
  t.after(() => store.close());
  fs.writeFileSync(source, JSON.stringify([
    { timestamp: "2026-05-12T10:00:00.000Z", role: "user", content: "imported fixture" },
  ]));
  fs.copyFileSync(source, retained);
  const imported = readImportSource({ filePath: source }), batchId = newBatchId(), appliedAt = new Date().toISOString();
  let first;
  store.db.transaction(() => {
    first = ingestRecords(imported.records, { memoryStore: store, format: imported.preview.format, messageOptions: { importBatchId: batchId } });
    recordConversationImport(store, { id: batchId, sourceName: "conversation.json", sourcePath: retained,
      fingerprint: sourceFingerprint(retained), format: imported.preview.format, discovered: imported.preview.valid,
      invalid: imported.preview.invalid, result: first, appliedAt });
  })();
  assert.equal(first.imported, 1);
  assert.equal(listConversationImports(store)[0].sourcePath, retained);

  const again = ingestRecords(imported.records, { memoryStore: store, format: imported.preview.format, messageOptions: { importBatchId: newBatchId() } });
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 1);

  const preview = previewConversationImportRevert(store, batchId);
  assert.equal(preview.reversible, true);
  assert.equal(preview.remainingMessages, 1);
  const reverted = revertConversationImport(store, batchId);
  assert.equal(reverted.removed, 1);
  assert.equal(listConversationImports(store)[0].status, "reverted");
});

test("conversation import revert is blocked after its source date has been mined", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-import-protected-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const store = new MemoryStore({ memoryDir: root, threadId: "protected-import-fixture" });
  t.after(() => store.close());
  const batchId = newBatchId(), appliedAt = "2026-05-12T11:00:00.000Z";
  recordConversationImport(store, { id: batchId, sourceName: "fixture.json", fingerprint: "fingerprint", format: "json",
    discovered: 1, result: { imported: 0, duplicates: 1, filtered: 0, sourceDates: ["2026-05-12"] }, appliedAt });
  store.db.prepare(`INSERT INTO mining_day_state(thread_id,source_date,status,completed_at,updated_at)
    VALUES (?,?,'completed',?,?)`).run(store.threadId, "2026-05-12", "2026-05-12T12:00:00.000Z", "2026-05-12T12:00:00.000Z");
  const preview = previewConversationImportRevert(store, batchId);
  assert.equal(preview.reversible, false);
  assert.deepEqual(preview.protectedDates, ["2026-05-12"]);
  assert.throws(() => revertConversationImport(store, batchId), /不能安全撤回/);
});
