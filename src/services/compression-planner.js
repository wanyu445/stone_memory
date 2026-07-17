const { extractFeatureTerms, normalizeTerm } = require("./feature-phrase-extractor");
const { buildTermTimeline } = require("./term-timeline");
const { buildRelationLifecycles } = require("./relation-lifecycle");
const { buildRelationCompressionPlan } = require("./relation-compression-plan");
const { buildWorkLifecycles } = require("./work-lifecycle");
const { buildWorkCompressionPlan } = require("./work-compression-plan");
const { buildCompressionRouting, summarizeCompressionRouting } = require("./compression-routing");
const { buildCategoryProfile, buildSecondaryCorePlan } = require("./category-profile");

function buildCompressionPlan({ features = [], feelings = [], messages = [], dailyStats = null, anchors = {} }) {
  const dailyFeelings = feelings.filter(row => (row.summary_mode || row.summaryMode || "daily") === "daily");
  const extractedTerms = extractFeatureTerms(features);
  const modelTerms = extractedTerms.filter(row => row.category === "relation" || row.category === "work");
  const requestedTerms = activeTerms(modelTerms, dailyFeelings);
  const termTimelines = buildTermTimeline({
    requestedTerms,
    extractedTerms,
    feelings,
    messages,
    dailyStats,
    anchors,
  });
  // 生命周期拟合只使用摘要点。不要为每个候选词对重复扫描 archive；
  // archive 曲线属于证据展示层，relation/work 的共同签名由 feeling 倒排索引生成。
  const intersections = buildFeelingIntersections(termTimelines);
  const relationTimelines = termTimelines.filter(row => row.categories.includes("relation"));
  const relationTerms = new Set(relationTimelines.map(row => row.normalizedTerm));
  const relationIntersections = intersections.filter(row => row.normalizedTerms.every(term => relationTerms.has(term)));
  const relation = buildRelationLifecycles({ termTimelines: relationTimelines, intersections: relationIntersections });
  relation.compressionPlan = buildRelationCompressionPlan({ relation, termTimelines: relationTimelines, anchors });
  const work = buildWorkLifecycles({ termTimelines, intersections });
  work.compressionPlan = buildWorkCompressionPlan({
    work,
    termTimelines,
    relationFeelingIds: relation.compressionPlan.filter(row => row.takeover).map(row => row.feelingId),
    anchors,
  });
  const categoryProfile = buildCategoryProfile({ features, feelings });
  const secondaryCorePlan = buildSecondaryCorePlan(categoryProfile, dailyFeelings);
  const decisions = buildCompressionRouting({
    feelings: dailyFeelings,
    relationPlan: relation.compressionPlan,
    secondaryCorePlan,
    anchors,
  });
  return {
    candidateTerms: requestedTerms.length,
    dailyFeelings: dailyFeelings.length,
    summary: summarizeCompressionRouting(decisions),
    decisions,
    termTimelines,
    relation,
    work,
    categoryProfile: { primaryCategory: categoryProfile.primaryCategory,
      secondaryCategory: categoryProfile.secondaryCategory, categories: categoryProfile.categories },
    secondaryCorePlan,
  };
}

function buildFeelingIntersections(termTimelines) {
  const byFeeling = new Map();
  for (const timeline of termTimelines || []) {
    for (const feeling of timeline.feelings || []) {
      if (!byFeeling.has(feeling.id)) byFeeling.set(feeling.id, { feeling, timelines: new Map() });
      byFeeling.get(feeling.id).timelines.set(timeline.normalizedTerm, timeline);
    }
  }
  const pairs = new Map();
  for (const { feeling, timelines } of byFeeling.values()) {
    const members = [...timelines.values()].sort((a, b) => a.normalizedTerm.localeCompare(b.normalizedTerm));
    for (let left = 0; left < members.length; left++) for (let right = left + 1; right < members.length; right++) {
      const children = [members[left], members[right]];
      const key = children.map(row => row.normalizedTerm).join("\0");
      if (!pairs.has(key)) pairs.set(key, {
        terms: children.map(row => row.term),
        normalizedTerms: children.map(row => row.normalizedTerm),
        sameDays: [], sameMessages: [], sameWindows: [], sameFeelings: [],
      });
      pairs.get(key).sameFeelings.push({
        id: feeling.id,
        sourceDate: feeling.sourceDate,
        eventTime: feeling.eventTime,
        importance: feeling.importance,
        summaryMode: feeling.summaryMode,
        retainAnchor: feeling.retainAnchor,
        eventAnchor: feeling.eventAnchor,
        content: feeling.content,
      });
    }
  }
  for (const pair of pairs.values()) {
    pair.sameDays = [...new Set(pair.sameFeelings.map(row => row.sourceDate).filter(Boolean))]
      .sort().map(date => ({ date }));
  }
  return [...pairs.values()];
}

function activeTerms(extractedTerms, dailyFeelings) {
  const normalizedContents = dailyFeelings.map(row => normalizeTerm(row.content));
  const labels = new Map();
  for (const row of extractedTerms || []) {
    if (!row.normalizedTerm || labels.has(row.normalizedTerm)) continue;
    if (normalizedContents.some(content => content.includes(row.normalizedTerm))) {
      labels.set(row.normalizedTerm, row.term);
    }
  }
  return [...labels.values()];
}

module.exports = { buildCompressionPlan, activeTerms, buildFeelingIntersections };
