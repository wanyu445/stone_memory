#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getThreadDir, listMemoryIds } = require("../src/config");
const { ingestRecords, beijingDateKey } = require("../src/services/thread-ingest");
const { readImportSource } = require("../src/services/import-source");
const { MemoryStore } = require("../src/storage/memory-store");
const { openDatabase } = require("../src/storage/database");
const { sourceFingerprint, newBatchId, recordConversationImport, listConversationImports, previewConversationImportRevert, revertConversationImport } = require("../src/services/conversation-imports");

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === "import") args.shift();
  const options = { apply: false, json: false, list: false, revert: null, reimport: null };
  const values = { "--thread": "thread", "--memory": "memory", "--source": "source", "--dir": "dir", "--table": "table", "--map-time": "timeField", "--map-role": "roleField", "--map-content": "contentField" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") { options.apply = true; continue; }
    if (args[i] === "--dry-run") { options.apply = false; continue; }
    if (args[i] === "--json") { options.json = true; continue; }
    if (args[i] === "--list") { options.list = true; continue; }
    if (args[i] === "--revert") { if (!args[i + 1]) throw new Error("--revert 缺少批次 ID"); options.revert = args[++i]; continue; }
    if (args[i] === "--reimport") { if (!args[i + 1]) throw new Error("--reimport 缺少批次 ID"); options.reimport = args[++i]; continue; }
    if (args[i] === "--source-name") { if (!args[i + 1]) throw new Error("--source-name 缺少文件名"); options.sourceName = args[++i]; continue; }
    const key = values[args[i]];
    if (!key || !args[i + 1]) throw new Error(`未知或缺少参数：${args[i]}`);
    options[key] = args[++i];
  }
  return options;
}

function sourceFiles(options, importDir, doneDir) {
  if (options.source) return [path.resolve(options.source)];
  const root = path.resolve(options.dir || importDir);
  if (!fs.existsSync(root)) throw new Error(`路径不存在：${root}`);
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name);
      if (fp === doneDir || fp.startsWith(doneDir + path.sep)) continue;
      if (entry.isDirectory()) walk(fp);
      else if ([".json", ".jsonl", ".db", ".sqlite", ".sqlite3"].includes(path.extname(entry.name).toLowerCase())) files.push(fp);
    }
  }
  walk(root);
  return files.sort();
}

