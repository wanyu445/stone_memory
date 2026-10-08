const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { previewIngestRecords, ingestRecords, beijingDateKey } = require('./thread-ingest');
const IMPORT_SOURCES = new Set(['json', 'jsonl', 'sqlite', 'chatgpt', 'claude_ai']);
function normalizedText(text) {
  const value = String(text || '').replace(/\r\n/g, '\n').trim();
  const wrapped = value.match(/^```[ \t]*(?:text|markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i);
  return (wrapped ? wrapped[1] : value).trim();
}
function textKey(role, text) { return `${role}\0${normalizedText(text)}`; }
function exactKey(role, text, timestamp) { return `${role}\0${String(text).trim()}\0${Date.parse(timestamp)}`; }
function planMatchingReplacement(store, batches, { originalBatch = null } = {}) {
  if (!Array.isArray(batches) || !batches.length) throw new Error('请上传至少一个文件');
  const records = batches.flatMap(batch => batch.records);
  const batchIndices = batches.flatMap((batch, index) => batch.records.map(() => index));
  const validation = previewIngestRecords(records);
  if (validation.invalid || validation.filtered || validation.candidates !== records.length || !records.length) {
    throw new Error('同文覆盖只接受完整有效的纯对话；请先处理无效或被过滤的记录');
  }
  if (records.some(record => !['user', 'assistant'].includes(record.message.type))) throw new Error('同文覆盖只接受用户和助手对话');
  const rows = store.db.prepare('SELECT * FROM messages WHERE thread_id=? ORDER BY timestamp,message_seq').all(store.threadId);
  const eligible = rows.filter(row => IMPORT_SOURCES.has(row.source) && !row.binding_id && !row.import_batch_id);
  const targetKeys = new Set(records.map(({ message: m }) => exactKey(m.type, m.text, m.timestamp)));
  const existingByKey = new Map(rows.map(row => [exactKey(row.role, row.text, row.timestamp), row]));
  const positions = new Map(eligible.map((row, index) => [row.message_seq, index]));
  const byText = new Map();
  for (const row of eligible) {
    if (targetKeys.has(exactKey(row.role, row.text, row.timestamp))) continue;
    const key = textKey(row.role, row.text);
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(row);
  }
  const incomingCounts = new Map();
  for (const record of records) {
    const key = textKey(record.message.type, record.message.text);
    incomingCounts.set(key, (incomingCounts.get(key) || 0) + 1);
  }
  const selections = new Map();
  // A unique long message can identify itself. Short/repeated replies need adjacent dialogue evidence.
  records.forEach((record, index) => {
    const m = record.message, key = textKey(m.type, m.text), candidates = byText.get(key) || [];
    if (candidates.length === 1 && incomingCounts.get(key) === 1 && normalizedText(m.text).length >= 24) selections.set(index, candidates[0]);
  });
  for (let pass = 0; pass < records.length; pass++) {
    let changed = false;
    records.forEach((record, index) => {
      if (selections.has(index)) return;
      const m = record.message;
      const candidates = (byText.get(textKey(m.type, m.text)) || []).filter(row => {
        const before = batchIndices[index - 1] === batchIndices[index] ? selections.get(index - 1) : null;
        const after = batchIndices[index + 1] === batchIndices[index] ? selections.get(index + 1) : null, pos = positions.get(row.message_seq);
        return (before && positions.get(before.message_seq) + 1 === pos) || (after && pos + 1 === positions.get(after.message_seq));
      });
      const used = new Set([...selections.values()].map(row => row.message_seq));
      const available = candidates.filter(row => !used.has(row.message_seq));
      if (available.length === 1) { selections.set(index, available[0]); changed = true; }
    });
    if (!changed) break;
  }
  // A transcript edit may insert a message between two unchanged anchors. Use both sides,
  // within this file, to disambiguate the short reply; never extrapolate from one distant side.
  records.forEach((record, index) => {
    if (selections.has(index)) return;
    let before = null, after = null;
    for (let i = index - 1; i >= 0 && batchIndices[i] === batchIndices[index]; i--) if (selections.has(i)) { before = selections.get(i); break; }
    for (let i = index + 1; i < records.length && batchIndices[i] === batchIndices[index]; i++) if (selections.has(i)) { after = selections.get(i); break; }
    if (!before || !after) return;
    const left = positions.get(before.message_seq), right = positions.get(after.message_seq);
    if (left >= right) return;
    const used = new Set([...selections.values()].map(row => row.message_seq));
    const m = record.message;
    const available = (byText.get(textKey(m.type, m.text)) || []).filter(row => !used.has(row.message_seq) && positions.get(row.message_seq) > left && positions.get(row.message_seq) < right);
    if (available.length === 1) selections.set(index, available[0]);
  });
  const selectedRows = [...new Map([...selections.values()].map(row => [row.message_seq, row])).values()];
  if (originalBatch) {
    const oldValidation = previewIngestRecords(originalBatch.records);
    if (!originalBatch.records.length || oldValidation.invalid || oldValidation.filtered || oldValidation.candidates !== originalBatch.records.length || !IMPORT_SOURCES.has(originalBatch.format) || originalBatch.records.some(record => !['user', 'assistant'].includes(record.message.type))) {
      throw new Error('指定的旧导入文件必须全部是有效纯对话');
    }
    const originalKeys = new Set(originalBatch.records.map(({ message: m }) => exactKey(m.type, m.text, m.timestamp)));
    const originalRows = rows.filter(row => row.source === originalBatch.format && originalKeys.has(exactKey(row.role, row.text, row.timestamp)));
    if (originalRows.some(row => row.binding_id || row.import_batch_id)) throw new Error('旧文件涉及 Binding 记录，不能按原文件覆盖');
    if (!originalRows.length) throw new Error('指定旧文件已无现存记录，无需再次整批覆盖');
    selectedRows.splice(0, selectedRows.length, ...originalRows);
    selections.clear();
    const removing = new Set(originalRows.map(row => row.message_seq));
    existingByKey.clear();
    for (const row of rows) if (!removing.has(row.message_seq)) existingByKey.set(exactKey(row.role, row.text, row.timestamp), row);
  }
  const incomingKeys = new Set(), newRecords = [], entries = [];
  records.forEach((record, index) => {
    const m = record.message, key = exactKey(m.type, m.text, m.timestamp), existing = existingByKey.has(key) || incomingKeys.has(key);
    const matched = selections.get(index), candidates = byText.get(textKey(m.type, m.text)) || [];
    if (!existing) newRecords.push(record);
    incomingKeys.add(key);
    entries.push({ index, action: matched ? 'replace' : candidates.length ? 'ambiguous' : existing ? 'already_present' : 'add', alreadyPresent: existing,
      oldDate: matched?.source_date || null, newDate: beijingDateKey(m.timestamp) });
  });
  const affectedDates = [...new Set([...selectedRows.map(row => row.source_date), ...newRecords.map(record => beijingDateKey(record.message.timestamp)), ...(originalBatch ? records.map(record => beijingDateKey(record.message.timestamp)) : entries.filter(row => row.action === 'replace').map(row => row.newDate))])].sort();
  const dayStates = affectedDates.map(date => store.getDayState(date));
  if (dayStates.some(row => row?.status === 'running')) throw new Error('对应日期正在挖掘，请先停止再覆盖');
  let anchors = { retain: {}, eventAnchors: {} };
  const anchorFile = path.join(store.memoryDir, 'retain-config.json');
  if (fs.existsSync(anchorFile)) anchors = JSON.parse(fs.readFileSync(anchorFile, 'utf8'));
  for (const date of affectedDates) {
    const feelings = store.db.prepare('SELECT id FROM feelings WHERE thread_id=? AND source_date=?').all(store.threadId, date);
    if (feelings.some(row => anchors.retain?.[row.id])) throw new Error(`${date} 有原文锚点，请先核对锚点再覆盖`);
  }
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify({ threadId: store.threadId, batches, originalBatch, rows, dayStates, anchors })).digest('hex');
  return { expectedHash, total: records.length, replace: selectedRows.length, add: newRecords.length,
    mode: originalBatch ? 'original-file' : 'matching',
    alreadyPresent: entries.filter(row => row.alreadyPresent).length, ambiguous: originalBatch ? 0 : entries.filter(row => row.action === 'ambiguous').length,
    unmatched: originalBatch ? 0 : entries.filter(row => !['replace', 'ambiguous'].includes(row.action)).length,
    affectedDates, entries, selectedRows, newRecords, dayStates };
}
function publicMatchingPlan(plan) {
  const { selectedRows, newRecords, dayStates, ...result } = plan;
  return result;
}
function applyMatchingReplacement(store, batches, { expectedHash, fullDir, originalBatch = null }) {
  return store.db.transaction(() => {
    const plan = planMatchingReplacement(store, batches, { originalBatch });
    if (!expectedHash || plan.expectedHash !== expectedHash) throw new Error('覆盖预览已经变化，请重新预览');
    const backupDir = path.join(store.memoryDir, 'backups', 'import-replacement');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupFile = path.join(backupDir, `${Date.now()}-${process.pid}-matching.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ kind: 'matching', threadId: store.threadId, plan: publicMatchingPlan(plan), rows: plan.selectedRows, dayStates: plan.dayStates }), { mode: 0o600, flag: 'wx' });
    const remove = store.db.prepare('DELETE FROM messages WHERE thread_id=? AND message_seq=?');
    for (const row of plan.selectedRows) remove.run(store.threadId, row.message_seq);
    let imported = 0, duplicates = 0, fullBacked = 0;
    for (const batch of batches) {
      const result = ingestRecords(batch.records, { memoryStore: store, fullDir, format: batch.format });
      if (result.invalid || result.filtered || result.conversationFiltered || result.toolEvents) throw new Error('清洗结果与预览不一致，覆盖已回滚');
      imported += result.imported; duplicates += result.duplicates; fullBacked += result.fullBacked;
    }
    if (imported !== plan.add || imported + duplicates !== plan.total) throw new Error('导入数量与预览不一致，覆盖已回滚');
    for (const date of plan.affectedDates) {
      const count = store.db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=? AND source_date=?').get(store.threadId, date).n;
      const previous = store.getDayState(date);
      store.setDayState(date, { status: 'failed', messageCount: count, attempt: 0, errorCode: 'ARCHIVE_REPLACED_REMINING_REQUIRED', errorMessage: '原文已更新，等待手动重新挖掘',
        feelingCount: previous?.feeling_count || 0, featureCount: previous?.feature_count || 0, archiveFingerprint: null, completedAt: null, startedAt: null,
        failedAt: new Date().toISOString(), nextRetryAt: null, chunkReport: [] });
    }
    return { replaced: plan.replace, imported, alreadyPresent: plan.alreadyPresent, ambiguous: plan.ambiguous, unmatched: plan.unmatched, affectedDates: plan.affectedDates, fullBacked, backupFile };
  })();
}
module.exports = { normalizedText, planMatchingReplacement, publicMatchingPlan, applyMatchingReplacement };
