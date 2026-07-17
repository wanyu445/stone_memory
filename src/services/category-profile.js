const { extractFeatureTerms, normalizeTerm } = require("./feature-phrase-extractor");

function buildCategoryProfile({ features = [], feelings = [] }) {
  const extractedTerms = extractFeatureTerms(features);
  const evidenceTerms = buildEvidenceTerms(extractedTerms, feelings);
  const knownCategories = [...new Set(extractedTerms.map(row => row.category).filter(Boolean))];
  const categories = [];
  const matchesByFeeling = new Map();
  for (const feeling of feelings || []) {
    const content = normalizeTerm(feeling.content);
    const scores = new Map();
    for (const term of evidenceTerms) {
      if (!content.includes(term.normalizedTerm) || term.idf <= 0) continue;
      for (const [category, purity] of Object.entries(term.categoryPurity)) {
        scores.set(category, (scores.get(category) || 0) + term.idf * purity);
      }
    }
    const matched = [];
    if ((scores.get("relation") || 0) > 0) matched.push("relation");
    const secondary = [...scores.entries()].filter(([category, score]) => score > 0
      && category !== "relation" && category !== "misc")
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
    if (secondary) matched.push(secondary[0]);
    matchesByFeeling.set(feeling.id, matched);
  }
  for (const category of knownCategories) {
    const matchedFeelings = (feelings || []).filter(feeling => matchesByFeeling.get(feeling.id)?.includes(category));
    const activeWeeks = new Set(matchedFeelings.map(row => weekKey(row.source_date || row.sourceDate)).filter(Boolean)).size;
    const highImportanceCount = matchedFeelings.filter(row => Number(row.importance) > 3).length;
    const highImportanceRatio = matchedFeelings.length ? highImportanceCount / matchedFeelings.length : 0;
    const weightedEvidence = matchedFeelings.reduce((sum, row) => sum + importanceWeight(row.importance), 0);
    categories.push({ category, feelingCount: matchedFeelings.length, activeWeeks,
      highImportanceCount, highImportanceRatio, weightedEvidence });
  }
  const nonRelationTotal = categories.filter(row => row.category !== "relation" && row.category !== "misc")
    .reduce((sum, row) => sum + row.feelingCount, 0);
  for (const row of categories) row.feelingShare = nonRelationTotal ? row.feelingCount / nonRelationTotal : 0;
  categories.sort((left, right) => right.highImportanceRatio - left.highImportanceRatio
    || right.weightedEvidence - left.weightedEvidence
    || right.activeWeeks - left.activeWeeks
    || right.feelingCount - left.feelingCount
    || left.category.localeCompare(right.category));
  const secondary = categories.find(row => row.category !== "relation" && row.category !== "misc"
    && row.feelingCount >= 5 && row.activeWeeks >= 2 && row.feelingShare >= 0.1) || null;
  return {
    primaryCategory: categories.some(row => row.category === "relation" && row.feelingCount) ? "relation" : null,
    secondaryCategory: secondary?.category || null,
    categories,
    matchesByFeeling,
  };
}

function buildEvidenceTerms(extractedTerms, feelings) {
  const byTerm = new Map();
  for (const row of extractedTerms || []) {
    if (!byTerm.has(row.normalizedTerm)) byTerm.set(row.normalizedTerm, { normalizedTerm: row.normalizedTerm, categories: new Map() });
    const term = byTerm.get(row.normalizedTerm);
    if (!term.categories.has(row.category)) term.categories.set(row.category, new Set());
    for (const featureId of row.featureIds || []) term.categories.get(row.category).add(featureId);
  }
  const contents = (feelings || []).map(row => normalizeTerm(row.content));
  return [...byTerm.values()].map(term => {
    const supports = Object.fromEntries([...term.categories].map(([category, ids]) => [category, ids.size]));
    const totalSupport = Object.values(supports).reduce((sum, count) => sum + count, 0);
    const documentFrequency = contents.filter(content => content.includes(term.normalizedTerm)).length;
    return {
      normalizedTerm: term.normalizedTerm,
      documentFrequency,
      idf: Math.log((contents.length + 1) / (documentFrequency + 1)),
      categoryPurity: Object.fromEntries(Object.entries(supports).map(([category, count]) => [category, totalSupport ? count / totalSupport : 0])),
    };
  });
}

function categoryTerms(extractedTerms) {
  const result = new Map();
  for (const row of extractedTerms || []) {
    if (!row.category || !row.normalizedTerm) continue;
    if (!result.has(row.category)) result.set(row.category, new Set());
    result.get(row.category).add(row.normalizedTerm);
  }
  return new Map([...result].map(([category, terms]) => [category, [...terms]]));
}

function importanceWeight(value) {
  const importance = Number(value || 0);
  if (importance >= 5) return 5;
  if (importance >= 4) return 3;
  if (importance >= 3) return 2;
  return 1;
}

function weekKey(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - day + 1);
  return value.toISOString().slice(0, 10);
}

function buildSecondaryCorePlan(profile, feelings = []) {
  const category = profile?.secondaryCategory;
  if (!category) return [];
  return (feelings || []).filter(row => profile.matchesByFeeling.get(row.id)?.includes(category)).map(row => ({
    feelingId: row.id,
    sourceDate: row.source_date || row.sourceDate,
    importance: Number(row.importance || 0),
    category,
    action: "compress_coarse",
    compressionStyle: "secondary_core",
    reason: `${category} 是当前线程副核心库，使用轻量语义压缩`,
  }));
}

module.exports = { buildCategoryProfile, buildSecondaryCorePlan, buildEvidenceTerms, categoryTerms, importanceWeight, weekKey };
