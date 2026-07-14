/**
 * JSONL 读写 — 收拢分散在 thread-rebuilder.js 和 mcp-server.js 中的重复逻辑。
 */

const fs = require("fs");

/** 逐字符解析 JSONL 文件，返回对象数组。容错：格式损坏的行静默跳过。 */
function parseJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const results = [];
  let pos = 0, len = raw.length;
  while (pos < len) {
    while (pos < len && " \t\n\r".includes(raw[pos])) pos++;
    if (pos >= len) break;
    const start = pos;
    let depth = 0, inString = false, escape = false;
    while (pos < len) {
      const ch = raw[pos];
      if (escape) { escape = false; pos++; continue; }
      if (ch === "\\") { escape = true; pos++; continue; }
      if (ch === '"') { inString = !inString; pos++; continue; }
      if (inString) { pos++; continue; }
      if (ch === "{") { depth++; pos++; continue; }
      if (ch === "}") { depth--; if (depth === 0) { pos++; break; } pos++; continue; }
      pos++;
    }
    try { results.push(JSON.parse(raw.slice(start, pos))); } catch {}
  }
  return results;
}

/** 读取 JSONL 文件的所有条目（简单版：按行 split，适合小文件） */
function readJsonlLines(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** 追加条目到 JSONL 文件 */
function appendJsonlLines(filePath, entries) {
  const lines = entries.map(e => JSON.stringify(e) + "\n").join("");
  try { fs.appendFileSync(filePath, lines, "utf8"); }
  catch (err) { console.error(`[jsonl] append error: ${err.message}`); }
}

/** 读取 JSONL 中 type=feeling 的条目（跳过其他 type） */
function readFeelings(filePath) {
  return readJsonlLines(filePath).filter(r => r.type === "feeling");
}

module.exports = { parseJsonlFile, readJsonlLines, appendJsonlLines, readFeelings };
