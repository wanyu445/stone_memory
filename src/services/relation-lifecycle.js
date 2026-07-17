const DAY_MS = 86400000;
const { qualifyRelationConcepts } = require("./relation-concept-qualification");

function buildRelationLifecycles({ termTimelines = [], intersections = [] }) {
  const feelingReferenceDate = termTimelines.flatMap(row => feelingDates(row)).sort().at(-1) || null;
  const qualifications = qualifyRelationConcepts(termTimelines);
  const qualificationByTerm = new Map(qualifications.map(row => [row.normalizedTerm, row]));
  const relationTerms = new Set(qualifications
    .filter(row => row.qualification !== "rejected")
    .map(row => row.normalizedTerm));

  // Recover a missing half of a paired role only when most occurrences of the
  // rarer term co-occur with an existing relation term. Ordinary topic overlap
  // such as 老公+论文 is intentionally too weak for this inference.
  let changed = true;
  while (changed) {
    changed = false;
    for (const signature of intersections.filter(row => row.terms.length === 2)) {
      const rows = signature.normalizedTerms.map(term => termTimelines.find(row => row.normalizedTerm === term));
      if (rows.some(row => !row)) continue;
      const hasRelation = signature.normalizedTerms.some(term => relationTerms.has(term));
      const affinity = signature.sameFeelings.length / Math.max(1, Math.min(...rows.map(row => row.feelings.length)));
      if (!hasRelation || signature.sameFeelings.length < 2 || affinity < 0.5) continue;
      for (const term of signature.normalizedTerms) {
        if (!relationTerms.has(term)) { relationTerms.add(term); changed = true; }
      }
    }
  }

  const terms = termTimelines.filter(row => relationTerms.has(row.normalizedTerm)).map(row => {
    const lifecycle = classifyRelationTimeline(row, feelingReferenceDate);
    const qualification = qualificationByTerm.get(row.normalizedTerm);
    if (lifecycle.state === "experimental" && qualification?.shapes.episodic) {
      lifecycle.state = "established";
      lifecycle.shape = "episodic";
      lifecycle.reasons = [`摘要点形成稳定共同签名 episode（${qualification.signature?.term || "无配对名"}）`];
    } else if (lifecycle.state === "experimental" && qualification?.shapes.revival) {
      lifecycle.state = "revived";
      lifecycle.shape = "revived_after_gap";
      lifecycle.reasons = ["高 importance 摘要在长间隔后复活"];
    }
    return {
    ...lifecycle,
    term: row.term,
    normalizedTerm: row.normalizedTerm,
    inferredRelation: !row.categories.includes("relation"),
    qualification: qualification?.qualification || "rejected",
    signature: qualification?.signature || null,
    feelingPoints: row.feelings.map(feeling => ({
      feelingId: feeling.id,
      sourceDate: feeling.sourceDate,
      importance: feeling.importance,
      position: classifyRelationPoint(row, lifecycle, feeling.sourceDate),
    })),
  }; });
  const byTerm = new Map(terms.map(row => [row.normalizedTerm, row]));
  const timelineByTerm = new Map(termTimelines.map(row => [row.normalizedTerm, row]));
  const pairs = intersections.filter(row => {
    if (row.terms.length !== 2 || !row.normalizedTerms.every(term => byTerm.has(term))) return false;
    const children = row.normalizedTerms.map(term => termTimelines.find(item => item.normalizedTerm === term));
    const affinity = row.sameFeelings.length / Math.max(1, Math.min(...children.map(child => child.feelings.length)));
    return row.sameFeelings.length >= 2 && affinity >= 0.5;
  })
    .map(signature => classifyRelationPair(signature, byTerm));
  for (const pair of pairs.filter(row => row.state === "established" && row.shape === "episodic_pair")) {
    for (const term of pair.normalizedTerms) {
      const child = byTerm.get(term);
      child.shape = "episodic";
      child.reasons.push(`与“${pair.terms.find(label => label !== child.term)}”成对跨 session 复现`);
      const timeline = timelineByTerm.get(term);
      child.feelingPoints = timeline.feelings.map(feeling => ({
        feelingId: feeling.id,
        sourceDate: feeling.sourceDate,
        importance: feeling.importance,
        position: classifyRelationPoint(timeline, child, feeling.sourceDate),
      }));
    }
  }
  return { terms, pairs, qualifications };
}

