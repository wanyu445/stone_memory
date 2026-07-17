function analyzeFeelingLifecycle({ feelingEvidence, eventAnchorIds = [], retainAnchorIds = [], referenceDate = null }) {
  const reference = referenceDate || latestEvidenceDate(feelingEvidence) || new Date().toISOString().slice(0, 10);
  const eventAnchors = new Set(eventAnchorIds);
  const retainAnchors = new Set(retainAnchorIds);
  return (feelingEvidence || []).map(feeling => analyzeOne(feeling, { reference, eventAnchors, retainAnchors }));
}

function analyzeOne(feeling, { reference, eventAnchors, retainAnchors }) {
  const importance = Number(feeling.importance);
  const ageDays = daysBetween(feeling.sourceDate, reference);
  const dates = feeling.matchedTerms.map(term => term.lastSeen).filter(Boolean).sort();
  const latestTermSeen = dates.at(-1) || null;
  const termIdleDays = daysBetween(latestTermSeen, reference);
  const maxActiveDays = Math.max(0, ...feeling.matchedTerms.map(term => Number(term.activeDays) || 0));
  const messageCount = feeling.matchedTerms.reduce((sum, term) => sum + (Number(term.messageCount) || 0), 0);
  const eventAnchor = eventAnchors.has(feeling.feelingId);
  const retainAnchor = retainAnchors.has(feeling.feelingId);
  const base = {
    ...feeling,
    referenceDate: reference,
    ageDays,
    latestTermSeen,
    termIdleDays,
    maxActiveDays,
    matchedMessageCount: messageCount,
    eventAnchor,
    retainAnchor,
    proposedImportance: importance === 1 ? 2 : importance === 4 ? 5 : null,
    estimatedCoarseChars: Math.min(160, Math.max(40, Math.round(feeling.content.length * 0.35))),
  };

  if (eventAnchor) return decision(base, "event_protected", "事件锚点标记了长期关键事件，交给主 Agent 巡检，不自动压缩");
  if (retainAnchor) return decision(base, "retain_protected", "原文锚点要求保留对应摘要，不参与自动压缩");
  if (importance === 1) return decision(base, "coarse_candidate", "历史 importance 1；按事实型压缩，同时预览兼容映射 1→2");
  if (importance === 2) return decision(base, "coarse_candidate", "importance 2；建议压成带完整日期时间的客观事实");
  if (importance === 4) return decision(base, "compatibility_review", "历史 importance 4；仅预览兼容映射 4→5，确认前不自动处理");
  if (importance === 5) {
    if (ageDays !== null && ageDays >= 30) return decision(base, "main_agent_review", `importance 5 已存在 ${ageDays} 天，进入主 Agent 巡检候选`);
    return decision(base, "keep", `importance 5 尚未满 30 天${ageDays === null ? "" : `（${ageDays} 天）`}`);
  }
  if (importance === 3) {
    if (termIdleDays === null) return decision(base, "observe", "命中 feature term，但 archive 没有可用的最近日期证据");
    if (termIdleDays <= 14) return decision(base, "keep", `最近 term 活跃距参考日 ${termIdleDays} 天`);
    if (termIdleDays <= 30) return decision(base, "observe", `最近 term 已 ${termIdleDays} 天未出现，先观察`);
    if (maxActiveDays >= 10) return decision(base, "observe", `最近 term 已 ${termIdleDays} 天未出现，但历史覆盖最高 ${maxActiveDays} 天`);
    return decision(base, "coarse_candidate", `最近 term 已 ${termIdleDays} 天未出现，历史覆盖最高 ${maxActiveDays} 天`);
  }
  return decision(base, "compatibility_review", `未知 importance ${feeling.importance}，不自动处理`);
}

function decision(row, action, reason) {
  const savings = action === "coarse_candidate" ? Math.max(0, row.content.length - row.estimatedCoarseChars) : 0;
  return { ...row, action, reason, estimatedSavingsChars: savings };
}

function latestEvidenceDate(rows) {
  const dates = [];
  for (const feeling of rows || []) {
    if (feeling.sourceDate) dates.push(feeling.sourceDate);
    for (const term of feeling.matchedTerms || []) if (term.lastSeen) dates.push(term.lastSeen);
  }
  return dates.sort().at(-1) || null;
}

function daysBetween(earlier, later) {
  if (!earlier || !later) return null;
  const start = new Date(`${earlier}T00:00:00Z`).getTime();
  const end = new Date(`${later}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86400000));
}

function summarizeLifecycle(rows) {
  const actions = {};
  let estimatedSavingsChars = 0;
  for (const row of rows || []) {
    actions[row.action] = (actions[row.action] || 0) + 1;
    estimatedSavingsChars += row.estimatedSavingsChars || 0;
  }
  return { matchedFeelings: rows.length, actions, estimatedSavingsChars };
}

module.exports = { analyzeFeelingLifecycle, summarizeLifecycle, daysBetween, latestEvidenceDate };
