const { normalizeTerm } = require("./feature-phrase-extractor");

function findRelationSignaturePeers({ requestedTerms = [], extractedTerms = [], feelings = [], limit = 12 }) {
  const requested = new Set(requestedTerms.map(normalizeTerm).filter(Boolean));
  const requestedList = [...requested];
  const relevantContents = feelings.map(feeling => normalizeTerm(feeling.content || ""))
    .filter(content => requestedList.some(term => content.includes(term)));
  const candidates = new Map();
  for (const row of extractedTerms) {
    const normalizedTerm = row.normalizedTerm || normalizeTerm(row.term);
    if (!normalizedTerm || requested.has(normalizedTerm)) continue;
    if (requestedList.some(term => term.includes(normalizedTerm) || normalizedTerm.includes(term))) continue;
    const existing = candidates.get(normalizedTerm);
    const sameFeelings = existing?.sameFeelings
      ?? relevantContents.filter(content => content.includes(normalizedTerm)).length;
    if (sameFeelings < 2) continue;
    const relationSupport = row.category === "relation" ? 1 : 0;
    if (!existing || relationSupport > existing.relationSupport) {
      candidates.set(normalizedTerm, { term: row.term || normalizedTerm, normalizedTerm, sameFeelings, relationSupport });
    }
  }
  return [...candidates.values()]
    .sort((left, right) => right.sameFeelings - left.sameFeelings
      || right.relationSupport - left.relationSupport
      || left.term.localeCompare(right.term, "zh-CN"))
    .slice(0, limit);
}

module.exports = { findRelationSignaturePeers };
