#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getThreadDir, listMemoryIds } = require("../src/config");
const { ingestRecords } = require("../src/services/thread-ingest");
const { readImportSource } = require("../src/services/import-source");
const { MemoryStore } = require("../src/storage/memory-store");
const { planMatchingReplacement, publicMatchingPlan, applyMatchingReplacement } = require("../src/services/import-matching-replacement");

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === "import") args.shift();
  const options = { apply: false };
  const values = { "--thread": "thread", "--memory": "memory", "--source": "source", "--sources-file": "sourcesFile", "--dir": "dir", "--table": "table", "--map-time": "timeField", "--map-role": "roleField", "--map-content": "contentField", "--replace-import-file": "originalFile", "--expect-hash": "expectedHash" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") { options.apply = true; continue; }
    if (args[i] === "--dry-run") { options.apply = false; continue; }
    if (args[i] === "--replace-matching") { options.replaceMatching = true; continue; }
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
  if (!options.memory && !options.thread && options.apply) throw new Error("导入写入必须显式指定 --memory <id>");
  if (!options.memory && !options.thread && configured.length > 1) throw new Error("存在多个记忆体，请显式指定 --memory <id>");
  const tid = options.memory || options.thread || (configured.length === 1 ? configured[0] : null);
  if (!tid) throw new Error("未指定记忆体，请用 --memory <id> 或先创建记忆体");
  const threadDir = getThreadDir(tid);
  const memoryDir = path.join(threadDir, "memory");
  const fullDir = path.join(memoryDir, "archive", "full");
  const importDir = path.join(threadDir, "memory", "import");
  const doneDir = path.join(importDir, "done");
  if (options.replaceMatching || options.originalFile) {
    if (options.replaceMatching && options.originalFile) throw new Error("同文覆盖和原文件覆盖不能混用");
    if (options.dir || (!!options.source === !!options.sourcesFile)) throw new Error("覆盖导入必须指定一个来源文件或来源清单");
    const sources = options.source ? [options.source] : JSON.parse(fs.readFileSync(options.sourcesFile, "utf8"));
    if (!Array.isArray(sources) || !sources.length || sources.some(file => typeof file !== "string")) throw new Error("来源清单无效");
    const batches = sources.map(file => { const source = readImportSource({ filePath: path.resolve(file), table: options.table, timeField: options.timeField, roleField: options.roleField, contentField: options.contentField }); return { records: source.records, format: source.preview.format }; });
    let originalBatch = null;
    if (options.originalFile) {
      const originalPath = fs.realpathSync(options.originalFile), donePath = fs.realpathSync(doneDir);
      if (!originalPath.startsWith(donePath + path.sep)) throw new Error("旧文件必须来自当前记忆体已导入文件目录");
      const original = readImportSource({ filePath: originalPath });
      originalBatch = { records: original.records, format: original.preview.format };
    }
    const store = new MemoryStore({ memoryDir, threadId: tid });
    try {
      const plan = planMatchingReplacement(store, batches, { originalBatch });
      if (!options.apply) { console.log(JSON.stringify({ dryRun: true, ...publicMatchingPlan(plan) })); return; }
      const result = applyMatchingReplacement(store, batches, { expectedHash: options.expectedHash, fullDir, originalBatch });
      fs.mkdirSync(doneDir, { recursive: true });
      for (const file of sources) fs.copyFileSync(file, path.join(doneDir, `${Date.now()}-${process.pid}-${path.basename(file)}`));
      console.log(JSON.stringify(result)); return;
    } finally { store.close(); }
  }
  if (options.sourcesFile) throw new Error("来源清单仅适用于覆盖导入");
  if (options.expectedHash) throw new Error("--expect-hash 必须配合同文覆盖或原文件覆盖");
  const files = sourceFiles(options, importDir, doneDir);
  if (!files.length) throw new Error("没有找到可导入的 JSON、JSONL 或 SQLite 文件");
  console.log(`[import] 线程: ${tid}，模式: ${options.apply ? "写入" : "预览"}`);
  let total = 0, full = 0, failed = 0;
  const store = options.apply ? new MemoryStore({ memoryDir, threadId: tid }) : null;
  for (const fp of files) {
    try {
      const source = readImportSource({ filePath: fp, table: options.table, timeField: options.timeField, roleField: options.roleField, contentField: options.contentField });
      printPreview(fp, source.preview);
      if (!options.apply) continue;
      const result = ingestRecords(source.records, { memoryStore: store, fullDir, format: source.preview.format });
      total += result.imported; full += result.fullBacked;
      fs.mkdirSync(doneDir, { recursive: true });
      const ext = path.extname(fp);
      const name = `${path.basename(fp, ext)}_${Date.now()}${ext}`;
      fs.copyFileSync(fp, path.join(doneDir, name));
      console.log(`    写入 archive: +${result.imported}，full 原始备份: +${result.fullBacked}`);
    } catch (error) { failed++; console.error(`\n  失败 ${fp}: ${error.message}`); }
  }
  if (!options.apply) console.log("\n[import] 以上仅为预览；确认映射后加 --apply 写入。额外字段只保留在 full 原始备份中。");
  else console.log(`\n[import] 完成：archive +${total}，full +${full}，失败文件 ${failed}`);
  if (store) store.close();
  if (failed) process.exitCode = 1;
}

try { main(); } catch (error) { console.error(`[import] error: ${error.message}`); process.exitCode = 1; }
