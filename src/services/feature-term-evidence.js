const fs = require("fs");
const OpenCC = require("opencc-js");
const { listDateFiles } = require("../lib/archive-paths");

const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });
const toTraditional = OpenCC.Converter({ from: "cn", to: "tw" });

function scanTermEvidence({ terms, feelings, archiveDir }) {
  const messages = readUserArchive(archiveDir);
  return terms.map(term => {
    const variants = termVariants(term.term);
    const messageHits = messages.filter(row => variants.some(value => row.text.includes(value)));
    const feelingHits = feelings.filter(row => variants.some(value => String(row.content || "").includes(value)));
    const dates = [...new Set(messageHits.map(row => row.date))].sort();
    return {
      ...term,
      variants,
      messageCount: messageHits.length,
      activeDays: dates.length,
      firstSeen: dates[0] || null,
      lastSeen: dates.at(-1) || null,
      feelingCount: feelingHits.length,
      feelingIds: feelingHits.map(row => row.id),
      feelingImportances: [...new Set(feelingHits.map(row => row.importance).filter(value => value != null))].sort((a, b) => a - b),
    };
  });
}

function readUserArchive(archiveDir) {
  const rows = [];
  for (const { date, file } of listDateFiles(archiveDir)) {
    let lines;
    try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if ((row.type || row.role) === "user" && row.text) rows.push({ date, text: String(row.text), timestamp: row.timestamp || null });
      } catch {}
    }
  }
  return rows;
}

function termVariants(term) {
  return [...new Set([String(term), toSimplified(String(term)), toTraditional(String(term))])];
}

module.exports = { scanTermEvidence, readUserArchive, termVariants };
