const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { resolveDatabasePath } = require("./database-location");
const { messageIdentity } = require("../lib/message-identity");

// Version 18 completes the retained-source metadata for conversation import batches.
const SCHEMA_VERSION = 18;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  parent_thread_id TEXT REFERENCES threads(id),
  memories_flow_to_parent INTEGER NOT NULL DEFAULT 1 CHECK(memories_flow_to_parent IN (0,1)),
  runtime TEXT,
  purpose TEXT,
  label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  message_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source_date TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT,
  binding_id TEXT,
  source_message_id TEXT,
  import_batch_id TEXT,
  source_occurred_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, message_id)
);
CREATE TABLE IF NOT EXISTS conversation_filter_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  category TEXT NOT NULL,
  rule_id TEXT,
  original_text TEXT NOT NULL,
  retained_text TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id,timestamp,category,rule_id,original_text)
);
CREATE TABLE IF NOT EXISTS memory_bindings (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES threads(id),
  provider TEXT NOT NULL,
  external_thread_id TEXT,
  thread_file TEXT,
  mode TEXT NOT NULL DEFAULT 'parallel' CHECK(mode IN ('primary','parallel','child','import_only')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(memory_id, provider, external_thread_id)
);
CREATE TABLE IF NOT EXISTS binding_import_batches (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES threads(id),
  binding_id TEXT NOT NULL REFERENCES memory_bindings(id),
  status TEXT NOT NULL CHECK(status IN ('applied','reverted')),
  source_path TEXT,
  source_fingerprint TEXT NOT NULL,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  filtered_count INTEGER NOT NULL DEFAULT 0,
  source_dates_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  applied_at TEXT NOT NULL,
  reverted_at TEXT
);
CREATE TABLE IF NOT EXISTS conversation_import_batches (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  status TEXT NOT NULL CHECK(status IN ('applied','reverted')),
  source_name TEXT NOT NULL,
  source_path TEXT,
  source_fingerprint TEXT NOT NULL,
  format TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  discovered_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  filtered_count INTEGER NOT NULL DEFAULT 0,
  source_dates_json TEXT NOT NULL DEFAULT '[]',
  filtered_reasons_json TEXT NOT NULL DEFAULT '{}',
  applied_at TEXT NOT NULL,
  reverted_at TEXT
);
CREATE TABLE IF NOT EXISTS mining_day_state (
  thread_id TEXT NOT NULL,
  source_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','completed_empty','partial_failed','failed','blocked')),
  message_count INTEGER NOT NULL DEFAULT 0,
  feeling_count INTEGER NOT NULL DEFAULT 0,
  feature_count INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  archive_fingerprint TEXT,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  next_retry_at TEXT,
  chunk_report TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(thread_id, source_date)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  type TEXT NOT NULL,
  source_date TEXT,
  error_code TEXT,
  error_message TEXT,
  attempt INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mining_jobs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  source_date TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('full','remine','targeted')),
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('watcher','cli','mcp','web','import')),
  publish_strategy TEXT NOT NULL CHECK(publish_strategy IN ('auto','replace','append')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','review_pending','completed','failed','discarded','cancelled')),
  instruction TEXT,
  feeling_count INTEGER NOT NULL DEFAULT 0,
  feature_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS feelings (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  source_date TEXT NOT NULL,
  event_time TEXT,
  order_key TEXT NOT NULL,
  content TEXT NOT NULL,
  summary_mode TEXT NOT NULL DEFAULT 'daily' CHECK(summary_mode IN ('daily','coarse','hidden')),
  coarse_summary TEXT,
  coarse_terms TEXT,
  importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 5),
  source TEXT NOT NULL CHECK(source IN ('auto','remine','targeted','manual','import')),
  source_thread TEXT,
  origin_import_batch_id TEXT,
  mining_job_id TEXT REFERENCES mining_jobs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  source_date TEXT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 5),
  source TEXT NOT NULL CHECK(source IN ('auto','remine','targeted','manual','import')),
  source_thread TEXT,
  origin_import_batch_id TEXT,
  mining_job_id TEXT REFERENCES mining_jobs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS term_daily_stats (
  thread_id TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  source_date TEXT NOT NULL,
  user_message_count INTEGER NOT NULL DEFAULT 0,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(thread_id, normalized_term, source_date)
);
CREATE TABLE IF NOT EXISTS notebook_topics (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_path TEXT,
  kind TEXT NOT NULL DEFAULT 'standard',
  presentation_json TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','sealed')),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(thread_id, slug)
);
CREATE TABLE IF NOT EXISTS notebook_entries (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES notebook_topics(id),
  title TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','sealed')),
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  body_text TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(thread_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_feelings_thread_timeline
  ON feelings(thread_id, source_date, event_time, order_key);
CREATE INDEX IF NOT EXISTS idx_features_thread_date
  ON features(thread_id, source_date, category);
CREATE INDEX IF NOT EXISTS idx_jobs_thread_date
  ON mining_jobs(thread_id, source_date, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread_date
  ON messages(thread_id, source_date, timestamp);
CREATE INDEX IF NOT EXISTS idx_conversation_filter_log_thread
  ON conversation_filter_log(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_thread_read
  ON notifications(thread_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_term_daily_stats_thread_date
  ON term_daily_stats(thread_id, source_date);
CREATE INDEX IF NOT EXISTS idx_notebook_topics_thread
  ON notebook_topics(thread_id, is_archived, updated_at);
CREATE INDEX IF NOT EXISTS idx_notebook_entries_thread_topic
  ON notebook_entries(thread_id, topic_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_bindings_memory
  ON memory_bindings(memory_id, enabled, created_at);
CREATE INDEX IF NOT EXISTS idx_binding_batches_memory
  ON binding_import_batches(memory_id, binding_id, applied_at);
CREATE INDEX IF NOT EXISTS idx_conversation_import_batches_thread
  ON conversation_import_batches(thread_id, applied_at);
`;

function openDatabase(memoryDir) {
  const dbPath = resolveDatabasePath(memoryDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // 所有正式线程共享一个 SQLite；per-thread watcher 可并发做模型调用，
  // 短写事务由 SQLite 串行。忙等待不应误计为 miner 语义失败。
  db.pragma("busy_timeout = 30000");
  let currentVersion = 0;
  try { currentVersion = db.prepare("SELECT MAX(version) version FROM schema_migrations").get()?.version || 0; }
  catch {}
  // 多个 per-thread workers 共享数据库。正常连接不得重复争抢 schema DDL；
  // 只有新库或版本升级时才执行建表、列迁移和旧表清理。
  if (currentVersion < SCHEMA_VERSION) {
    db.exec(SCHEMA);
    migrateMessages(db);
    migrateMiningDayState(db);
    migrateColumns(db);
    removeVersionTables(db);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(SCHEMA_VERSION, new Date().toISOString());
  }
  return db;
}

function migrateMiningDayState(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mining_day_state'").get()?.sql || "";
  if (sql.includes("partial_failed")) return;
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE mining_day_state RENAME TO mining_day_state_v9;
    CREATE TABLE mining_day_state (
      thread_id TEXT NOT NULL,
      source_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','completed_empty','partial_failed','failed','blocked')),
      message_count INTEGER NOT NULL DEFAULT 0,
      feeling_count INTEGER NOT NULL DEFAULT 0,
      feature_count INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      archive_fingerprint TEXT,
      started_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      next_retry_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(thread_id, source_date)
    );
    INSERT INTO mining_day_state SELECT * FROM mining_day_state_v9;
    DROP TABLE mining_day_state_v9;
    COMMIT;
  `);
}

function migrateMessages(db) {
  const columns = db.pragma("table_info(messages)");
  if (columns.some(column => column.name === "message_id")) return;
  db.function("stmem_message_id", { deterministic: true }, messageIdentity);
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE messages_v9 (
      message_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      source_date TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(thread_id, message_id)
    );
    INSERT INTO messages_v9
      (thread_id,message_id,timestamp,source_date,role,text,source,created_at)
      SELECT thread_id,stmem_message_id(timestamp,role,text),timestamp,source_date,role,text,source,created_at
      FROM messages ORDER BY timestamp;
    DROP TABLE messages;
    ALTER TABLE messages_v9 RENAME TO messages;
    CREATE INDEX idx_messages_thread_date ON messages(thread_id,source_date,timestamp);
    COMMIT;
  `);
}

function removeVersionTables(db) {
  db.exec("DROP TABLE IF EXISTS memory_candidates; DROP TABLE IF EXISTS memory_revisions;");
}

function migrateColumns(db) {
  const feelingColumns = new Set(db.pragma("table_info(feelings)").map(column => column.name));
  if (!feelingColumns.has("summary_mode")) db.exec("ALTER TABLE feelings ADD COLUMN summary_mode TEXT NOT NULL DEFAULT 'daily' CHECK(summary_mode IN ('daily','coarse','hidden'))");
  if (!feelingColumns.has("coarse_summary")) db.exec("ALTER TABLE feelings ADD COLUMN coarse_summary TEXT");
  if (!feelingColumns.has("coarse_terms")) db.exec("ALTER TABLE feelings ADD COLUMN coarse_terms TEXT");
  if (!feelingColumns.has("origin_import_batch_id")) db.exec("ALTER TABLE feelings ADD COLUMN origin_import_batch_id TEXT");
  const featureColumns = new Set(db.pragma("table_info(features)").map(column => column.name));
  if (!featureColumns.has("origin_import_batch_id")) db.exec("ALTER TABLE features ADD COLUMN origin_import_batch_id TEXT");
  const messageColumns = new Set(db.pragma("table_info(messages)").map(column => column.name));
  if (!messageColumns.has("binding_id")) db.exec("ALTER TABLE messages ADD COLUMN binding_id TEXT");
  if (!messageColumns.has("source_message_id")) db.exec("ALTER TABLE messages ADD COLUMN source_message_id TEXT");
  if (!messageColumns.has("import_batch_id")) db.exec("ALTER TABLE messages ADD COLUMN import_batch_id TEXT");
  if (!messageColumns.has("source_occurred_at")) db.exec("ALTER TABLE messages ADD COLUMN source_occurred_at TEXT");
  const threadColumns = new Set(db.pragma("table_info(threads)").map(column => column.name));
  if (!threadColumns.has("parent_thread_id")) db.exec("ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id)");
  if (!threadColumns.has("memories_flow_to_parent")) db.exec("ALTER TABLE threads ADD COLUMN memories_flow_to_parent INTEGER NOT NULL DEFAULT 1 CHECK(memories_flow_to_parent IN (0,1))");
  const miningColumns = new Set(db.pragma("table_info(mining_day_state)").map(column => column.name));
  if (!miningColumns.has("chunk_report")) db.exec("ALTER TABLE mining_day_state ADD COLUMN chunk_report TEXT");
  const importBatchColumns = new Set(db.pragma("table_info(conversation_import_batches)").map(column => column.name));
  if (!importBatchColumns.has("source_path")) db.exec("ALTER TABLE conversation_import_batches ADD COLUMN source_path TEXT");
  if (!importBatchColumns.has("metadata_json")) db.exec("ALTER TABLE conversation_import_batches ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  const notebookTopicColumns = new Set(db.pragma("table_info(notebook_topics)").map(column => column.name));
  if (!notebookTopicColumns.has("is_default")) db.exec("ALTER TABLE notebook_topics ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1))");
  if (!notebookTopicColumns.has("kind")) db.exec("ALTER TABLE notebook_topics ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard'");
  if (!notebookTopicColumns.has("presentation_json")) db.exec("ALTER TABLE notebook_topics ADD COLUMN presentation_json TEXT NOT NULL DEFAULT '{}'");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_notebook_topics_one_default ON notebook_topics(thread_id) WHERE is_default=1");
  const notebookEntryColumns = new Set(db.pragma("table_info(notebook_entries)").map(column => column.name));
  if (!notebookEntryColumns.has("metadata_json")) db.exec("ALTER TABLE notebook_entries ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_binding ON messages(thread_id,binding_id,timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_import_batch ON messages(thread_id,import_batch_id)");
}

// Read adapters must never initialize or migrate persistent storage.
function openReadDatabase(memoryDir) {
  const dbPath = resolveDatabasePath(memoryDir);
  try { fs.statSync(dbPath); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let version = 0;
    try { version = db.prepare("SELECT MAX(version) version FROM schema_migrations").get()?.version || 0; }
    catch { /* An uninitialized/legacy database must be upgraded by the CLI. */ }
    if (version < SCHEMA_VERSION) throw new Error("STORAGE_UPGRADE_REQUIRED");
    return db;
  } catch (error) { db.close(); throw error; }
}

module.exports = { openDatabase, openReadDatabase, SCHEMA_VERSION };
