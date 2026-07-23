const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { parseThreadMessages, beijingDateKey } = require("./thread-ingest");
const { normalizeThreadMessage } = require("../lib/thread-message");

const FIELD_CANDIDATES = {
  time: ["timestamp", "created_at", "createdAt", "date", "time"],
  role: ["role", "type", "sender", "author"],
  content: ["content", "text", "message", "body"],
};

function pickField(row, explicit, candidates) {
  if (explicit) return explicit;
  return candidates.find(key => row && row[key] !== undefined);
}

function normalizeRole(value) {
  const role = String(value || "").toLowerCase();
  if (["user", "human"].includes(role)) return "user";
  if (["assistant", "ai", "bot"].includes(role)) return "assistant";
  return role || "unknown";
}

function textValue(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map(item => typeof item === "string" ? item : item?.text || "").filter(Boolean).join("\n").trim();
  }
  return "";
}

function mapGenericRow(raw, mapping = {}) {
  const timeField = pickField(raw, mapping.time, FIELD_CANDIDATES.time);
  const roleField = pickField(raw, mapping.role, FIELD_CANDIDATES.role);
  const contentField = pickField(raw, mapping.content, FIELD_CANDIDATES.content);
  const timestamp = raw?.[timeField];
  const text = textValue(raw?.[contentField]);
  if (!timestamp || !beijingDateKey(timestamp) || !text) return { message: null, fields: { timeField, roleField, contentField } };
  return {
    message: { timestamp: String(timestamp), type: normalizeRole(raw?.[roleField]), text },
    fields: { timeField, roleField, contentField },
  };
}

function parseJsonRows(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    for (const key of ["messages", "data", "entries", "memories"]) if (Array.isArray(data?.[key])) return data[key];
    return data && typeof data === "object" ? [data] : [];
  } catch {
    return parseThreadMessages(raw);
  }
}

function sqliteTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
}

function readSqlite(filePath, table) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const tables = sqliteTables(db);
    if (!table) {
      if (tables.length !== 1) throw new Error(`SQLite 包含 ${tables.length} 个业务表，请用 --table 指定：${tables.join(", ") || "无"}`);
      table = tables[0];
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !tables.includes(table)) throw new Error(`无效或不存在的表：${table}`);
    return { rows: db.prepare(`SELECT * FROM "${table}"`).all(), table };
  } finally { db.close(); }
}

function readImportSource({ filePath, table, timeField, roleField, contentField }) {
  const ext = path.extname(filePath).toLowerCase();
  const sqlite = [".db", ".sqlite", ".sqlite3"].includes(ext);
  const source = sqlite ? readSqlite(filePath, table) : { rows: parseJsonRows(filePath), table: null };
  const mapping = { time: timeField, role: roleField, content: contentField };
  const records = [];
  const detected = new Set();
  const roles = {};
  let valid = 0, invalid = 0;
  const dates = [];
  for (const raw of source.rows) {
    const hasExplicitMapping = timeField || roleField || contentField;
    const nativeShape = raw?.type === "response_item" || raw?.message?.content !== undefined;
    const native = !hasExplicitMapping && nativeShape ? normalizeThreadMessage(raw) : null;
    const mapped = native ? { message: native, fields: {} } : mapGenericRow(raw, mapping);
    records.push({ raw, message: mapped.message });
    Object.values(mapped.fields).filter(Boolean).forEach(field => detected.add(field));
    if (!mapped.message) { invalid++; continue; }
    valid++;
    roles[mapped.message.type] = (roles[mapped.message.type] || 0) + 1;
    dates.push(beijingDateKey(mapped.message.timestamp));
  }
  dates.sort();
  return {
    records,
    preview: {
      format: sqlite ? "sqlite" : "json",
      table: source.table,
      totalRows: source.rows.length,
      valid,
      invalid,
      roles,
      firstDate: dates[0] || null,
      lastDate: dates.at(-1) || null,
      detectedFields: [...detected],
    },
  };
}

module.exports = { readImportSource, mapGenericRow, normalizeRole };
