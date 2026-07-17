const { normalizeTerm } = require("./feature-phrase-extractor");
const { countOccurrences } = require("./term-timeline");

function updateTermEvidenceCache({ store, terms }) {
  const normalizedTerms = [...new Set((terms || []).map(term =>
    normalizeTerm(typeof term === "string" ? term : term.normalizedTerm || term.term)
  ).filter(Boolean))];
  const dates = store.listMessageDates();
  const messagesByDate = new Map();
  const latestCached = store.latestTermEvidenceDates(normalizedTerms);
  const rows = [];
  const scanned = [];

  for (const term of normalizedTerms) {
    const lastDate = latestCached.get(term) || null;
    const pendingDates = dates.filter(date => !lastDate || date > lastDate);
    if (!pendingDates.length) continue;
    for (const date of pendingDates) {
      if (!messagesByDate.has(date)) {
        messagesByDate.set(date, store.listMessages({ date }).filter(row => row.type === "user"));
      }
      let userMessageCount = 0;
      let occurrenceCount = 0;
      for (const message of messagesByDate.get(date)) {
        const count = countOccurrences(normalizeTerm(message.text), term);
        if (!count) continue;
        userMessageCount++;
        occurrenceCount += count;
      }
      rows.push({ normalizedTerm: term, sourceDate: date, userMessageCount, occurrenceCount });
    }
    scanned.push({ normalizedTerm: term, from: pendingDates[0], to: pendingDates.at(-1), dates: pendingDates.length });
  }

  store.upsertTermDailyStats(rows);
  return { terms: normalizedTerms.length, rows: rows.length, scanned };
}

module.exports = { updateTermEvidenceCache };
