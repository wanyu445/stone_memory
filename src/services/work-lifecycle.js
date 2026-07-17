const { splitEpisodes } = require("./relation-lifecycle");

function buildWorkLifecycles({ termTimelines = [], intersections = [] }) {
  const feelingReferenceDate = termTimelines.flatMap(row => feelingDates(row)).sort().at(-1) || null;
  const workTerms = new Set(termTimelines
    .filter(row => row.categories.includes("work") && feelingDates(row).length)
    .map(row => row.normalizedTerm));
  const rows = termTimelines.filter(row => workTerms.has(row.normalizedTerm));
  const links = strongLinks(rows);
  const groups = signatureGroups(rows, links).map((signature, index) => buildProject(`work_signature_${index + 1}`, signature, links, feelingReferenceDate));
  return { terms: rows.map(row => classifyWorkTerm(row, feelingReferenceDate)), groups, links };
}

function strongLinks(rows) {
  const pairs = new Map();
  const allDates = new Set(rows.flatMap(row => (row.feelings || []).map(feeling => feeling.sourceDate).filter(Boolean)));
  const support = new Map(rows.map(row => [row.normalizedTerm,
    new Set((row.feelings || []).map(feeling => feeling.sourceDate).filter(Boolean)).size]));
  const addGroup = (members, feelingId, sourceDate) => {
    const unique = [...new Map(members.map(row => [row.normalizedTerm, row])).values()];
    for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) {
      const ordered = [unique[i], unique[j]].sort((a, b) => a.normalizedTerm.localeCompare(b.normalizedTerm));
      const key = ordered.map(row => row.normalizedTerm).join("\0");
      if (!pairs.has(key)) pairs.set(key, { terms: ordered.map(row => row.normalizedTerm), labels: ordered.map(row => row.term), feelingIds: new Set(), activeDates: new Set() });
      const link = pairs.get(key);
      link.feelingIds.add(feelingId);
      if (sourceDate) link.activeDates.add(sourceDate);
    }
  };
  const byFeeling = new Map();
  for (const row of rows) {
    for (const feeling of row.feelings || []) {
      if (!byFeeling.has(feeling.id)) byFeeling.set(feeling.id, []);
      byFeeling.get(feeling.id).push(row);
    }
  }
  const feelingDatesById = new Map(rows.flatMap(row => (row.feelings || []).map(feeling => [feeling.id, feeling.sourceDate])));
  for (const [feelingId, members] of byFeeling) addGroup(members, feelingId, feelingDatesById.get(feelingId));
  return [...pairs.values()]
    .map(link => {
      const sameFeelings = link.feelingIds.size;
      const sameDays = link.activeDates.size;
      const [left, right] = link.terms.map(term => support.get(term) || 0);
      const overlap = sameDays / Math.max(1, Math.min(left, right));
      const lift = sameDays * Math.max(1, allDates.size) / Math.max(1, left * right);
      const children = link.terms.map(term => rows.find(row => row.normalizedTerm === term));
      const sameFeature = children[0].featureIds.some(id => children[1].featureIds.includes(id));
      return { ...link, feelingIds: [...link.feelingIds].sort(), activeDates: [...link.activeDates].sort(), sameFeelings, sameDays, overlap, lift, reasons: [sameFeature && "same_feature", "same_feeling"].filter(Boolean),
        sameMessages: 0, sameWindows: 0 };
    })
    .filter(link => {
      const hasWorkCore = link.terms.some(term => (rows.find(row => row.normalizedTerm === term)?.categoryPurity?.work || 0) >= 0.5);
      return hasWorkCore && link.sameDays >= 2 && (link.overlap >= 0.35 || link.lift >= 3);
    });
}