function classifyRelationPoint(row, lifecycle, date) {
  if (!date) return "unknown";
  const activeDates = feelingDates(row);
  const index = activeDates.indexOf(date);
  if (index < 0) return "feeling_only";
  const previousGap = index > 0 ? daysBetween(activeDates[index - 1], date) : 0;
  if (previousGap >= 14) {
    const episodeSupport = activeDates.filter(activeDate => {
      const offset = daysBetween(date, activeDate);
      return offset >= 0 && offset <= 3;
    }).length;
    if (lifecycle.shape === "post_plateau" && episodeSupport < 2) return "post_plateau_callback";
    return "revival";
  }
  if (lifecycle.state === "established" && lifecycle.shape === "continuous" && lifecycle.metrics.stableOnsetDate) {
    if (date < lifecycle.metrics.stableOnsetDate) return "rare_early";
    if (daysBetween(lifecycle.metrics.stableOnsetDate, date) <= 6) return "formation";
    return "stable_repeat";
  }
  const daysFromFirst = daysBetween(activeDates[0], date);
  if (index === 0 || daysFromFirst <= 3) return "formation";
  if (lifecycle.state === "retired") return "retired_history";
  if (lifecycle.shape === "episodic") return "episodic_recurrence";
  if (lifecycle.state === "established" && ["continuous", "post_plateau"].includes(lifecycle.shape)) return "stable_repeat";
  if (lifecycle.state === "forming") return "formation";
  return "experiment";
}

function classifyRelationTimeline(row, referenceDateOverride = null) {
  const activeDates = feelingDates(row);
  const referenceDate = referenceDateOverride || row.to || activeDates.at(-1) || null;
  const firstSeen = activeDates[0] || null;
  const lastSeen = activeDates.at(-1) || null;
  const spanDays = firstSeen && lastSeen ? daysBetween(firstSeen, lastSeen) + 1 : 0;
  const ageDays = firstSeen && referenceDate ? daysBetween(firstSeen, referenceDate) + 1 : 0;
  const daysSinceLast = lastSeen && referenceDate ? daysBetween(lastSeen, referenceDate) : null;
  const recent7ActiveDays = countSince(activeDates, referenceDate, 7);
  const recent14ActiveDays = countSince(activeDates, referenceDate, 14);
  const episodes = splitEpisodes(activeDates, 3);
  const revivalGapDays = largestGapBeforeLastEpisode(episodes);
  const latestEpisodeStart = episodes.at(-1)?.[0] || null;
  const revivalAgeDays = latestEpisodeStart && referenceDate ? daysBetween(latestEpisodeStart, referenceDate) : null;
  const activeRatioSinceFirst = ageDays ? activeDates.length / ageDays : 0;
  const stableOnsetDate = detectStableOnset(feelingTimeline(row));

  let state = "experimental";
  let shape = "short_experiment";
  const reasons = [];
  if (!activeDates.length) {
    state = "experimental";
    shape = "no_feeling_evidence";
    reasons.push("feelings 中没有摘要点");
  } else if (daysSinceLast > 14) {
    state = "retired";
    shape = stableOnsetDate ? "retired_after_continuous" : episodes.length > 1 ? "retired_with_callbacks" : "retired_burst";
    reasons.push(`已沉寂 ${daysSinceLast} 天`);
  } else if (recent14ActiveDays >= 7 || (activeDates.length >= 7 && activeRatioSinceFirst >= 0.6 && recent7ActiveDays >= 3)) {
    state = "established";
    shape = "continuous";
    reasons.push(`近 14 天活跃 ${recent14ActiveDays} 天`);
  } else if (stableOnsetDate) {
    state = "established";
    shape = "post_plateau";
    reasons.push(`历史平台形成于 ${stableOnsetDate}，当前降为零星激活`);
  } else if (spanDays >= 14 && activeDates.length >= 5 && daysSinceLast <= 7) {
    state = "established";
    shape = "episodic";
    reasons.push(`跨 ${spanDays} 天在 ${activeDates.length} 天复现`);
  } else if (revivalGapDays >= 14 && revivalAgeDays < 14 && daysSinceLast <= 7) {
    state = "revived";
    shape = "revived_after_gap";
    reasons.push(`长间隔 ${revivalGapDays} 天后重新出现`);
  } else if (ageDays <= 14 && activeDates.length >= 4) {
    state = "forming";
    shape = "forming_burst";
    reasons.push(`最近 ${ageDays} 天内持续形成`);
  } else {
    reasons.push(`仅在 ${activeDates.length} 个活跃日出现`);
  }

  return {
    state,
    shape,
    confidence: confidenceFor({ state, activeDays: activeDates.length, recent14ActiveDays, daysSinceLast }),
    metrics: { referenceDate, firstSeen, lastSeen, spanDays, ageDays, daysSinceLast, activeDays: activeDates.length,
      recent7ActiveDays, recent14ActiveDays, episodeCount: episodes.length, activeRatioSinceFirst,
      revivalGapDays, latestEpisodeStart, revivalAgeDays, stableOnsetDate },
    reasons,
  };
}

