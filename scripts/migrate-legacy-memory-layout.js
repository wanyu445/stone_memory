#!/usr/bin/env node
// Standalone migration for a legacy runtime directory. Never removes the source.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const dataRoot = path.join(os.homedir(), ".stone_memory");
const configFile = path.join(dataRoot, "stmem.json");
const safeName = /^(?!\.{1,2}$)(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))[A-Za-z0-9._-]+$/iu;
const reservedKeys = new Set(["runtimes", "threadId", "apiKeys", "web", "memories"]);
const transientRootEntries = new Set([".watcher.lock"]);

function options(argv) {
  const result = { memory: null, batchFile: null, apply: false, servicesStopped: false, formalCli: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--memory" && argv[i + 1]) result.memory = argv[++i];
    else if (argv[i] === "--batch-file" && argv[i + 1]) result.batchFile = argv[++i];
    else if (argv[i] === "--apply") result.apply = true;
    else if (argv[i] === "--dry-run") result.apply = false;
    else if (argv[i] === "--services-stopped") result.servicesStopped = true;
    else if (argv[i] === "--formal-cli") result.formalCli = true;
    else if (argv[i] === "--help" || argv[i] === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return result;
}

function hash(file) {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const handle = fs.openSync(file, "r");
  try {
    let count;
    while ((count = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0)
      digest.update(buffer.subarray(0, count));
  } finally { fs.closeSync(handle); }
  return digest.digest("hex");
}

function listFiles(root, relative = "", skipped = { files: 0, bytes: 0 }) {
  const result = [];
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, item.name);
    // Runtime locks and generated prompt scratch files are not durable memory.
    // Copying a legacy tmp directory can add tens of thousands of files and
    // gigabytes to an otherwise small layout migration.
    if (!relative && transientRootEntries.has(item.name)) continue;
    if (relative === "tmp" && item.isFile() && /^prompt_.*\.txt$/u.test(item.name)) {
      skipped.files += 1;
      skipped.bytes += fs.statSync(path.join(root, child)).size;
      continue;
    }
    if (item.isSymbolicLink()) throw new Error(`Symlink in legacy directory: ${child}`);
    if (item.isDirectory()) result.push({ relative: child, directory: true }, ...listFiles(root, child, skipped));
    else if (item.isFile()) result.push({ relative: child, directory: false, bytes: fs.statSync(path.join(root, child)).size });
    else throw new Error(`Unsupported file in legacy directory: ${child}`);
  }
  return result;
}

function activeWatcher(root) {
  const lock = path.join(root, ".watcher.lock");
  if (!fs.existsSync(lock)) return null;
  const ownerFile = path.join(lock, "owner.json");
  if (!fs.existsSync(ownerFile)) throw new Error("Incomplete watcher lock; inspect it before migration");
  const pid = Number(JSON.parse(fs.readFileSync(ownerFile, "utf8")).pid);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid watcher PID; inspect lock before migration");
  try { process.kill(pid, 0); return pid; }
  catch (error) { return error.code === "ESRCH" ? null : pid; }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function copyVerified(source, stage, entries) {
  for (const entry of entries) {
    const from = path.join(source, entry.relative);
    const to = path.join(stage, entry.relative);
    if (entry.directory) { fs.mkdirSync(to, { recursive: true, mode: 0o700 }); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    const stat = fs.statSync(from);
    fs.chmodSync(to, stat.mode & 0o777);
    fs.utimesSync(to, stat.atime, stat.mtime);
    if (hash(from) !== hash(to)) throw new Error(`Copy hash mismatch: ${entry.relative}`);
  }
}

function scaffold(root, ai) {
  for (const dir of ["memory/archive/full", "memory/import/done", "memory/mined/feelings", "rules", "logs"])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  const name = String(ai || "AI").trim() || "AI";
  const files = {
    "memory/retain-config.json": { retain: {}, eventAnchors: {} },
    "memory/audit-marks.json": { lastCutoffDate: `${new Date().getFullYear()}-01-01`, retainMarks: {} },
  };
  for (const [relative, value] of Object.entries(files)) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) writeJson(file, value);
  }
  const rules = {
    "instructions.md": `# ${name} 的系统指令\n\n在此定义 ${name} 的基础人格、行为规则、回复风格。\n每次 rebuild 时这些指令会自动注入到新线程头部。\n`,
    "operations.md": `# ${name} 的操作指令\n\n在此定义 ${name} 可以使用的工具、API、外部系统。\n每次 rebuild 时这些操作指令会自动注入到新线程头部。\n`,
  };
  for (const [fileName, content] of Object.entries(rules)) {
    const file = path.join(root, "rules", fileName);
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
}

function oldFlag(entry, module, key, fallback) {
  if (Object.hasOwn(entry.watcherModules || {}, module)) return entry.watcherModules[module] === true;
  if (Object.hasOwn(entry, key)) return entry[key] === true;
  return fallback;
}

function metadata(id, entry, now, patch = {}) {
  const modules = {
    ...(entry.watcherModules || {}),
    archive: oldFlag(entry, "archive", "automaticFullMining", true),
    miner: oldFlag(entry, "miner", "automaticMemoryMaintenance", true),
    compression: oldFlag(entry, "compression", "automaticCompression", false),
    dream: oldFlag(entry, "dream", "automaticDream", false),
  };
  return {
    memory: {
      schemaVersion: 1, memoryId: id, label: patch.label || entry.label || id, status: "active",
      purpose: patch.purpose || patch.scenario || entry.purpose || null,
      scenario: patch.scenario || patch.purpose || entry.scenario || entry.purpose || "accompany",
      ai: patch.ai ?? entry.ai ?? "", user: patch.user ?? entry.user ?? "",
      userGender: patch.userGender || entry.userGender || "unspecified",
      relationshipTimeline: Array.isArray(entry.relationshipTimeline) ? entry.relationshipTimeline : [],
      mcpModules: Array.isArray(entry.mcpModules) ? entry.mcpModules : ["notebook-lab", "dream-lab"],
      mcpModuleConfigVersion: Number(entry.mcpModuleConfigVersion) || 1,
      miner: { mode: entry.minerMode || null, apiProfile: entry.apiProvider || null },
      rebuild: {
        windowDays: entry.windowDays ?? 3, keepToolPairs: entry.keepToolPairs ?? 30,
        contextWindowTokens: entry.contextWindowTokens ?? null,
        mcpRebuildDefaultsEnabled: entry.mcpRebuildDefaultsEnabled === true,
        mcpSummaryLimit: entry.mcpSummaryLimit ?? 0, mcpMinImportance: entry.mcpMinImportance ?? 0,
      },
      createdAt: entry.createdAt || now, updatedAt: entry.updatedAt || entry.createdAt || now,
    },
    bindings: { schemaVersion: 1, revision: 0, primaryBindingId: null, bindings: [] },
    // A canonical worker must not start until the legacy window has been
    // validated and recorded as a formal Binding.
    watcher: { schemaVersion: 1, enabled: false, modules },
    receipt: { schemaVersion: 1, status: "complete", memoryId: id, origin: "legacy-runtime-v0", completedAt: now },
  };
}

function legacyForkDescendants(config, parentId) {
  const result = [];
  const queue = [parentId];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift();
    for (const [id, entry] of Object.entries(config)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.parentThreadId !== parent || seen.has(id)) continue;
      seen.add(id); queue.push(id);
      result.push({ id, parentThreadId: parent, label: entry.label || id, runtime: entry.runtime || null });
    }
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  const flags = options(argv);
  if (flags.help) {
    console.log("node scripts/migrate-legacy-memory-layout.js --memory <legacy-id> [--apply --services-stopped]\nDry run by default. Before --apply, stop Web and every watcher; --services-stopped is your confirmation, not an automatic global service check. Apply backs up stmem.json under ~/.stone_memory/backups/layout-migration, keeps old files and SQLite, and creates an unbound canonical memory. Bind its thread separately before restarting services.");
    return;
  }
  if (!flags.memory || !safeName.test(flags.memory) || reservedKeys.has(flags.memory)) throw new Error("Supply a safe --memory <legacy-id>");
  const configBytes = fs.readFileSync(configFile);
  const configHash = crypto.createHash("sha256").update(configBytes).digest("hex");
  const config = JSON.parse(configBytes.toString("utf8"));
  const legacy = config[flags.memory];
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw new Error("Not a legacy memory entry");
  if (legacy.parentThreadId) throw new Error(`这是旧 fork 子记忆体；请从根记忆体 ${legacy.parentThreadId} 发起升级，子线程会作为 Binding 归并`);
  if (legacy.memoryId && legacy.memoryId !== flags.memory) throw new Error("Legacy alias differs from memoryId; migrate with an explicit plan");
  const runtime = legacy.runtime || "claude";
  const purpose = legacy.purpose || "accompany";
  if (!safeName.test(runtime) || !safeName.test(purpose)) throw new Error("Unsafe runtime or purpose directory");
  const source = path.join(dataRoot, "runtimes", runtime, purpose, flags.memory);
  const destination = path.join(dataRoot, "memories", flags.memory);
  if (!fs.existsSync(source) || !fs.lstatSync(source).isDirectory()) throw new Error("Legacy directory not found or is a symlink");
  if (fs.existsSync(destination) || config.memories?.[flags.memory]) throw new Error("Canonical memory already exists; inspect before retrying");
  const watcherPid = activeWatcher(source);
  const skippedTransient = { files: 0, bytes: 0 };
  const entries = listFiles(source, "", skippedTransient);
  const reserved = new Set(["memory.json", "bindings.json", "watcher.json", ".layout-v1.json"]);
  if (entries.some(item => !item.directory && reserved.has(item.relative))) throw new Error("Legacy directory already contains canonical metadata");
  const files = entries.filter(item => !item.directory);
  const bytes = files.reduce((total, item) => total + item.bytes, 0);
  const patch = flags.batchFile ? JSON.parse(fs.readFileSync(flags.batchFile, "utf8")) : {};
  const unknown = Object.keys(patch).filter(key => !["label", "purpose", "scenario", "ai", "user", "userGender"].includes(key));
  if (unknown.length) throw new Error(`Unsupported migration fields: ${unknown.join(", ")}`);
  const preview = metadata(flags.memory, legacy, new Date().toISOString(), patch);
  const forkDescendants = legacyForkDescendants(config, flags.memory);
  const summary = {
    memoryId: flags.memory, files: files.length, bytes,
    skippedTransientFiles: skippedTransient.files, skippedTransientBytes: skippedTransient.bytes,
    legacyForkDescendants: forkDescendants,
    warning: [
      skippedTransient.files ? `检测到 ${skippedTransient.files} 个旧版临时 prompt 文件；升级不会复制，请按需清理旧目录以释放空间` : null,
      forkDescendants.length ? `检测到 ${forkDescendants.length} 个旧 fork 子记忆体；升级后将按线程 lineage 归并为当前记忆体的 Binding，不再显示为独立记忆体` : null,
    ].filter(Boolean).join("；") || null,
    activeWatcherPid: watcherPid, legacySourcePreserved: true, sqliteChanged: false, settings: preview.memory,
  };
  if (!flags.apply) { console.log(JSON.stringify({ dryRun: true, blocked: watcherPid !== null, ...summary }, null, 2)); return; }
  if (!flags.formalCli && !flags.servicesStopped) throw new Error("Stop Web and watcher, then pass --services-stopped");
  if (watcherPid !== null) throw new Error(`Watcher PID ${watcherPid} is still active`);
  if (typeof fs.statfsSync !== "function") throw new Error("Node version cannot check free disk space");
  const space = fs.statfsSync(dataRoot);
  if (space.bavail * space.bsize < bytes + 64 * 1024 * 1024) throw new Error("Insufficient free space for copy plus 64 MiB margin");

  const backupRoot = path.join(dataRoot, "backups", "layout-migration", flags.memory);
  const backup = path.join(backupRoot, new Date().toISOString().replace(/[:.]/gu, "-"));
  const stage = path.join(dataRoot, "memories", `.layout-migration-${flags.memory}-${process.pid}`);
  const tempConfig = `${configFile}.layout-migration-${process.pid}.tmp`;
  if (fs.existsSync(stage) || fs.existsSync(tempConfig)) throw new Error("Migration staging already exists; inspect before retrying");
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(backup, { recursive: false, mode: 0o700 });
  fs.copyFileSync(configFile, path.join(backup, "stmem.json"), fs.constants.COPYFILE_EXCL);
  fs.chmodSync(path.join(backup, "stmem.json"), 0o600);
  if (hash(path.join(backup, "stmem.json")) !== configHash) throw new Error("Configuration changed before backup completed");
  let staged = false;
  let moved = false;
  let committed = false;
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.mkdirSync(stage, { mode: 0o700 });
    staged = true;
    copyVerified(source, stage, entries);
    const next = metadata(flags.memory, legacy, new Date().toISOString(), patch);
    scaffold(stage, next.memory.ai);
    for (const [file, value] of Object.entries({ "memory.json": next.memory, "bindings.json": next.bindings, "watcher.json": next.watcher, ".layout-v1.json": next.receipt }))
      writeJson(path.join(stage, file), value);
    fs.renameSync(stage, destination);
    moved = true;
    config.memories = config.memories || {};
    config.memories[flags.memory] = { memoryId: flags.memory, label: next.memory.label, status: "active", createdAt: next.memory.createdAt, updatedAt: next.memory.updatedAt, bindings: [] };
    if (hash(configFile) !== configHash) throw new Error("Configuration changed during migration; original not overwritten");
    fs.writeFileSync(tempConfig, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tempConfig, configFile);
    committed = true;
  } catch (error) {
    if (staged && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    if (fs.existsSync(tempConfig)) fs.rmSync(tempConfig, { force: true });
    if (moved && !committed && fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  console.log(JSON.stringify({ applied: true, backup, bindingRequired: true, ...summary }, null, 2));
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`[layout-migration] ${error.message}`); process.exitCode = 1; }
}

module.exports = { main, options, metadata };
