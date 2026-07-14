const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { openDatabase } = require("./database");

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
  }

  close() { this.db.close(); }

  migrateLegacy() {
    const feelingsFile = path.join(this.memoryDir, "mined", "feelings", "days.jsonl");
    const featuresDir = path.join(this.memoryDir, "mined", "features");
    const stateFile = path.join(this.memoryDir, "mined", "state.json");
    const now = new Date().toISOString();
    let feelingCount = 0, featureCount = 0, jobCount = 0;

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
        }
      } catch {}
    });
    migrate();
    return { migrated: true, feelingCount, featureCount, jobCount };
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

  addCandidates(jobId, { feelings = [], features = [] }) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`mining job not found: ${jobId}`);
    const insert = this.db.prepare(`INSERT INTO memory_candidates
      (id,mining_job_id,memory_type,source_date,event_time,category,content,importance,source_message_ids,created_at)
      VALUES (@id,@jobId,@type,@sourceDate,@eventTime,@category,@content,@importance,@sourceMessageIds,@createdAt)`);
    const add = this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_candidates WHERE mining_job_id=?").run(jobId);
      const now = new Date().toISOString();
      for (const item of feelings) insert.run(candidateParams(job, item, "feeling", now));
      for (const item of features) insert.run(candidateParams(job, item, "feature", now));
      this.updateJob(jobId, { status: "review_pending", feelingCount: feelings.length, featureCount: features.length, finishedAt: now });
    });
    add();
    return this.listCandidates(jobId);
  }

  listCandidates(jobId) {
    return this.db.prepare("SELECT * FROM memory_candidates WHERE mining_job_id=? ORDER BY memory_type,event_time,id").all(jobId);
  }

  publishCandidates(jobId) {
    const job = this.getJob(jobId);
    if (!job || job.status !== "review_pending") throw new Error("job is not awaiting review");
    const candidates = this.listCandidates(jobId);
    const now = new Date().toISOString();
    const insertFeeling = this.db.prepare(`INSERT INTO feelings
      (id,thread_id,source_date,event_time,order_key,content,importance,source,source_thread,mining_job_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertFeature = this.db.prepare(`INSERT INTO features
      (id,thread_id,source_date,category,content,importance,source,source_thread,mining_job_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const revise = this.db.prepare(`INSERT INTO memory_revisions
      (id,thread_id,source_date,entity_type,entity_id,action,mining_job_id,old_data,new_data,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const publish = this.db.transaction(() => {
      if (job.publish_strategy === "replace") {
        const oldFeelings = this.db.prepare("SELECT * FROM feelings WHERE thread_id=? AND source_date=? AND source!='manual'").all(this.threadId, job.source_date);
        const oldFeatures = this.db.prepare("SELECT * FROM features WHERE thread_id=? AND source_date=? AND source!='manual'").all(this.threadId, job.source_date);
        revise.run(id("rev"), this.threadId, job.source_date, "day", null, "replace", jobId,
          JSON.stringify({ feelings: oldFeelings, features: oldFeatures }), JSON.stringify(candidates), now);
        this.db.prepare("DELETE FROM feelings WHERE thread_id=? AND source_date=? AND source!='manual'").run(this.threadId, job.source_date);
        this.db.prepare("DELETE FROM features WHERE thread_id=? AND source_date=? AND source!='manual'").run(this.threadId, job.source_date);
      }
      const source = job.mode === "targeted" ? "targeted" : job.mode === "remine" ? "remine" : "auto";
      let n = 0;
      for (const item of candidates) {
        if (item.memory_type === "feeling") {
          insertFeeling.run(id("mem"), this.threadId, item.source_date, item.event_time,
            `${item.event_time || item.source_date}:${String(n++).padStart(6, "0")}`, item.content,
            item.importance, source, this.threadId, jobId, now, now);
        } else {
          insertFeature.run(id("feature"), this.threadId, item.source_date, item.category || "misc",
            item.content, item.importance, source, this.threadId, jobId, now, now);
        }
      }
      this.db.prepare("DELETE FROM memory_candidates WHERE mining_job_id=?").run(jobId);
      this.updateJob(jobId, { status: "completed", publishedAt: now });
    });
    publish();
    return { job: this.getJob(jobId), feelings: this.listFeelings({ date: job.source_date }), features: this.listFeatures({ date: job.source_date }) };
  }

  discardCandidates(jobId) {
    const discard = this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_candidates WHERE mining_job_id=?").run(jobId);
      this.updateJob(jobId, { status: "discarded", finishedAt: new Date().toISOString() });
    });
    discard();
    return this.getJob(jobId);
  }
}

function candidateParams(job, item, type, now) {
  if (!item || typeof item.content !== "string" || !item.content.trim()) throw new Error(`invalid ${type} candidate`);
  return {
    id: id("candidate"), jobId: job.id, type, sourceDate: job.source_date,
    eventTime: item.eventTime || null, category: item.category || null,
    content: item.content.trim(), importance: clampImportance(item.importance),
    sourceMessageIds: item.sourceMessageIds ? JSON.stringify(item.sourceMessageIds) : null, createdAt: now,
  };
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