function signatureGroups(rows, links) {
  const byTerm = new Map(rows.map(row => [row.normalizedTerm, row]));
  const groups = new Map();
  const linked = new Set();
  for (const link of links) {
    const key = link.feelingIds.join("\0");
    if (!groups.has(key)) groups.set(key, new Map());
    for (const term of link.terms) {
      groups.get(key).set(term, byTerm.get(term));
      linked.add(term);
    }
  }
  const result = [...groups].map(([key, group]) => ({ members: [...group.values()], evidenceFeelingIds: key.split("\0") }));
  for (const row of rows) if (!linked.has(row.normalizedTerm)) result.push({
    members: [row], evidenceFeelingIds: (row.feelings || []).map(feeling => feeling.id),
  });
  return result;
}

function connectedGroups(rows, links) {
  const parent = new Map(rows.map(row => [row.normalizedTerm, row.normalizedTerm]));
  const find = term => parent.get(term) === term ? term : (parent.set(term, find(parent.get(term))), parent.get(term));
  for (const link of links) parent.set(find(link.terms[1]), find(link.terms[0]));
  const groups = new Map();
  for (const row of rows) {
    const root = find(row.normalizedTerm);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(row);
  }
  return [...groups.values()];
}

function buildProject(id, signature, links, referenceDateOverride = null) {
  const members = signature.members;
  const evidenceFeelingIds = new Set(signature.evidenceFeelingIds || []);
  const daily = new Map();
  for (const member of members) for (const feeling of member.feelings || []) {
    if (!evidenceFeelingIds.has(feeling.id)) continue;
    const date = feeling.sourceDate || feeling.source_date;
    if (!date) continue;
    if (!daily.has(date)) daily.set(date, { date, occurrenceCount: 0, activeTerms: [], feelingIds: [] });
    const row = daily.get(date);
    row.occurrenceCount += 1;
    if (!row.activeTerms.includes(member.term)) row.activeTerms.push(member.term);
    if (!row.feelingIds.includes(feeling.id)) row.feelingIds.push(feeling.id);
  }
  const timeline = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const activeDates = timeline.filter(row => row.occurrenceCount).map(row => row.date);
  const referenceDate = referenceDateOverride || activeDates.at(-1) || null;
  const daysSinceLast = activeDates.length ? daysBetween(activeDates.at(-1), referenceDate) : null;
  const episodes = splitEpisodes(activeDates, 7);
  let state = "forming";
  if (daysSinceLast > 30) state = "dormant";
  else if (daysSinceLast > 14) state = "cooling";
  else if (activeDates.length >= 3) state = "active";
  return {
    id, members: members.map(row => ({ term: row.term, normalizedTerm: row.normalizedTerm, categories: row.categories,
      workPurity: row.categoryPurity?.work || 0 })),
    evidenceFeelingIds: [...evidenceFeelingIds],
    state, shape: "project_arc", firstSeen: activeDates[0] || null, lastSeen: activeDates.at(-1) || null,
    activeDays: activeDates.length, episodeCount: episodes.length, timeline,
    links: links.filter(link => link.terms.every(term => members.some(row => row.normalizedTerm === term))),
  };
}

function classifyWorkTerm(row, referenceDateOverride = null) {
  const active = feelingDates(row);
  const referenceDate = referenceDateOverride || active.at(-1) || null;
  const daysSinceLast = active.length && referenceDate ? daysBetween(active.at(-1), referenceDate) : null;
  let state = "forming";
  if (daysSinceLast > 30) state = "dormant";
  else if (daysSinceLast > 14) state = "cooling";
  else if (active.length >= 3) state = "active";
  return { term: row.term, normalizedTerm: row.normalizedTerm, state, firstSeen: active[0] || null,
    lastSeen: active.at(-1) || null, activeDays: active.length, daysSinceLast };
}

function feelingDates(row) {
  return [...new Set((row.feelings || []).map(feeling => feeling.sourceDate || feeling.source_date).filter(Boolean))].sort();
}

function daysBetween(from, to) {
  return Math.max(0, Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000));
}

module.exports = { buildWorkLifecycles, strongLinks, connectedGroups, signatureGroups };
