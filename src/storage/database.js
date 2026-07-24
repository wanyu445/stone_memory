const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { resolveDatabasePath } = require("./database-location");
const { messageIdentity } = require("../lib/message-identity");

const SCHEMA_VERSION = 9;

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
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, message_id)
);
CREATE TABLE IF NOT EXISTS mining_day_state (
  thread_id TEXT NOT NULL,
  source_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','completed_empty','failed','blocked')),
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
CREATE INDEX IF NOT EXISTS idx_feelings_thread_timeline
  ON feelings(thread_id, source_date, event_time, order_key);
CREATE INDEX IF NOT EXISTS idx_features_thread_date
  ON features(thread_id, source_date, category);
CREATE INDEX IF NOT EXISTS idx_jobs_thread_date
  ON mining_jobs(thread_id, source_date, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread_date
  ON messages(thread_id, source_date, timestamp);
CREATE INDEX IF NOT EXISTS idx_notifications_thread_read
  ON notifications(thread_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_term_daily_stats_thread_date
  ON term_daily_stats(thread_id, source_date);
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
    migrateColumns(db);
    removeVersionTables(db);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(SCHEMA_VERSION, new Date().toISOString());
  }
  return db;
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
  const threadColumns = new Set(db.pragma("table_info(threads)").map(column => column.name));
  if (!threadColumns.has("parent_thread_id")) db.exec("ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id)");
  if (!threadColumns.has("memories_flow_to_parent")) db.exec("ALTER TABLE threads ADD COLUMN memories_flow_to_parent INTEGER NOT NULL DEFAULT 1 CHECK(memories_flow_to_parent IN (0,1))");
}

module.exports = { openDatabase, SCHEMA_VERSION };
