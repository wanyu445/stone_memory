const crypto = require("crypto");

function sourceFingerprint(filePath) {
  const fs = require("fs");
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function newBatchId() {
  return `imp_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function recordConversationImport(store, { id, sourceName, sourcePath, fingerprint, format, metadata = {}, discovered = 0, invalid = 0, result, appliedAt = new Date().toISOString() }) {
  if (!id || !sourceName || !fingerprint || !format || !result) throw new Error("导入批次元数据不完整");
  store.db.prepare(`INSERT INTO conversation_import_batches
    (id,thread_id,status,source_name,source_path,source_fingerprint,format,metadata_json,discovered_count,inserted_count,duplicate_count,invalid_count,filtered_count,source_dates_json,filtered_reasons_json,applied_at)
    VALUES (?,?,'applied',?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, store.threadId, sourceName, sourcePath || null, fingerprint, format, JSON.stringify(metadata), discovered,
    result.imported || 0, result.duplicates || 0, invalid, result.filtered || 0,
    JSON.stringify(result.sourceDates || []), JSON.stringify(result.filteredReasons || {}), appliedAt,
  );
  return { id, status: "applied", sourceName, sourcePath: sourcePath || null, sourceFingerprint: fingerprint,
    format, discovered, inserted: result.imported || 0, duplicates: result.duplicates || 0,
    invalid, filtered: result.filtered || 0, sourceDates: result.sourceDates || [],
    filteredReasons: result.filteredReasons || {}, appliedAt };
}

function listConversationImports(store) {
  return store.db.prepare(`SELECT id,status,source_name sourceName,source_path sourcePath,source_fingerprint sourceFingerprint,format,
    discovered_count discovered,inserted_count inserted,duplicate_count duplicates,invalid_count invalid,
    filtered_count filtered,source_dates_json sourceDatesJson,filtered_reasons_json filteredReasonsJson,
    applied_at appliedAt,reverted_at revertedAt,metadata_json metadataJson
    FROM conversation_import_batches WHERE thread_id=? ORDER BY applied_at DESC`).all(store.threadId).map(row => {
    let sourceDates = [], filteredReasons = {}, metadata = {};
    try { sourceDates = JSON.parse(row.sourceDatesJson || "[]"); } catch {}
    try { filteredReasons = JSON.parse(row.filteredReasonsJson || "{}"); } catch {}
    try { metadata = JSON.parse(row.metadataJson || "{}"); } catch {}
    return { ...row, sourceDates, filteredReasons, metadata, sourceDatesJson: undefined, filteredReasonsJson: undefined, metadataJson: undefined };
  });
}

function previewConversationImportRevert(store, batchId) {
  const batch = store.db.prepare("SELECT * FROM conversation_import_batches WHERE id=? AND thread_id=?")
    .get(batchId, store.threadId);
  if (!batch) throw new Error(`导入批次不存在：${batchId}`);
  let dates = [];
  try { dates = JSON.parse(batch.source_dates_json || "[]"); } catch {}
  const messageCount = store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND import_batch_id=?")
    .get(store.threadId, batchId).count;
  const placeholders = dates.map(() => "?").join(",");
  const mined = dates.length ? store.db.prepare(`SELECT source_date sourceDate,status,completed_at completedAt
    FROM mining_day_state WHERE thread_id=? AND source_date IN (${placeholders})
      AND status IN ('completed','completed_empty') AND completed_at>=? ORDER BY source_date`)
    .all(store.threadId, ...dates, batch.applied_at) : [];
  const jobs = dates.length ? store.db.prepare(`SELECT source_date sourceDate,status FROM mining_jobs
    WHERE thread_id=? AND source_date IN (${placeholders})
      AND (status IN ('queued','running','review_pending') OR (status='completed' AND finished_at>=?)) ORDER BY source_date`)
    .all(store.threadId, ...dates, batch.applied_at) : [];
  const generated = dates.length ? store.db.prepare(`SELECT source_date sourceDate,COUNT(*) count FROM feelings
    WHERE thread_id=? AND source_date IN (${placeholders}) AND created_at>=? GROUP BY source_date`)
    .all(store.threadId, ...dates, batch.applied_at) : [];
  const features = dates.length ? store.db.prepare(`SELECT source_date sourceDate FROM features
    WHERE thread_id=? AND source_date IN (${placeholders}) AND created_at>=? GROUP BY source_date`)
    .all(store.threadId, ...dates, batch.applied_at) : [];
  const protectedDates = [...new Set([...mined, ...jobs, ...generated, ...features].map(row => row.sourceDate))].sort();
  return {
    batchId, status: batch.status, sourceName: batch.source_name, inserted: batch.inserted_count,
    remainingMessages: messageCount, sourceDates: dates, protectedDates,
    reversible: batch.status === "applied" && protectedDates.length === 0,
    note: "撤回只移除该批次新写入的规范对话；archive/full 原始备份会保留。",
  };
}

function revertConversationImport(store, batchId) {
  const preview = previewConversationImportRevert(store, batchId);
  if (preview.status === "reverted") return { changed: false, ...preview };
  if (preview.protectedDates.length) {
    throw new Error(`这些日期在导入后已挖掘或正在挖掘，不能安全撤回：${preview.protectedDates.join("、")}`);
  }
  const revertedAt = new Date().toISOString();
  const removed = store.db.transaction(() => {
    const result = store.db.prepare("DELETE FROM messages WHERE thread_id=? AND import_batch_id=?")
      .run(store.threadId, batchId);
    store.db.prepare("UPDATE conversation_import_batches SET status='reverted',reverted_at=? WHERE id=? AND thread_id=?")
      .run(revertedAt, batchId, store.threadId);
    return result.changes;
  })();
  return { changed: removed > 0, batchId, removed, revertedAt, note: preview.note };
}

module.exports = { sourceFingerprint, newBatchId, recordConversationImport, listConversationImports, previewConversationImportRevert, revertConversationImport };
