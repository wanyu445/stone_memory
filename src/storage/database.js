const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  mining_job_id TEXT NOT NULL REFERENCES mining_jobs(id) ON DELETE CASCADE,
  memory_type TEXT NOT NULL CHECK(memory_type IN ('feeling','feature')),
  source_date TEXT NOT NULL,
  event_time TEXT,
  category TEXT,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 5),
  source_message_ids TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  source_date TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('feeling','feature','day')),
  entity_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('create','update','delete','replace','append')),
  mining_job_id TEXT REFERENCES mining_jobs(id),
  old_data TEXT,
  new_data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feelings_thread_timeline
  ON feelings(thread_id, source_date, event_time, order_key);
CREATE INDEX IF NOT EXISTS idx_features_thread_date
  ON features(thread_id, source_date, category);
CREATE INDEX IF NOT EXISTS idx_jobs_thread_date
  ON mining_jobs(thread_id, source_date, created_at);
CREATE INDEX IF NOT EXISTS idx_candidates_job
  ON memory_candidates(mining_job_id);
`;

function openDatabase(memoryDir) {
  fs.mkdirSync(memoryDir, { recursive: true });
  const db = new Database(path.join(memoryDir, "stone-memory.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(SCHEMA_VERSION, new Date().toISOString());
  return db;
}

module.exports = { openDatabase, SCHEMA_VERSION };
