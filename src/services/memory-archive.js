const fs = require("fs");
const path = require("path");

/**
 * Layer 1 — 原始存档
 * 每条消息同步写入当日 JSONL 文件，毫秒级完成，绝不丢消息。
 */

/** 从时间戳字符串中解析时区偏移（小时），无显式时区返回 null */
function parseOffset(ts) {
  if (typeof ts !== "string") return null;
  const m = ts.match(/([+-])(\d{2}):(\d{2})$/);
  if (m) return parseInt(m[1] + m[2]);
  if (ts.endsWith("Z")) return 0;
  return null;
}

/** 将时间戳按指定时区转成日期字符串 YYYY-MM-DD，无显式时区时默认 +8（北京时间） */
function dateKeyFromTs(timestamp) {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return null;
  const offset = parseOffset(timestamp);
  const tz = offset !== null ? offset : 8;
  const local = new Date(d.getTime() + tz * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

class MemoryArchive {
  constructor(memoryDir) {
    this.archiveDir = path.join(memoryDir, "archive");
    this.fullDir = path.join(this.archiveDir, "full");
    fs.mkdirSync(this.archiveDir, { recursive: true });
    fs.mkdirSync(this.fullDir, { recursive: true });
  }

  /** 完整存档 — 增量写入全量线程消息（含工具链/思考链），北京时间日期 */
  archiveFull(msg) {
    const dateKey = this._beijingDateKey(msg.timestamp);
    const filePath = path.join(this.fullDir, `${dateKey}.jsonl`);
    try {
      fs.appendFileSync(filePath, JSON.stringify(msg) + "\n", "utf8");
    } catch (err) {
      console.error(`[memory-archive] full write error: ${err.message}`);
    }
  }

  /** 批量全量存档 */
  archiveFullBatch(msgs) {
    const grouped = new Map();
    for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
      if (!msg || !msg.timestamp) continue;
      const dateKey = this._beijingDateKey(msg.timestamp);
      if (!grouped.has(dateKey)) grouped.set(dateKey, []);
      grouped.get(dateKey).push(msg);
    }
    for (const [dateKey, batch] of grouped) {
      const filePath = path.join(this.fullDir, `${dateKey}.jsonl`);
      const lines = batch.map((m) => JSON.stringify(m) + "\n").join("");
      try {
        fs.appendFileSync(filePath, lines, "utf8");
      } catch (err) {
        console.error(`[memory-archive] full batch error: ${err.message}`);
      }
    }
  }

  /** 获取 full/ 中某天最后一条消息的时间戳（增量备份用） */
  getFullLastTimestamp(dateKey) {
    const filePath = path.join(this.fullDir, `${dateKey}.jsonl`);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      if (!lines.length) return null;
      const last = JSON.parse(lines[lines.length - 1]);
      return last.timestamp || null;
    } catch {
      return null;
    }
  }

  _beijingDateKey(timestamp) {
    const key = dateKeyFromTs(timestamp);
    if (!key) {
      console.warn(`[memory-archive] unparseable timestamp "${timestamp}", falling back to today`);
      return this._todayBeijingKey();
    }
    return key;
  }

  _todayBeijingKey() {
    return dateKeyFromTs(new Date().toISOString()) || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /** 写入一条存档记录 */
  archiveMessage(msg) {
    const dateKey = this._dateKey(msg.timestamp);
    const filePath = path.join(this.archiveDir, `${dateKey}.jsonl`);
    const line = JSON.stringify(msg) + "\n";
    try {
      fs.appendFileSync(filePath, line, "utf8");
    } catch (err) {
      console.error(`[memory-archive] write error: ${err.message}`);
    }
  }

  /** 批量写入 */
  archiveMessages(msgs) {
    const grouped = new Map();
    for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
      if (!msg) continue;
      const dateKey = this._dateKey(msg.timestamp);
      if (!grouped.has(dateKey)) grouped.set(dateKey, []);
      grouped.get(dateKey).push(msg);
    }
    for (const [dateKey, batch] of grouped) {
      const filePath = path.join(this.archiveDir, `${dateKey}.jsonl`);
      const lines = batch.map((m) => JSON.stringify(m) + "\n").join("");
      try {
        fs.appendFileSync(filePath, lines, "utf8");
      } catch (err) {
        console.error(`[memory-archive] batch write error: ${err.message}`);
      }
    }
  }

  /** 读取某天的存档 */
  readDay(dateStr) {
    const filePath = path.join(this.archiveDir, `${dateStr}.jsonl`);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** 读取最近 N 条存档（跨文件，从新到旧扫描） */
  readRecent(count = 100) {
    const files = this._listArchiveFiles().sort().reverse();
    const results = [];
    for (const file of files) {
      if (results.length >= count) break;
      const entries = this.readDay(file.replace(".jsonl", ""));
      for (let i = entries.length - 1; i >= 0; i--) {
        if (results.length >= count) break;
        results.unshift(entries[i]);
      }
    }
    return results;
  }

  /** 读取最近 N 小时的存档 */
  readRecentHours(hours = 1) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const files = this._listArchiveFiles().sort().reverse();
    const results = [];
    for (const file of files) {
      const dateStr = file.replace(".jsonl", "");
      if (this._dateToMs(dateStr) < cutoff - 86400000) break;
      const entries = this.readDay(dateStr);
      for (const entry of entries) {
        const ts = new Date(entry.timestamp || entry.createdAt).getTime();
        if (ts >= cutoff) results.push(entry);
      }
    }
    return results;
  }

  _listArchiveFiles() {
    try {
      return fs.readdirSync(this.archiveDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
  }

  _dateKey(timestamp) {
    const key = dateKeyFromTs(timestamp);
    if (!key) {
      console.warn(`[memory-archive] unparseable timestamp "${timestamp}", falling back to today`);
      return this._todayKey();
    }
    return key;
  }

  _todayKey() {
    const bj = new Date(Date.now() + 8 * 3600 * 1000);
    return bj.toISOString().slice(0, 10);
  }

  _dateToMs(dateStr) {
    return new Date(dateStr + "T00:00:00+08:00").getTime();
  }
}

module.exports = { MemoryArchive };
