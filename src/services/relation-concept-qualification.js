const { normalizeTerm } = require("./feature-phrase-extractor");

function qualifyRelationConcepts(termTimelines) {
  const candidates = (termTimelines || []).map(toCandidate).filter(row => row.feelingCount > 0);
  for (const candidate of candidates) candidate.signature = strongestSignature(candidate, candidates);
  return candidates.map(candidate => {
    const shapes = fitShapes(candidate);
    const signatureStrength = candidate.signature?.strength || 0;
    let qualification = "rejected";
    if (shapes.continuous && candidate.feelingCount >= 15) qualification = "independent";
    else if ((shapes.episodic || shapes.revival) && signatureStrength >= 0.2) qualification = "signature_only";
    return { ...candidate, shapes, qualification };
  }).sort((a, b) => qualificationRank(a.qualification) - qualificationRank(b.qualification)
    || b.feelingCount - a.feelingCount || a.term.localeCompare(b.term, "zh-CN"));
}

function toCandidate(timeline) {
  const points = (timeline.feelings || []).map(row => ({
    id: row.id,
    date: row.sourceDate || row.source_date,
    importance: Number(row.importance || 0),
  })).filter(row => row.id && row.date);
  const dates = [...new Set(points.map(row => row.date))].sort();
  return {
    term: timeline.term,
    normalizedTerm: timeline.normalizedTerm || normalizeTerm(timeline.term),
    feelingIds: new Set(points.map(row => row.id)),
    dates: new Set(dates),
    feelingCount: points.length,
    feelingDays: dates.length,
    spanDays: dateSpan(dates),
    peakSevenDayCount: peakWindow(points, dates, 7),
    maxGapDays: maxGap(dates),
    highImportanceCount: points.filter(row => row.importance > 3).length,
  };
}

function strongestSignature(target, candidates) {
  let best = null;
  for (const peer of candidates) {
    if (peer === target || containsEither(target.normalizedTerm, peer.normalizedTerm)) continue;
    const sameFeelings = intersectionSize(target.feelingIds, peer.feelingIds);
    const sameDays = intersectionSize(target.dates, peer.dates);
    if (!sameFeelings && sameDays < 2) continue;
    const feelingF1 = harmonic(sameFeelings / target.feelingCount, sameFeelings / peer.feelingCount);
    const dayF1 = harmonic(sameDays / target.feelingDays, sameDays / peer.feelingDays);
    const strength = 0.65 * feelingF1 + 0.35 * dayF1;
    if (!best || strength > best.strength) best = {
      term: peer.term, normalizedTerm: peer.normalizedTerm, sameFeelings, sameDays,
      feelingF1, dayF1, strength,
    };
  }
  return best;
}

function fitShapes(row) {
  const density = row.spanDays ? row.feelingDays / row.spanDays : 0;
  const peakRatio = row.feelingCount ? row.peakSevenDayCount / row.feelingCount : 0;
  const highRatio = row.feelingCount ? row.highImportanceCount / row.feelingCount : 0;
  return {
    continuous: row.feelingCount >= 15 && row.feelingDays >= 10 && row.spanDays >= 14 && density >= 0.22,
    episodic: row.feelingCount >= 5 && peakRatio >= 0.45,
    revival: row.feelingCount >= 8 && row.spanDays >= 30 && row.maxGapDays >= 14 && highRatio >= 0.6,
    density, peakRatio, highRatio,
  };
}

function peakWindow(points, dates, days) {
  let peak = 0;
  for (const date of dates) {
    const start = Date.parse(`${date}T00:00:00Z`);
    const end = start + (days - 1) * 86400000;
    peak = Math.max(peak, points.filter(point => {
      const value = Date.parse(`${point.date}T00:00:00Z`);
      return value >= start && value <= end;
    }).length);
  }
  return peak;
}

function dateSpan(dates) {
  if (!dates.length) return 0;
  return Math.round((Date.parse(`${dates.at(-1)}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / 86400000) + 1;
}

function maxGap(dates) {
  let result = 0;
  for (let index = 1; index < dates.length; index++) {
    result = Math.max(result, (Date.parse(`${dates[index]}T00:00:00Z`) - Date.parse(`${dates[index - 1]}T00:00:00Z`)) / 86400000);
  }
  return result;
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count++;
  return count;
}

function harmonic(left, right) {
  return left && right ? 2 * left * right / (left + right) : 0;
}

function containsEither(left, right) {
  return left.includes(right) || right.includes(left);
}

function qualificationRank(value) {
  return value === "independent" ? 0 : value === "signature_only" ? 1 : 2;
}

module.exports = { qualifyRelationConcepts, fitShapes };
