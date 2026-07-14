const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { resolveDatabasePath } = require("./database-location");

function databasePath(memoryDir) { return resolveDatabasePath(memoryDir); }
function hasDatabase(memoryDir) { return fs.existsSync(databasePath(memoryDir)); }

function withReadDatabase(memoryDir, fn) {
  const db = new Database(databasePath(memoryDir), { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
}

function readFeelings(memoryDir, { threadId = null, forInjection = false } = {}) {
  if (!hasDatabase(memoryDir)) return [];
  return withReadDatabase(memoryDir, db => {
    const where = [threadId ? "thread_id=?" : null, forInjection ? "summary_mode!='hidden'" : null].filter(Boolean);
    const rows = db.prepare(`SELECT * FROM feelings ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY source_date, COALESCE(event_time,''), order_key, id`).all(...(threadId ? [threadId] : []));
    return rows.map((row, index) => ({
      id: row.id, seq: index + 1, type: "feeling", sourceDate: row.source_date,
      eventTime: row.event_time, content: forInjection ? injectionContent(row) : row.content,
      fullContent: row.content, summaryMode: row.summary_mode, coarseSummary: row.coarse_summary,
      importance: row.importance, createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  });
}

function readFeatures(memoryDir, { threadId = null } = {}) {
  if (!hasDatabase(memoryDir)) return [];
  return withReadDatabase(memoryDir, db => {
    const rows = threadId
      ? db.prepare("SELECT * FROM features WHERE thread_id=? ORDER BY category,id").all(threadId)
      : db.prepare("SELECT * FROM features ORDER BY category,id").all();
    return rows.map(row => ({ id: row.id, type: "feature", sourceDate: row.source_date,
      category: row.category, content: row.content, importance: row.importance,
      createdAt: row.created_at, updatedAt: row.updated_at }));
  });
}

function readMessages(memoryDir, { threadId, date = null, from = null, to = null } = {}) {
  if (!hasDatabase(memoryDir) || !threadId) return [];
  return withReadDatabase(memoryDir, db => {
    const clauses = ["thread_id=?"], params = [threadId];
    if (date) { clauses.push("source_date=?"); params.push(date); }
    if (from) { clauses.push("timestamp>=?"); params.push(from); }
    if (to) { clauses.push("timestamp<?"); params.push(to); }
    return db.prepare(`SELECT timestamp,source_date AS sourceDate,role AS type,text,source
      FROM messages WHERE ${clauses.join(" AND ")} ORDER BY timestamp`).all(...params);
  });
}

function injectionContent(row) {
  if (row.summary_mode !== "coarse" || !row.coarse_summary) return row.content;
  const [, , month, day] = row.source_date.match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  return month ? `${Number(month)}月${Number(day)}日，${row.coarse_summary}` : row.coarse_summary;
}

module.exports = { hasDatabase, readFeelings, readFeatures, readMessages };