function printPreview(fp, preview) {
  console.log(`\n  ${fp}`);
  console.log(`    来源: ${preview.format}${preview.table ? ` / ${preview.table}` : ""}`);
  console.log(`    总行数: ${preview.totalRows}，可导入: ${preview.valid}，内部记录过滤: ${preview.filtered || 0}，无效: ${preview.invalid}`);
  if (preview.filtered) console.log(`    过滤原因: ${JSON.stringify(preview.filteredReasons)}`);
  console.log(`    日期: ${preview.firstDate || "-"} → ${preview.lastDate || "-"}，角色: ${JSON.stringify(preview.roles)}`);
  if (preview.detectedFields.length) console.log(`    识别字段: ${preview.detectedFields.join(", ")}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.thread && options.memory && options.thread !== options.memory) throw new Error("--memory 与兼容参数 --thread 不能指向不同记忆体");
  const configured = listMemoryIds();
  if (!options.memory && !options.thread && (options.apply || options.revert || options.reimport)) throw new Error("导入写入必须显式指定 --memory <id>");
  if (!options.memory && !options.thread && configured.length > 1) throw new Error("存在多个记忆体，请显式指定 --memory <id>");
  const tid = options.memory || options.thread || (configured.length === 1 ? configured[0] : null);
  if (!tid) throw new Error("未指定记忆体，请用 --memory <id> 或先创建记忆体");
  const threadDir = getThreadDir(tid);
  const memoryDir = path.join(threadDir, "memory");
  const fullDir = path.join(memoryDir, "archive", "full");
  const importDir = path.join(threadDir, "memory", "import");
  const doneDir = path.join(importDir, "done");
  if (options.list || options.revert) {
    // This CLI command owns storage-version migration; preview does not touch conversation rows.
    const store = { memoryDir, threadId: tid, db: openDatabase(memoryDir), close() { this.db.close(); } };
    try {
      if (options.list) {
        const result = { batches: listConversationImports(store) };
        console.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
        return;
      }
      const preview = previewConversationImportRevert(store, options.revert);
      if (!options.apply) {
        console.log(options.json ? JSON.stringify(preview) : JSON.stringify(preview, null, 2));
        return;
      }
      const result = revertConversationImport(store, options.revert);
      console.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
      return;
    } finally { store.close(); }
  }
  if (options.reimport) {
    if (options.source || options.dir) throw new Error("--reimport 不能与 --source 或 --dir 同用");
    const db = openDatabase(memoryDir);
    try {
      const batch = db.prepare("SELECT source_path,source_name,source_fingerprint,metadata_json FROM conversation_import_batches WHERE id=? AND thread_id=?")
        .get(options.reimport, tid);
      if (!batch?.source_path) throw new Error(`批次没有可重导的原始文件：${options.reimport}`);
      const retainedPath = path.resolve(batch.source_path), retainedRoot = path.resolve(doneDir) + path.sep;
      if (!retainedPath.startsWith(retainedRoot) || !fs.existsSync(retainedPath) || !fs.statSync(retainedPath).isFile()) {
        throw new Error("批次原始文件不存在或不在受管理的导入备份目录中，拒绝重导");
      }
      if (sourceFingerprint(retainedPath) !== batch.source_fingerprint) throw new Error("受管理的原始文件指纹已变化，拒绝重导");
      let metadata = {};
      try { metadata = JSON.parse(batch.metadata_json || "{}"); } catch {}
      options.source = retainedPath;
      options.sourceName = batch.source_name;
      options.table ||= metadata.table;
      options.timeField ||= metadata.timeField;
      options.roleField ||= metadata.roleField;
      options.contentField ||= metadata.contentField;
    } finally { db.close(); }
  }
  const files = sourceFiles(options, importDir, doneDir);
  if (!files.length) throw new Error("没有找到可导入的 JSON、JSONL 或 SQLite 文件");
  if (!options.json) console.log(`[import] 线程: ${tid}，模式: ${options.apply ? "写入" : "预览"}`);
  let total = 0, full = 0, failed = 0;
  const results = [];
  const store = options.apply ? new MemoryStore({ memoryDir, threadId: tid }) : null;
  for (const fp of files) {
    try {
      const source = readImportSource({ filePath: fp, table: options.table, timeField: options.timeField, roleField: options.roleField, contentField: options.contentField });
      if (!options.json) printPreview(fp, source.preview);
      if (!options.apply) continue;
      const id = newBatchId();
      const fingerprint = sourceFingerprint(fp);
      const appliedAt = new Date().toISOString();
      fs.mkdirSync(doneDir, { recursive: true });
      const ext = path.extname(fp);
      const retainedName = `${path.basename(fp, ext)}_${Date.now()}_${id.slice(-6)}${ext}`;
      const retainedPath = path.join(doneDir, retainedName);
      fs.copyFileSync(fp, retainedPath);
      let result;
      store.db.transaction(() => {
        result = ingestRecords(source.records, { memoryStore: store, fullDir, format: source.preview.format, messageOptions: { importBatchId: id } });
        const batchSourceDates = [...new Set([...result.sourceDates,
          ...source.records.map(record => beijingDateKey(record.message?.timestamp || record.raw?.timestamp)).filter(Boolean),
        ])].sort();
        recordConversationImport(store, { id, sourceName: options.sourceName || path.basename(fp), sourcePath: retainedPath,
          fingerprint, format: source.preview.format,
          metadata: { table: source.preview.table, timeField: options.timeField || null, roleField: options.roleField || null, contentField: options.contentField || null },
          discovered: source.preview.valid, invalid: source.preview.invalid, result: { ...result, sourceDates: batchSourceDates }, appliedAt });
      })();
      total += result.imported; full += result.fullBacked;
      const batchResult = { batchId: id, sourceName: options.sourceName || path.basename(fp), sourceFingerprint: fingerprint, format: source.preview.format,
        discovered: source.preview.valid, inserted: result.imported, duplicates: result.duplicates,
        invalid: source.preview.invalid, filtered: result.filtered, filteredReasons: result.filteredReasons,
        sourceDates: [...new Set([...result.sourceDates, ...source.records.map(record => beijingDateKey(record.message?.timestamp || record.raw?.timestamp)).filter(Boolean)])].sort(), appliedAt };
      results.push(batchResult);
      if (!options.json) console.log(`    批次: ${id}；写入 archive: +${result.imported}，重复: ${result.duplicates}，full 原始备份: +${result.fullBacked}`);
    } catch (error) { failed++; console.error(`\n  失败 ${fp}: ${error.message}`); }
  }
  if (!options.apply) {
    if (options.json) console.log(JSON.stringify({ previewOnly: true, files: files.length }));
    else console.log("\n[import] 以上仅为预览；确认映射后加 --apply 写入。额外字段只保留在 full 原始备份中。");
  } else if (options.json) console.log(JSON.stringify({ results, imported: total, fullBacked: full, failed }));
  else console.log(`\n[import] 完成：archive +${total}，full +${full}，失败文件 ${failed}`);
  if (store) store.close();
  if (failed) process.exitCode = 1;
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
