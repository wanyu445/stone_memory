function buildRelationCompressionPlan({ relation, termTimelines = [], anchors = {} }) {
  const eventAnchors = new Set(Object.keys(anchors.eventAnchors || {}));
  const retainAnchors = new Set(Object.keys(anchors.retain || {}));
  const feelings = collectFeelings(termTimelines, relation?.terms || []);
  const peakDays = findImportanceFivePeakDays(feelings);

  return [...feelings.values()].map(row => {
    const eventAnchor = eventAnchors.has(row.feelingId);
    const retainAnchor = retainAnchors.has(row.feelingId);
    const positions = [...new Set(row.matches.map(match => match.position))];
    const unsettled = row.matches.some(match => ["forming", "revived", "experimental"].includes(match.lifecycleState));
    const peakMatches = row.matches.filter(match => peakDays.has(peakKey(match, row.sourceDate)));
    const relationActive = row.matches.some(match => ["rare_early", "formation", "revival", "episodic_recurrence"].includes(match.position));
    let action = "compress_coarse";
    let reason = "已定型关系阶段中的非峰值摘要，可保留核心感受后简写";

    if (eventAnchor || retainAnchor) {
      action = "keep_daily";
      reason = eventAnchor ? "event anchor 保护长期关键事件" : "原文锚点保护对应摘要";
    } else if (unsettled) {
      action = "keep_daily";
      reason = "关系仍在形成、实验或复活阶段，暂不自动压缩";
    } else if (peakMatches.length) {
      action = "keep_daily";
      reason = "该关系阶段的 importance 5 摘要密度峰值日";
    }

    return {
      ...row,
      positions,
      eventAnchor,
      retainAnchor,
      importanceFivePeak: peakMatches.length > 0,
      takeover: eventAnchor || retainAnchor || unsettled || peakMatches.length > 0 || relationActive,
      action,
      reason,
    };
  }).sort((a, b) => (a.sourceDate || "").localeCompare(b.sourceDate || "") || a.feelingId.localeCompare(b.feelingId));
}

function findImportanceFivePeakDays(feelings) {
  const counts = new Map();
  for (const row of feelings.values()) {
    if (Number(row.importance) !== 5 || !row.sourceDate) continue;
    for (const match of uniqueStageMatches(row.matches)) {
      const group = stageKey(match);
      if (!counts.has(group)) counts.set(group, new Map());
      const dates = counts.get(group);
      if (!dates.has(row.sourceDate)) dates.set(row.sourceDate, new Set());
      dates.get(row.sourceDate).add(row.feelingId);
    }
  }

  const peaks = new Set();
  for (const [group, dates] of counts) {
    const max = Math.max(...[...dates.values()].map(ids => ids.size));
    for (const [date, ids] of dates) {
      if (ids.size === max) peaks.add(`${group}\0${date}`);
    }
  }
  return peaks;
}

function uniqueStageMatches(matches) {
  const unique = new Map();
  for (const match of matches) unique.set(stageKey(match), match);
  return unique.values();
}

function stageKey(match) {
  return stageBucket(match.position);
}

function peakKey(match, date) {
  return `${stageKey(match)}\0${date}`;
}

function stageBucket(position) {
  if (["rare_early", "formation"].includes(position)) return "formation";
  if (position === "revival") return "revival";
  if (position === "stable_repeat") return "stable";
  if (position === "post_plateau_callback") return "stable";
  if (position === "episodic_recurrence") return "episodic";
  if (position === "retired_history") return "retired";
  return position || "unknown";
}

function collectFeelings(termTimelines, lifecycleTerms) {
  const lifecycles = new Map(lifecycleTerms.map(row => [row.normalizedTerm, row]));
  const feelings = new Map();
  for (const timeline of termTimelines) {
    const lifecycle = lifecycles.get(timeline.normalizedTerm);
    if (!lifecycle) continue;
    const points = new Map(lifecycle.feelingPoints.map(point => [point.feelingId, point]));
    for (const feeling of timeline.feelings) {
      if (!feelings.has(feeling.id)) feelings.set(feeling.id, {
        feelingId: feeling.id, sourceDate: feeling.sourceDate, importance: feeling.importance,
        summaryMode: feeling.summaryMode, content: feeling.content, matches: [],
      });
      feelings.get(feeling.id).matches.push({
        term: timeline.term, normalizedTerm: timeline.normalizedTerm, lifecycleState: lifecycle.state,
        lifecycleShape: lifecycle.shape, position: points.get(feeling.id)?.position || "unknown",
      });
    }
  }
  return feelings;
}

function summarizeRelationCompressionPlan(rows) {
  const actions = {};
  for (const row of rows || []) actions[row.action] = (actions[row.action] || 0) + 1;
  return { feelings: rows.length, actions };
}

module.exports = { buildRelationCompressionPlan, summarizeRelationCompressionPlan };
