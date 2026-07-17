const DAY_MS = 86400000;

function buildRelationLifecycles({ termTimelines = [], intersections = [] }) {
  const relationTerms = new Set(termTimelines
    .filter(row => row.categories.includes("relation"))
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
      const affinity = signature.sameMessages.length / Math.max(1, Math.min(...rows.map(row => row.messageCount)));
      if (!hasRelation || signature.sameMessages.length < 2 || affinity < 0.5) continue;
      for (const term of signature.normalizedTerms) {
        if (!relationTerms.has(term)) { relationTerms.add(term); changed = true; }
      }
    }
  }

  const terms = termTimelines.filter(row => relationTerms.has(row.normalizedTerm)).map(row => ({
    ...classifyRelationTimeline(row),
    term: row.term,
    normalizedTerm: row.normalizedTerm,
    inferredRelation: !row.categories.includes("relation"),
  }));
  const byTerm = new Map(terms.map(row => [row.normalizedTerm, row]));
  const pairs = intersections.filter(row => {
    if (row.terms.length !== 2 || !row.normalizedTerms.every(term => byTerm.has(term))) return false;
    const children = row.normalizedTerms.map(term => termTimelines.find(item => item.normalizedTerm === term));
    const affinity = row.sameMessages.length / Math.max(1, Math.min(...children.map(child => child.messageCount)));
    return row.sameMessages.length >= 2 && affinity >= 0.5;
  })
    .map(signature => classifyRelationPair(signature, byTerm));
  for (const pair of pairs.filter(row => row.state === "established" && row.shape === "episodic_pair")) {
    for (const term of pair.normalizedTerms) {
      const child = byTerm.get(term);
      child.shape = "episodic";
      child.reasons.push(`与“${pair.terms.find(label => label !== child.term)}”成对跨 session 复现`);
    }
  }
  return { terms, pairs };
}

function classifyRelationTimeline(row) {
  const activeDates = row.timeline.filter(point => point.occurrenceCount > 0).map(point => point.date);
  const referenceDate = row.to || activeDates.at(-1) || null;
  const firstSeen = activeDates[0] || null;
  const lastSeen = activeDates.at(-1) || null;
  const spanDays = firstSeen && lastSeen ? daysBetween(firstSeen, lastSeen) + 1 : 0;
  const ageDays = firstSeen && referenceDate ? daysBetween(firstSeen, referenceDate) + 1 : 0;
  const daysSinceLast = lastSeen && referenceDate ? daysBetween(lastSeen, referenceDate) : null;
  const recent7ActiveDays = countSince(activeDates, referenceDate, 7);
  const recent14ActiveDays = countSince(activeDates, referenceDate, 14);
  const episodes = splitEpisodes(activeDates, 3);
  const revivalGapDays = largestGapBeforeLastEpisode(episodes);
  const activeRatioSinceFirst = ageDays ? activeDates.length / ageDays : 0;

  let state = "experimental";
  let shape = "short_experiment";
  const reasons = [];
  if (!activeDates.length) {
    state = "experimental";
    shape = "no_archive_evidence";
    reasons.push("archive 中没有实际出现");
  } else if (daysSinceLast > 14) {
    state = "retired";
    shape = episodes.length > 1 ? "retired_with_callbacks" : "retired_burst";
    reasons.push(`已沉寂 ${daysSinceLast} 天`);
  } else if (revivalGapDays >= 14 && daysSinceLast <= 7) {
    state = "revived";
    shape = "revived_after_gap";
    reasons.push(`长间隔 ${revivalGapDays} 天后重新出现`);
  } else if (recent14ActiveDays >= 7 || (activeDates.length >= 7 && activeRatioSinceFirst >= 0.5)) {
    state = "established";
    shape = "continuous";
    reasons.push(`近 14 天活跃 ${recent14ActiveDays} 天`);
  } else if (spanDays >= 14 && activeDates.length >= 5 && daysSinceLast <= 7) {
    state = "established";
    shape = "episodic";
    reasons.push(`跨 ${spanDays} 天在 ${activeDates.length} 天复现`);
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
      recent7ActiveDays, recent14ActiveDays, episodeCount: episodes.length, activeRatioSinceFirst, revivalGapDays },
    reasons,
  };
}

function classifyRelationPair(signature, byTerm) {
  const children = signature.normalizedTerms.map(term => byTerm.get(term));
  const dates = signature.sameDays.map(row => row.date).sort();
  const referenceDate = children.map(row => row.metrics.referenceDate).filter(Boolean).sort().at(-1) || null;
  const lastSeen = dates.at(-1) || null;
  const spanDays = dates.length ? daysBetween(dates[0], dates.at(-1)) + 1 : 0;
  const daysSinceLast = lastSeen && referenceDate ? daysBetween(lastSeen, referenceDate) : null;
  let state = "experimental";
  let shape = "paired_experiment";
  if (daysSinceLast > 14) { state = "retired"; shape = "retired_pair"; }
  else if (dates.length >= 5 && spanDays >= 10) { state = "established"; shape = "episodic_pair"; }
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

module.exports = { buildRelationLifecycles, classifyRelationTimeline, splitEpisodes };
