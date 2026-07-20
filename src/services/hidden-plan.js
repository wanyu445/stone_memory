const { extractFeatureTerms, normalizeTerm } = require("./feature-phrase-extractor");
const { buildCategoryProfile } = require("./category-profile");
const { buildTermTimeline } = require("./term-timeline");
const { buildRelationLifecycles } = require("./relation-lifecycle");
const { buildRelationCompressionPlan } = require("./relation-compression-plan");
const { buildFeelingIntersections } = require("./compression-planner");

function buildHiddenPlan({ features = [], feelings = [], messages = [], anchors = {}, afterDays = 90 }) {
  const profile = buildCategoryProfile({ features, feelings });
  const eventAnchors = new Set(Object.keys(anchors.eventAnchors || {}));
  const retainAnchors = new Set(Object.keys(anchors.retain || {}));
  const userMessages = (messages || []).filter(row => (row.role || row.type) === "user");
  const referenceDate = userMessages.map(messageDate).filter(Boolean).sort().at(-1) || null;
  const normalizedMessages = userMessages.map(row => ({ date: messageDate(row), text: normalizeTerm(row.text) }));
  const relationTakeover = buildRelationTakeover({ features, feelings, messages: userMessages, anchors });
  const secondaryDisplacement = buildSecondaryDisplacement({ feelings, profile, normalizedMessages });
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
    const relationDecision = relationTakeover.get(feeling.id);
    if (base.importance > 3 && relationDecision?.takeover) {
      decisions.push({ ...base, action: "keep_coarse", reason: `relation 仍接管：${relationDecision.reason}` });
      continue;
    }
    if (profile.secondaryCategory && categories.includes(profile.secondaryCategory)) {
      const displaced = secondaryDisplacement.get(feeling.id);
      decisions.push({ ...base, coreTerms: parseTerms(feeling.coarse_terms ?? feeling.coarseTerms),
        action: displaced ? "hide" : "keep_coarse",
        reason: displaced?.reason || `当前副核心 ${profile.secondaryCategory} 尚未被新高信息主线替代` });
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

function buildRelationTakeover({ features, feelings, messages, anchors }) {
  const extractedTerms = extractFeatureTerms(features).filter(row => row.category === "relation");
  const coarseContents = (feelings || []).filter(row => (row.summary_mode || row.summaryMode) === "coarse")
    .map(row => normalizeTerm(row.content));
  const requestedTerms = [];
  const seen = new Set();
  for (const term of extractedTerms) {
    if (seen.has(term.normalizedTerm) || !coarseContents.some(content => content.includes(term.normalizedTerm))) continue;
    seen.add(term.normalizedTerm);
    requestedTerms.push(term.term);
  }
  if (!requestedTerms.length) return new Map();
  const timelineMessages = (messages || []).map(row => ({ date: messageDate(row), text: row.text }));
  const termTimelines = buildTermTimeline({ requestedTerms, extractedTerms, feelings,
    messages: timelineMessages, anchors });
  const intersections = buildFeelingIntersections(termTimelines);
  const relation = buildRelationLifecycles({ termTimelines, intersections });
  return new Map(buildRelationCompressionPlan({ relation, termTimelines, anchors })
    .map(row => [row.feelingId, row]));
}

function buildSecondaryDisplacement({ feelings, profile, normalizedMessages }) {
  const result = new Map();
  const category = profile.secondaryCategory;
  if (!category) return result;
  const rows = (feelings || []).filter(row => (row.summary_mode || row.summaryMode) === "coarse"
    && profile.matchesByFeeling.get(row.id)?.includes(category))
    .map(row => ({ row, date: row.source_date || row.sourceDate,
      terms: parseTerms(row.coarse_terms ?? row.coarseTerms) }))
    .filter(item => item.date && item.terms.length)
    .sort((left, right) => left.date.localeCompare(right.date) || left.row.id.localeCompare(right.row.id));
  const stats = new Map();
  for (const item of rows) for (const term of item.terms) {
    if (!stats.has(term)) stats.set(term, { term, rows: [], dates: new Set(), firstSeen: item.date });
    const stat = stats.get(term);
    stat.rows.push(item);
    stat.dates.add(item.date);
    if (item.date < stat.firstSeen) stat.firstSeen = item.date;
  }
  // 新主线必须由同一个具体核心词支撑至少 3 条、跨至少 2 天；取最近一次站稳的新主线。
  const established = [...stats.values()].filter(stat => stat.rows.length >= 3 && stat.dates.size >= 2)
    .sort((left, right) => right.firstSeen.localeCompare(left.firstSeen) || right.rows.length - left.rows.length);
  const newest = established[0];
  if (!newest) return result;
  const boundary = newest.firstSeen;
  const hasOlderLine = rows.some(item => item.date < boundary && !item.terms.includes(newest.term));
  const newArchiveDays = activeMessageDays(normalizedMessages, [newest.term], boundary);
  if (!hasOlderLine || newArchiveDays.size < 2) return result;

  for (const item of rows) {
    if (item.date >= boundary || item.terms.includes(newest.term)) continue;
    // 旧摘要任一核心词仍在新主线形成后跨多日出现，就说明旧主线没有真正让位。
    const oldDays = activeMessageDays(normalizedMessages, item.terms, boundary);
    if (oldDays.size > 1) continue;
    // 新边形成后还有 coarse 明确沿用旧词，也不隐藏旧线。
    const laterCoarseUsesOldTerm = rows.some(later => later.date >= boundary
      && later.terms.some(term => item.terms.includes(term)));
    if (laterCoarseUsesOldTerm) continue;
    result.set(item.row.id, { reason: `${category} 新主线“${newest.term}”已站稳，旧核心词在此后几乎消失` });
  }
  return result;
}

function activeMessageDays(messages, terms, from) {
  const normalizedTerms = terms.map(normalizeTerm).filter(term => term.length >= 2);
  return new Set((messages || []).filter(row => row.date >= from
    && normalizedTerms.some(term => row.text.includes(term))).map(row => row.date));
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

module.exports = { buildHiddenPlan, buildRelationTakeover, buildSecondaryDisplacement,
  parseTerms, daysBetween, activeMessageDays };
