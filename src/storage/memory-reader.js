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
    const visibility = threadId ? visibleThreadSql("feelings") : "SELECT feelings.* FROM feelings";
    const rows = db.prepare(`SELECT * FROM (${visibility}) visible
      ${forInjection ? "WHERE summary_mode!='hidden'" : ""}
      ORDER BY source_date, COALESCE(event_time,''), order_key, id`).all(...(threadId ? [threadId, threadId] : []));
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
      ? db.prepare(`SELECT * FROM (${visibleThreadSql("features")}) visible ORDER BY category,id`).all(threadId, threadId)
      : db.prepare("SELECT * FROM features ORDER BY category,id").all();
    return rows.map(row => ({ id: row.id, type: "feature", sourceDate: row.source_date,
      category: row.category, content: row.content, importance: row.importance,
      createdAt: row.created_at, updatedAt: row.updated_at }));
  });
}

function visibleThreadSql(table) {
  return `WITH RECURSIVE
    ancestors(id,parent_thread_id) AS (
      SELECT id,parent_thread_id FROM threads WHERE id=?
      UNION ALL
      SELECT t.id,t.parent_thread_id FROM threads t JOIN ancestors a ON t.id=a.parent_thread_id
    ),
    flowing_descendants(id) AS (
      SELECT id FROM threads WHERE id=?
      UNION ALL
      SELECT t.id FROM threads t JOIN flowing_descendants d ON t.parent_thread_id=d.id
      WHERE t.memories_flow_to_parent=1
    ),
    visible_threads(id) AS (
      SELECT id FROM ancestors
      UNION
      SELECT id FROM flowing_descendants
    )
    SELECT ${table}.* FROM ${table} JOIN visible_threads v ON v.id=${table}.thread_id`;
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
