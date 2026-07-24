const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDateFile, resolveDateFile, listDateFiles, migrateFlatFiles } = require("../lib/archive-paths");
const { MemoryStore } = require("../storage/memory-store");

function dateKeyFromTs(timestamp) {
  const ms = new Date(timestamp || "").getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function rawRecordKey(row) {
  return crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

/** 规范化对话仓库：唯一实现为 SQLite messages。 */
class MemoryArchive {
  constructor(memoryDir, { threadId } = {}) {
    if (!threadId) throw new Error("MemoryArchive requires threadId");
    this.memoryDir = memoryDir;
    this.threadId = threadId;
    this.store = new MemoryStore({ memoryDir, threadId });
  }

  close() { this.store.close(); }

  archiveMessage(message, { source = "archive" } = {}) {
    const sourceDate = dateKeyFromTs(message?.timestamp);
    if (!sourceDate || !message?.text) return 0;
    return this.store.insertMessages([{
      timestamp: message.timestamp, sourceDate, role: message.type || message.role || "unknown",
      text: message.text, source,
    }], { source });
  }

  archiveMessages(messages, options = {}) {
    const rows = (Array.isArray(messages) ? messages : [messages]).flatMap(message => {
      const sourceDate = dateKeyFromTs(message?.timestamp);
      if (!sourceDate || !message?.text) return [];
      return [{ timestamp: message.timestamp, sourceDate, role: message.type || message.role || "unknown", text: message.text, source: options.source || "archive" }];
    });
    return this.store.insertMessages(rows, { source: options.source || "archive" });
  }

  readDay(date) { return this.store.listMessages({ date }); }

  readRecent(count = 100) {
    return this.store.db.prepare(`SELECT timestamp,source_date AS sourceDate,role AS type,text,source
      FROM messages WHERE thread_id=? ORDER BY timestamp DESC,message_seq DESC LIMIT ?`).all(this.threadId, count).reverse();
  }

  readRecentHours(hours = 1) {
    const from = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    return this.store.listMessages({ from });
  }
}

/** 未经规范化的原始记录备份：继续使用递归 JSONL。 */
class FullArchive {
  constructor(memoryDir) {
    this.fullDir = path.join(memoryDir, "archive", "full");
    fs.mkdirSync(this.fullDir, { recursive: true });
    migrateFlatFiles(this.fullDir);
  }

  archiveFull(message) { return this.archiveFullBatch([message]); }

  /** full/ 中全部按日原始 JSONL 的物理字节数。 */
  getTotalBytes() {
    return listDateFiles(this.fullDir).reduce((total, { file }) => {
      try { return total + fs.statSync(file).size; } catch { return total; }
    }, 0);
  }

  archiveFullBatch(messages) {
    const grouped = new Map();
    for (const message of Array.isArray(messages) ? messages : [messages]) {
      const date = dateKeyFromTs(message?.timestamp);
      if (!date) continue;
      if (!grouped.has(date)) grouped.set(date, []);
      grouped.get(date).push(message);
    }
    let written = 0;
    for (const [date, rows] of grouped) {
      const file = ensureDateFile(this.fullDir, date);
      fs.appendFileSync(file, rows.map(JSON.stringify).join("\n") + "\n", "utf8");
      written += rows.length;
    }
    return written;
  }

  /** watcher 实时补写、rebuild 前兜底；逐条去重，不用最大时间戳猜测是否已保存。 */
  archiveNewFullBatch(messages) {
    const grouped = new Map();
    for (const message of Array.isArray(messages) ? messages : [messages]) {
      const date = dateKeyFromTs(message?.timestamp);
      if (!date) continue;
      if (!grouped.has(date)) grouped.set(date, []);
      grouped.get(date).push(message);
    }
    let written = 0;
    for (const [date, rows] of grouped) {
      const existing = new Set();
      try {
        for (const line of fs.readFileSync(resolveDateFile(this.fullDir, date), "utf8").split("\n").filter(Boolean)) {
          try { existing.add(rawRecordKey(JSON.parse(line))); } catch {}
        }
      } catch {}
      const pending = [];
      for (const row of rows) {
        const key = rawRecordKey(row);
        if (existing.has(key)) continue;
        existing.add(key);
        pending.push(row);
      }
      if (pending.length) written += this.archiveFullBatch(pending);
    }
    return written;
  }

  getFullLastTimestamp(date) {
    try {
      const lines = fs.readFileSync(resolveDateFile(this.fullDir, date), "utf8").split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const row = JSON.parse(lines[i]); if (row.timestamp) return row.timestamp; } catch {}
      }
    } catch {}
    return null;
  }
}

module.exports = { MemoryArchive, FullArchive, dateKeyFromTs, rawRecordKey };
