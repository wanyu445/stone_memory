const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDateFile } = require("../lib/archive-paths");
const { normalizeThreadMessage } = require("../lib/thread-message");

function parseThreadMessages(raw) {
  const messages = [];
  let pos = 0;
  while (pos < raw.length) {
    while (pos < raw.length && /\s/.test(raw[pos])) pos++;
    if (pos >= raw.length) break;
    const start = pos;
    let depth = 0, inString = false, escape = false;
    while (pos < raw.length) {
      const ch = raw[pos++];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
    }
    try { messages.push(JSON.parse(raw.slice(start, pos))); } catch {}
  }
  return messages;
}

function beijingDateKey(timestamp) {
  const ms = new Date(timestamp || "").getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function isSystemTemplate(text) {
  const markers = [/你上线了/, /无论看到什么英文/, /最后用以下格式结尾/, /\{"action":"silent"/, /Trigger:/, /comes to mind again/];
  return !!text && markers.filter(re => re.test(text)).length >= 2;
}

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fullKey(row) { return hash(JSON.stringify(row)); }
function timeValue(row) { const n = new Date(row.timestamp || "").getTime(); return Number.isFinite(n) ? n : 0; }

function mergeDateFile(rootDir, date, incoming, keyFn, sortByTime = true) {
  const file = ensureDateFile(rootDir, date);
  const rows = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      try { rows.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  const seen = new Set(rows.map(keyFn));
  let added = 0;
  for (const row of incoming) {
    const key = keyFn(row);
    if (seen.has(key)) continue;
    seen.add(key); rows.push(row); added++;
  }
  if (added) {
    if (sortByTime) rows.sort((a, b) => timeValue(a) - timeValue(b));
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, rows.map(JSON.stringify).join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file);
  }
  return added;
}

function detectFormat(messages) {
  return messages.some(msg => msg?.type === "response_item" || msg?.type === "session_meta") ? "codex" : "claude";
}

function ingestMessages(messages, { fullDir = null, memoryStore = null } = {}) {
  return ingestRecords(messages.map(raw => ({ raw, message: normalizeThreadMessage(raw) })), { fullDir, memoryStore, format: detectFormat(messages) });
}

function ingestRecords(records, { fullDir = null, memoryStore = null, format = "generic" } = {}) {
  const archiveByDate = new Map(), fullByDate = new Map();
  let invalid = 0;
  for (const record of records) {
    const raw = record.raw;
    const row = record.message;
    const date = beijingDateKey(row?.timestamp);
    if (!row || !date || !row.text) { invalid++; continue; }
    if (fullDir) {
      if (!fullByDate.has(date)) fullByDate.set(date, []);
      fullByDate.get(date).push(raw);
    }
    if (!row || isSystemTemplate(row.text) || row.text.includes("<!-- stmem-rule:")) continue;
    if (!archiveByDate.has(date)) archiveByDate.set(date, []);
    archiveByDate.get(date).push(row);
  }
  let imported = 0, fullBacked = 0;
  if (memoryStore) {
    const rows = [];
    for (const [date, entries] of archiveByDate) for (const row of entries) rows.push({
      timestamp: row.timestamp, sourceDate: date, role: row.type, text: row.text, source: format,
    });
    imported = memoryStore.insertMessages(rows, { source: format });
  } else {
    throw new Error("memoryStore is required for normalized message ingest");
  }
  if (fullDir) for (const [date, rows] of fullByDate) fullBacked += mergeDateFile(fullDir, date, rows, fullKey, false);
  return { imported, dates: archiveByDate.size, fullBacked, invalid, format };
}

function ingestThreadFile(filePath, options) {
  const messages = parseThreadMessages(fs.readFileSync(filePath, "utf8"));
  return ingestMessages(messages, options);
}

module.exports = { parseThreadMessages, beijingDateKey, isSystemTemplate, ingestMessages, ingestRecords, ingestThreadFile };
