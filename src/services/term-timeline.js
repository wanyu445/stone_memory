const { normalizeTerm } = require("./feature-phrase-extractor");

function buildTermTimeline({ requestedTerms, extractedTerms, feelings, messages, anchors = {}, from = null, to = null }) {
  const eventAnchors = new Set(Object.keys(anchors.eventAnchors || {}));
  const retainAnchors = new Set(Object.keys(anchors.retain || {}));
  const allDates = messages.map(row => row.date).filter(Boolean).sort();
  const rangeStart = from || allDates[0] || null;
  const rangeEnd = to || allDates.at(-1) || null;
  return (requestedTerms || []).map(requested => {
    const normalizedTerm = normalizeTerm(requested);
    const sources = (extractedTerms || []).filter(row => row.normalizedTerm === normalizedTerm);
    const categories = [...new Set(sources.map(row => row.category).filter(Boolean))].sort();
    const featureIds = [...new Set(sources.flatMap(row => row.featureIds || []))];
    const daily = new Map();
    for (const date of enumerateDates(rangeStart, rangeEnd)) daily.set(date, { date, messageCount: 0, occurrenceCount: 0 });
    for (const message of messages || []) {
      if (!message.date || (rangeStart && message.date < rangeStart) || (rangeEnd && message.date > rangeEnd)) continue;
      const count = countOccurrences(normalizeTerm(message.text), normalizedTerm);
      if (!count) continue;
      if (!daily.has(message.date)) daily.set(message.date, { date: message.date, messageCount: 0, occurrenceCount: 0 });
      const point = daily.get(message.date);
      point.messageCount++;
      point.occurrenceCount += count;
    }
    const feelingPoints = (feelings || []).filter(feeling => {
      const date = feeling.source_date || feeling.sourceDate;
      if (rangeStart && date < rangeStart) return false;
      if (rangeEnd && date > rangeEnd) return false;
      return normalizeTerm(feeling.content).includes(normalizedTerm);
    }).map(feeling => ({
      id: feeling.id,
      sourceDate: feeling.source_date || feeling.sourceDate || null,
      eventTime: feeling.event_time || feeling.eventTime || null,
      importance: feeling.importance ?? null,
      summaryMode: feeling.summary_mode || feeling.summaryMode || "daily",
      retainAnchor: retainAnchors.has(feeling.id),
      eventAnchor: eventAnchors.has(feeling.id),
      content: feeling.content,
    })).sort((a, b) => (a.sourceDate || "").localeCompare(b.sourceDate || "") || a.id.localeCompare(b.id));
    const timeline = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
    const active = timeline.filter(row => row.messageCount > 0);
    return {
      term: requested,
      normalizedTerm,
      categories,
      featureIds,
      from: rangeStart,
      to: rangeEnd,
      messageCount: active.reduce((sum, row) => sum + row.messageCount, 0),
      occurrenceCount: active.reduce((sum, row) => sum + row.occurrenceCount, 0),
      activeDays: active.length,
      firstSeen: active[0]?.date || null,
      lastSeen: active.at(-1)?.date || null,
      timeline,
      feelings: feelingPoints,
    };
  });
}

function countOccurrences(text, term) {
  if (!text || !term) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(term, index)) >= 0) {
    count++;
    index += term.length;
  }
  return count;
}

function enumerateDates(from, to) {
  if (!from || !to) return [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return [];
  const dates = [];
  for (let date = start; date <= end; date = new Date(date.getTime() + 86400000)) dates.push(date.toISOString().slice(0, 10));
  return dates;
}

module.exports = { buildTermTimeline, countOccurrences, enumerateDates };