function classifyRelationPair(signature, byTerm) {
  const children = signature.normalizedTerms.map(term => byTerm.get(term));
  const dates = [...new Set(signature.sameFeelings.map(row => row.sourceDate).filter(Boolean))].sort();
  const referenceDate = children.map(row => row.metrics.referenceDate).filter(Boolean).sort().at(-1) || null;
  const lastSeen = dates.at(-1) || null;
  const spanDays = dates.length ? daysBetween(dates[0], dates.at(-1)) + 1 : 0;
  const daysSinceLast = lastSeen && referenceDate ? daysBetween(lastSeen, referenceDate) : null;
  let state = "experimental";
  let shape = "paired_experiment";
  if (daysSinceLast > 14) { state = "retired"; shape = "retired_pair"; }
  else if (signature.sameFeelings.length >= 5 && dates.length >= 3) { state = "established"; shape = "episodic_pair"; }
  return {
    terms: signature.terms,
    normalizedTerms: signature.normalizedTerms,
    state,
    shape,
    evidence: { sameDays: dates.length, sameMessages: signature.sameMessages.length,
      sameFeelings: signature.sameFeelings.length, firstSeen: dates[0] || null, lastSeen, spanDays },
  };
}

function splitEpisodes(dates, maxGapDays) {
  const episodes = [];
  for (const date of dates) {
    const current = episodes.at(-1);
    if (!current || daysBetween(current.at(-1), date) > maxGapDays) episodes.push([date]);
    else current.push(date);
  }
  return episodes;
}

function detectStableOnset(timeline) {
  const active = (timeline || []).filter(point => point.occurrenceCount > 0).map(point => point.date);
  for (const candidate of active) {
    const firstWindow = active.filter(date => {
      const offset = daysBetween(candidate, date);
      return offset >= 0 && offset < 14;
    }).length;
    const secondWindow = active.filter(date => {
      const offset = daysBetween(candidate, date);
      return offset >= 14 && offset < 28;
    }).length;
    if (firstWindow >= 7 && secondWindow >= 4) return candidate;
  }
  return null;
}

function feelingDates(row) {
  return [...new Set((row.feelings || []).map(feeling => feeling.sourceDate || feeling.source_date).filter(Boolean))].sort();
}

function feelingTimeline(row) {
  const counts = new Map();
  for (const feeling of row.feelings || []) {
    const date = feeling.sourceDate || feeling.source_date;
    if (date) counts.set(date, (counts.get(date) || 0) + 1);
  }
  return [...counts].map(([date, occurrenceCount]) => ({ date, occurrenceCount }));
}

function largestGapBeforeLastEpisode(episodes) {
  if (episodes.length < 2) return 0;
  return daysBetween(episodes.at(-2).at(-1), episodes.at(-1)[0]);
}

function countSince(dates, referenceDate, windowDays) {
  if (!referenceDate) return 0;
  return dates.filter(date => {
    const age = daysBetween(date, referenceDate);
    return age >= 0 && age < windowDays;
  }).length;
}

function confidenceFor({ state, activeDays, recent14ActiveDays, daysSinceLast }) {
  if (state === "established" && (activeDays >= 10 || recent14ActiveDays >= 7)) return "high";
  if (state === "retired" && activeDays >= 4 && daysSinceLast > 21) return "high";
  if (activeDays >= 4) return "medium";
  return "low";
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY_MS);
}

module.exports = { buildRelationLifecycles, classifyRelationTimeline, classifyRelationPoint, detectStableOnset, splitEpisodes, feelingTimeline };
