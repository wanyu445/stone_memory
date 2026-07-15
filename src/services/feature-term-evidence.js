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

function aggregateFeelingEvidence({ feelings, termEvidence }) {
  const byFeeling = new Map((feelings || []).map(feeling => [feeling.id, {
    feelingId: feeling.id,
    sourceDate: feeling.source_date || feeling.sourceDate || null,
    content: String(feeling.content || ""),
    importance: feeling.importance ?? null,
    summaryMode: feeling.summary_mode || feeling.summaryMode || "daily",
    matchedTerms: new Map(),
  }]));

  for (const term of termEvidence || []) {
    for (const feelingId of term.feelingIds || []) {
      const feeling = byFeeling.get(feelingId);
      if (!feeling) continue;
      const key = term.normalizedTerm || String(term.term || "").toLowerCase();
      if (!feeling.matchedTerms.has(key)) feeling.matchedTerms.set(key, {
        term: term.term,
        normalizedTerm: key,
        categories: [],
        featureIds: [],
        featureImportance: null,
        messageCount: term.messageCount || 0,
        activeDays: term.activeDays || 0,
        firstSeen: term.firstSeen || null,
        lastSeen: term.lastSeen || null,
      });
      const match = feeling.matchedTerms.get(key);
      if (term.category && !match.categories.includes(term.category)) match.categories.push(term.category);
      for (const featureId of term.featureIds || []) {
        if (!match.featureIds.includes(featureId)) match.featureIds.push(featureId);
      }
      if (term.importance != null) match.featureImportance = Math.max(match.featureImportance ?? 0, Number(term.importance));
      match.messageCount = Math.max(match.messageCount, term.messageCount || 0);
      match.activeDays = Math.max(match.activeDays, term.activeDays || 0);
      if (term.firstSeen && (!match.firstSeen || term.firstSeen < match.firstSeen)) match.firstSeen = term.firstSeen;
      if (term.lastSeen && (!match.lastSeen || term.lastSeen > match.lastSeen)) match.lastSeen = term.lastSeen;
    }
  }

  return [...byFeeling.values()]
    .map(feeling => ({
      ...feeling,
      matchedTerms: [...feeling.matchedTerms.values()].sort((a, b) =>
        b.activeDays - a.activeDays || b.messageCount - a.messageCount || a.term.localeCompare(b.term, "zh-CN")),
    }))
    .filter(feeling => feeling.matchedTerms.length > 0)
    .sort((a, b) => (a.sourceDate || "").localeCompare(b.sourceDate || "") || a.feelingId.localeCompare(b.feelingId));
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

module.exports = { scanTermEvidence, aggregateFeelingEvidence, readUserArchive, termVariants };
