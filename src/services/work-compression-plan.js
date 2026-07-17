function buildWorkCompressionPlan({ work, termTimelines = [], relationFeelingIds = [], anchors = {} }) {
  const relationProtected = new Set(relationFeelingIds);
  const eventAnchors = new Set(Object.keys(anchors.eventAnchors || {}));
  const retainAnchors = new Set(Object.keys(anchors.retain || {}));
  const terms = new Map((work?.terms || []).map(row => [row.normalizedTerm, row]));
  const feelings = new Map();
  for (const timeline of termTimelines) {
    const lifecycle = terms.get(timeline.normalizedTerm);
    if (!lifecycle) continue;
    for (const feeling of timeline.feelings) {
      if (!feelings.has(feeling.id)) feelings.set(feeling.id, {
        feelingId: feeling.id, sourceDate: feeling.sourceDate, importance: Number(feeling.importance),
        summaryMode: feeling.summaryMode, content: feeling.content, matches: [],
      });
      feelings.get(feeling.id).matches.push({ term: timeline.term, normalizedTerm: timeline.normalizedTerm, state: lifecycle.state });
    }
  }
  const referenceDate = termTimelines.map(row => row.to).filter(Boolean).sort().at(-1) || null;
  const projectStarts = new Set();
  const milestonePeaks = new Set();
  const transitionBridges = new Set((work?.transitions || []).flatMap(edge => edge.bridgeFeelingIds || []));
  for (const group of work?.groups || []) {
    if ((group.members || []).length < 2) continue;
    const firstPoint = group.timeline?.find(point => point.date === group.firstSeen);
    for (const id of firstPoint?.feelingIds || []) projectStarts.add(id);
    const importanceFiveByDate = new Map();
    for (const id of group.evidenceFeelingIds || []) {
      const feeling = feelings.get(id);
      if (!feeling || feeling.importance !== 5 || !feeling.sourceDate) continue;
      if (!importanceFiveByDate.has(feeling.sourceDate)) importanceFiveByDate.set(feeling.sourceDate, []);
      importanceFiveByDate.get(feeling.sourceDate).push(id);
    }
    const max = Math.max(0, ...[...importanceFiveByDate.values()].map(ids => ids.length));
    for (const ids of importanceFiveByDate.values()) if (ids.length === max) for (const id of ids) milestonePeaks.add(id);
  }
  return [...feelings.values()].filter(row => !relationProtected.has(row.feelingId)).map(row => {
    const ageDays = daysBetween(row.sourceDate, referenceDate);
    let action = "compress_coarse";
    let reason = "历史工作事实可压成简洁项目记录";
    if (eventAnchors.has(row.feelingId) || retainAnchors.has(row.feelingId)) {
      action = "keep_daily"; reason = eventAnchors.has(row.feelingId) ? "event anchor 保护" : "原文锚点保护对应摘要";
    }
    return { ...row, ageDays, projectStart: projectStarts.has(row.feelingId),
      milestonePeak: milestonePeaks.has(row.feelingId), transitionBridge: transitionBridges.has(row.feelingId), action, reason };
  }).sort((a, b) => (a.sourceDate || "").localeCompare(b.sourceDate || "") || a.feelingId.localeCompare(b.feelingId));
}

function summarizeWorkCompressionPlan(rows) {
  const actions = {};
  for (const row of rows || []) actions[row.action] = (actions[row.action] || 0) + 1;
  return { feelings: rows.length, actions };
}

function daysBetween(from, to) {
  if (!from || !to) return null;
  return Math.max(0, Math.floor((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000));
}

module.exports = { buildWorkCompressionPlan, summarizeWorkCompressionPlan };
