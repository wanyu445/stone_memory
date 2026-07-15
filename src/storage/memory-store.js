const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { openDatabase } = require("./database");
const { listDateFiles } = require("../lib/archive-paths");

function id(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
}

function dateFromFeeling(entry) {
  if (entry.sourceDate) return entry.sourceDate;
  const match = String(entry.content || "").match(/^(\d{1,2})月(\d{1,2})日/);
  if (!match) return null;
  const created = new Date(entry.createdAt || Date.now());
  let year = created.getUTCFullYear();
  const month = Number(match[1]);
  if (month > created.getUTCMonth() + 2) year--;
  return `${year}-${String(month).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
}

class MemoryStore {
  constructor({ memoryDir, threadId }) {
    this.memoryDir = memoryDir;
    this.threadId = threadId;
    this.db = openDatabase(memoryDir);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO threads(id,created_at,updated_at) VALUES (?,?,?)`).run(threadId, now, now);
  }

  registerThread({ runtime = null, purpose = null, label = null } = {}) {
    this.db.prepare(`UPDATE threads SET runtime=?,purpose=?,label=?,updated_at=? WHERE id=?`)
      .run(runtime, purpose, label, new Date().toISOString(), this.threadId);
  }

  setFork({ parentThreadId, memoriesFlowToParent = true }) {
    if (!parentThreadId || parentThreadId === this.threadId) throw new Error("parent thread must differ from child thread");
    const parent = this.db.prepare("SELECT id FROM threads WHERE id=?").get(parentThreadId);
    if (!parent) throw new Error(`parent thread not found: ${parentThreadId}`);
    const cycle = this.db.prepare(`WITH RECURSIVE ancestors(id,parent_thread_id) AS (
      SELECT id,parent_thread_id FROM threads WHERE id=?
      UNION ALL
      SELECT t.id,t.parent_thread_id FROM threads t JOIN ancestors a ON t.id=a.parent_thread_id
    ) SELECT 1 FROM ancestors WHERE id=? LIMIT 1`).get(parentThreadId, this.threadId);
    if (cycle) throw new Error("fork relationship would create a cycle");
    this.db.prepare(`UPDATE threads SET parent_thread_id=?,memories_flow_to_parent=?,updated_at=? WHERE id=?`)
      .run(parentThreadId, memoriesFlowToParent ? 1 : 0, new Date().toISOString(), this.threadId);
    return this.getThread();
  }

  getThread() {
    return this.db.prepare("SELECT * FROM threads WHERE id=?").get(this.threadId) || null;
  }

  setMemoriesFlowToParent(enabled) {
    this.db.prepare("UPDATE threads SET memories_flow_to_parent=?,updated_at=? WHERE id=?")
      .run(enabled ? 1 : 0, new Date().toISOString(), this.threadId);
    return this.getThread();
  }

  close() { this.db.close(); }

  insertMessages(rows, { source = "archive" } = {}) {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO messages
      (thread_id,timestamp,source_date,role,text,source,created_at)
      VALUES (@threadId,@timestamp,@sourceDate,@role,@text,@source,@createdAt)`);
    const write = this.db.transaction(items => {
      let added = 0;
      const now = new Date().toISOString();
      for (const row of items) {
        if (!row?.timestamp || !row?.sourceDate || !row?.role || !row?.text) continue;
        added += insert.run({ threadId: this.threadId, timestamp: row.timestamp, sourceDate: row.sourceDate,
          role: row.role, text: row.text, source: row.source || source, createdAt: row.createdAt || now }).changes;
      }
      return added;
    });
    return write(rows);
  }

  listMessages({ date = null, from = null, to = null } = {}) {
    const clauses = ["thread_id=?"];
    const params = [this.threadId];
    if (date) { clauses.push("source_date=?"); params.push(date); }
    if (from) { clauses.push("timestamp>=?"); params.push(from); }
    if (to) { clauses.push("timestamp<=?"); params.push(to); }
    return this.db.prepare(`SELECT timestamp,source_date AS sourceDate,role AS type,text,source,created_at AS createdAt
      FROM messages WHERE ${clauses.join(" AND ")} ORDER BY timestamp`).all(...params);
  }

  listMessageDates() {
    return this.db.prepare("SELECT DISTINCT source_date date FROM messages WHERE thread_id=? ORDER BY source_date").all(this.threadId).map(row => row.date);
  }

  getDayState(date) {
    return this.db.prepare("SELECT * FROM mining_day_state WHERE thread_id=? AND source_date=?").get(this.threadId, date) || null;
  }

  listDayStates() {
    return this.db.prepare("SELECT * FROM mining_day_state WHERE thread_id=? ORDER BY source_date").all(this.threadId);
  }

  setDayState(date, patch) {
    const current = this.getDayState(date) || {};
    const value = (key, column, fallback = null) => Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : (current[column] ?? fallback);
    const row = {
      threadId: this.threadId, sourceDate: date,
      status: patch.status || current.status || "running",
      messageCount: value("messageCount", "message_count", 0),
      feelingCount: value("feelingCount", "feeling_count", 0),
      featureCount: value("featureCount", "feature_count", 0),
      attempt: value("attempt", "attempt", 0),
      errorCode: value("errorCode", "error_code"),
      errorMessage: value("errorMessage", "error_message"),
      archiveFingerprint: value("archiveFingerprint", "archive_fingerprint"),
      startedAt: value("startedAt", "started_at"),
      completedAt: value("completedAt", "completed_at"),
      failedAt: value("failedAt", "failed_at"),
      nextRetryAt: value("nextRetryAt", "next_retry_at"),
      updatedAt: patch.updatedAt || new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO mining_day_state
      (thread_id,source_date,status,message_count,feeling_count,feature_count,attempt,error_code,error_message,archive_fingerprint,started_at,completed_at,failed_at,next_retry_at,updated_at)
      VALUES (@threadId,@sourceDate,@status,@messageCount,@feelingCount,@featureCount,@attempt,@errorCode,@errorMessage,@archiveFingerprint,@startedAt,@completedAt,@failedAt,@nextRetryAt,@updatedAt)
      ON CONFLICT(thread_id,source_date) DO UPDATE SET
      status=excluded.status,message_count=excluded.message_count,feeling_count=excluded.feeling_count,
      feature_count=excluded.feature_count,attempt=excluded.attempt,error_code=excluded.error_code,
      error_message=excluded.error_message,archive_fingerprint=excluded.archive_fingerprint,
      started_at=excluded.started_at,completed_at=excluded.completed_at,failed_at=excluded.failed_at,
      next_retry_at=excluded.next_retry_at,updated_at=excluded.updated_at`).run(row);
    return this.getDayState(date);
  }

  clearDayState(date) {
    return this.db.prepare("DELETE FROM mining_day_state WHERE thread_id=? AND source_date=?").run(this.threadId, date).changes;
  }

  addNotification({ type, date = null, errorCode = null, errorMessage = null, attempt = null }) {
    return this.db.prepare(`INSERT INTO notifications
      (thread_id,type,source_date,error_code,error_message,attempt,is_read,created_at) VALUES (?,?,?,?,?,?,0,?)`)
      .run(this.threadId, type, date, errorCode, errorMessage, attempt, new Date().toISOString());
  }

  migrateLegacy() {
    const feelingsFile = path.join(this.memoryDir, "mined", "feelings", "days.jsonl");
    const featuresDir = path.join(this.memoryDir, "mined", "features");
    const stateFile = path.join(this.memoryDir, "mined", "state.json");
    const now = new Date().toISOString();
    let feelingCount = 0, featureCount = 0, jobCount = 0, messageCount = 0, stateCount = 0;

    const insertFeeling = this.db.prepare(`INSERT OR IGNORE INTO feelings
      (id,thread_id,source_date,event_time,order_key,content,importance,source,source_thread,mining_job_id,created_at,updated_at)
      VALUES (@id,@threadId,@sourceDate,@eventTime,@orderKey,@content,@importance,'import',@sourceThread,NULL,@createdAt,@updatedAt)`);
    const insertFeature = this.db.prepare(`INSERT OR IGNORE INTO features
      (id,thread_id,source_date,category,content,importance,source,source_thread,mining_job_id,created_at,updated_at)
      VALUES (@id,@threadId,@sourceDate,@category,@content,@importance,'import',@sourceThread,NULL,@createdAt,@updatedAt)`);
    const insertJob = this.db.prepare(`INSERT OR IGNORE INTO mining_jobs
      (id,thread_id,source_date,mode,trigger_type,publish_strategy,status,created_at,finished_at,published_at)
      VALUES (?,?,?,?, 'import','auto','completed',?,?,?)`);

    const migrate = this.db.transaction(() => {
      for (const entry of readJsonl(feelingsFile)) {
        if (entry.type !== "feeling") continue;
        const sourceDate = dateFromFeeling(entry);
        if (!sourceDate) continue;
        const createdAt = entry.createdAt || now;
        const result = insertFeeling.run({
          id: entry.id || id("mem"), threadId: this.threadId, sourceDate,
          eventTime: entry.eventTime || null,
          orderKey: String(entry.seq || createdAt || id("order")).padStart(16, "0"),
          content: entry.content, importance: clampImportance(entry.importance),
          sourceThread: entry.sourceThread || this.threadId, createdAt, updatedAt: entry.updatedAt || createdAt,
        });
        feelingCount += result.changes;
      }
      try {
        for (const file of fs.readdirSync(featuresDir).filter(f => f.endsWith(".jsonl"))) {
          for (const entry of readJsonl(path.join(featuresDir, file))) {
            if (entry.type && entry.type !== "feature") continue;
            const createdAt = entry.createdAt || now;
            const result = insertFeature.run({
              id: entry.id || id("feature"), threadId: this.threadId,
              sourceDate: entry.sourceDate || null, category: entry.category || path.basename(file, ".jsonl") || "misc",
              content: entry.content, importance: clampImportance(entry.importance),
              sourceThread: entry.sourceThread || this.threadId, createdAt, updatedAt: entry.updatedAt || createdAt,
            });
            featureCount += result.changes;
          }
        }
      } catch {}
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        for (const key of Object.keys(state).filter(k => k.startsWith("mined:"))) {
          const sourceDate = key.slice(6);
          const ts = new Date(state[key]).toISOString();
          jobCount += insertJob.run(`import_${this.threadId}_${sourceDate}`, this.threadId, sourceDate, "full", ts, ts, ts).changes;
          if (!this.getDayState(sourceDate)) {
            this.setDayState(sourceDate, { status: "completed", completedAt: ts });
            stateCount++;
          }
        }
      } catch {}
      const archiveDir = path.join(this.memoryDir, "archive");
      for (const { date, file } of listDateFiles(archiveDir)) {
        const rows = readJsonl(file).map(row => ({ timestamp: row.timestamp, sourceDate: date,
          role: row.type, text: row.text, source: "legacy_archive" }));
        messageCount += this.insertMessages(rows, { source: "legacy_archive" });
      }
    });
    migrate();
    return { migrated: true, messageCount, feelingCount, featureCount, jobCount, stateCount };
  }

  listFeelings({ date } = {}) {
    const where = date ? "AND source_date = ?" : "";
    const params = date ? [this.threadId, date] : [this.threadId];
    return this.db.prepare(`SELECT *,
      ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY source_date, COALESCE(event_time,''), order_key, id) seq,
      ROW_NUMBER() OVER (PARTITION BY thread_id, source_date ORDER BY COALESCE(event_time,''), order_key, id) daySeq
      FROM feelings WHERE thread_id = ? ${where}
      ORDER BY source_date, COALESCE(event_time,''), order_key, id`).all(...params);
  }

  listFeatures({ date } = {}) {
    return date
      ? this.db.prepare("SELECT * FROM features WHERE thread_id=? AND source_date=? ORDER BY category,id").all(this.threadId, date)
      : this.db.prepare("SELECT * FROM features WHERE thread_id=? ORDER BY category,id").all(this.threadId);
  }

  exportLegacy() {
    const feelingsDir = path.join(this.memoryDir, "mined", "feelings");
    const featuresDir = path.join(this.memoryDir, "mined", "features");
    fs.mkdirSync(feelingsDir, { recursive: true });
    fs.mkdirSync(featuresDir, { recursive: true });
    const feelings = this.listFeelings().map(row => ({
      id: row.id, seq: row.seq, sourceDate: row.source_date, eventTime: row.event_time,
      content: row.content, type: "feeling", importance: row.importance,
      summaryMode: row.summary_mode, coarseSummary: row.coarse_summary,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
    writeJsonlAtomic(path.join(feelingsDir, "days.jsonl"), feelings);
    const byCategory = new Map();
    for (const row of this.listFeatures()) {
      const category = /^[\w-]+$/.test(row.category || "") ? row.category : "misc";
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push({ id: row.id, sourceDate: row.source_date, category,
        content: row.content, type: "feature", importance: row.importance,
        createdAt: row.created_at, updatedAt: row.updated_at });
    }
    for (const [category, rows] of byCategory) writeJsonlAtomic(path.join(featuresDir, `${category}.jsonl`), rows);
    return { feelingCount: feelings.length, featureCount: [...byCategory.values()].reduce((n, rows) => n + rows.length, 0) };
  }

  hasCompletedFullJob(date) {
    return !!this.db.prepare("SELECT 1 FROM mining_jobs WHERE thread_id=? AND source_date=? AND mode='full' AND status='completed' LIMIT 1")
      .get(this.threadId, date);
  }

  createJob({ sourceDate, mode = "full", triggerType = "cli", publishStrategy = "auto", instruction = null }) {
    const now = new Date().toISOString();
    const job = {
      id: id("job"), threadId: this.threadId, sourceDate, mode, triggerType,
      publishStrategy, status: "queued", instruction, createdAt: now,
    };
    this.db.prepare(`INSERT INTO mining_jobs
      (id,thread_id,source_date,mode,trigger_type,publish_strategy,status,instruction,created_at)
      VALUES (@id,@threadId,@sourceDate,@mode,@triggerType,@publishStrategy,@status,@instruction,@createdAt)`).run(job);
    return job;
  }

  updateJob(jobId, patch) {
    const allowed = {
      status: "status", errorCode: "error_code", errorMessage: "error_message",
      feelingCount: "feeling_count", featureCount: "feature_count",
      startedAt: "started_at", finishedAt: "finished_at", publishedAt: "published_at",
    };
    const entries = Object.entries(patch).filter(([key]) => allowed[key]);
    if (!entries.length) return this.getJob(jobId);
    const sets = entries.map(([key]) => `${allowed[key]}=@${key}`).join(",");
    this.db.prepare(`UPDATE mining_jobs SET ${sets} WHERE id=@jobId`).run({ jobId, ...patch });
    return this.getJob(jobId);
  }

  getJob(jobId) {
    return this.db.prepare("SELECT * FROM mining_jobs WHERE id=?").get(jobId) || null;
  }

  replaceDay(sourceDate, { feelings = [], features = [], source = "remine", miningJobId = null, dayState = null } = {}) {
    return this._writeDay(sourceDate, { feelings, features, source, miningJobId, replace: true, dayState });
  }

  appendTargeted(sourceDate, { feelings = [], features = [], miningJobId = null } = {}) {
    return this._writeDay(sourceDate, { feelings, features, source: "targeted", miningJobId, replace: false });
  }

  _writeDay(sourceDate, { feelings, features, source, miningJobId, replace, dayState = null }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) throw new Error("sourceDate must be YYYY-MM-DD");
    if (!Array.isArray(feelings) || !Array.isArray(features)) throw new Error("feelings and features must be arrays");
    const now = new Date().toISOString();
    const insertFeeling = this.db.prepare(`INSERT INTO feelings
      (id,thread_id,source_date,event_time,order_key,content,importance,source,source_thread,mining_job_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertFeature = this.db.prepare(`INSERT INTO features
      (id,thread_id,source_date,category,content,importance,source,source_thread,mining_job_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const write = this.db.transaction(() => {
      if (replace) {
        this.db.prepare("DELETE FROM feelings WHERE thread_id=? AND source_date=?").run(this.threadId, sourceDate);
        this.db.prepare("DELETE FROM features WHERE thread_id=? AND source_date=?").run(this.threadId, sourceDate);
      }
      let n = this.db.prepare("SELECT COUNT(*) n FROM feelings WHERE thread_id=? AND source_date=?").get(this.threadId, sourceDate).n;
      for (const item of feelings) {
        validateMemoryItem(item, "feeling");
        insertFeeling.run(item.id || id("mem"), this.threadId, sourceDate, item.eventTime || null,
          `${item.eventTime || sourceDate}:${String(n++).padStart(6, "0")}`, item.content.trim(),
          clampImportance(item.importance), source, this.threadId, miningJobId, item.createdAt || now, now);
      }
      for (const item of features) {
        validateMemoryItem(item, "feature");
        insertFeature.run(item.id || id("feature"), this.threadId, sourceDate, item.category || "misc",
          item.content.trim(), clampImportance(item.importance), source, this.threadId, miningJobId, item.createdAt || now, now);
      }
      if (dayState) this.setDayState(sourceDate, dayState);
    });
    write();
    return { feelings: this.listFeelings({ date: sourceDate }), features: this.listFeatures({ date: sourceDate }) };
  }
}

function writeJsonlAtomic(file, rows) {
  const data = rows.map(JSON.stringify).join("\n") + (rows.length ? "\n" : "");
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

function validateMemoryItem(item, type) {
  if (!item || typeof item.content !== "string" || !item.content.trim()) throw new Error(`invalid ${type} candidate`);
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function clampImportance(value) {
  return Math.min(5, Math.max(1, Math.floor(Number(value) || 3)));
}

module.exports = { MemoryStore, dateFromFeeling };
