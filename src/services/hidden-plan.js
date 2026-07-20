const { normalizeTerm } = require("./feature-phrase-extractor");
const { buildCategoryProfile } = require("./category-profile");

function buildHiddenPlan({ features = [], feelings = [], messages = [], anchors = {}, afterDays = 90 }) {
  const profile = buildCategoryProfile({ features, feelings });
  const eventAnchors = new Set(Object.keys(anchors.eventAnchors || {}));
  const retainAnchors = new Set(Object.keys(anchors.retain || {}));
  const userMessages = (messages || []).filter(row => (row.role || row.type) === "user");
  const referenceDate = userMessages.map(messageDate).filter(Boolean).sort().at(-1) || null;
  const normalizedMessages = userMessages.map(row => ({ date: messageDate(row), text: normalizeTerm(row.text) }));
  const decisions = [];

  for (const feeling of feelings || []) {
    if ((feeling.summary_mode || feeling.summaryMode) !== "coarse") continue;
    const base = { feelingId: feeling.id, sourceDate: feeling.source_date || feeling.sourceDate,
      importance: Number(feeling.importance || 0), content: feeling.coarse_summary || feeling.coarseSummary || feeling.content };
    if (eventAnchors.has(feeling.id) || retainAnchors.has(feeling.id)) {
      decisions.push({ ...base, action: "keep_coarse", reason: "锚点保护" });
      continue;
    }
    const categories = profile.matchesByFeeling.get(feeling.id) || [];
    if (categories.includes("relation")) {
      decisions.push({ ...base, action: "keep_coarse", reason: "主核心 relation 暂不自动 hidden" });
      continue;
    }
    if (profile.secondaryCategory && categories.includes(profile.secondaryCategory)) {
      decisions.push({ ...base, action: "keep_coarse", reason: `当前副核心 ${profile.secondaryCategory} 暂不自动 hidden` });
      continue;
    }
    if (base.importance > 3) {
      decisions.push({ ...base, action: "keep_coarse", reason: "第一版只自动隐藏 importance 1–3" });
      continue;
    }
    const coreTerms = parseTerms(feeling.coarse_terms ?? feeling.coarseTerms);
    if (!coreTerms.length) {
      decisions.push({ ...base, action: "keep_coarse", reason: "没有 compressor 核心词证据" });
      continue;
    }
    const evidence = coreTerms.map(term => {
      const normalized = normalizeTerm(term);
      const dates = normalized.length >= 2
        ? normalizedMessages.filter(row => row.date && row.text.includes(normalized)).map(row => row.date).sort()
        : [];
      const lastMention = dates.at(-1) || null;
      return { term, lastMention, idleDays: referenceDate && lastMention ? daysBetween(lastMention, referenceDate) : null };
    });
    if (!referenceDate || evidence.some(row => row.idleDays == null)) {
      decisions.push({ ...base, coreTerms, evidence, action: "keep_coarse", reason: "核心词缺少可回查的 archive 时间证据" });
      continue;
    }
    const shortestIdle = Math.min(...evidence.map(row => row.idleDays));
    decisions.push({ ...base, coreTerms, evidence,
      action: shortestIdle >= afterDays ? "hide" : "keep_coarse",
      reason: shortestIdle >= afterDays
        ? `全部核心词至少 ${shortestIdle} 天未再出现`
        : `仍有核心词在最近 ${afterDays} 天内出现`,
    });
  }
  return { referenceDate, afterDays, primaryCategory: "relation",
    secondaryCategory: profile.secondaryCategory, decisions };
}

function parseTerms(value) {
  if (Array.isArray(value)) return value.map(String).map(term => term.trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String).map(term => term.trim()).filter(Boolean) : [];
  } catch { return []; }
}

function messageDate(row) {
  return row.source_date || row.sourceDate || String(row.timestamp || "").slice(0, 10) || null;
}

function daysBetween(from, to) {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

module.exports = { buildHiddenPlan, parseTerms, daysBetween };
