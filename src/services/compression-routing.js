function buildCompressionRouting({ feelings = [], relationPlan = [], secondaryCorePlan = [], workPlan = [], anchors = {} }) {
  const relation = new Map(relationPlan.map(row => [row.feelingId, row]));
  const secondary = new Map(secondaryCorePlan.map(row => [row.feelingId, row]));
  const work = new Map(workPlan.map(row => [row.feelingId, row]));
  const eventAnchors = new Set(Object.keys(anchors.eventAnchors || {}));
  const retainAnchors = new Set(Object.keys(anchors.retain || {}));
  return feelings.filter(row => (row.summary_mode || row.summaryMode || "daily") === "daily").map(feeling => {
    const importance = Number(feeling.importance || 0);
    const base = { feelingId: feeling.id, sourceDate: feeling.source_date || feeling.sourceDate,
      importance, content: feeling.content };
    if (eventAnchors.has(feeling.id)) return { ...base, route: "anchor", action: "keep_daily", reason: "event anchor 保护" };
    if (retainAnchors.has(feeling.id)) return { ...base, route: "anchor", action: "keep_daily", reason: "原文锚点保护对应摘要" };
    if (importance > 3 && relation.has(feeling.id) && relation.get(feeling.id).takeover !== false) {
      const decision = relation.get(feeling.id);
      return { ...base, route: "relation", action: decision.action, reason: decision.reason };
    }
    if (secondary.has(feeling.id)) {
      const decision = secondary.get(feeling.id);
      return { ...base, route: "secondary_core", category: decision.category,
        compressionStyle: decision.compressionStyle, action: decision.action, reason: decision.reason };
    }
    if (importance > 3 && work.has(feeling.id)) {
      const decision = work.get(feeling.id);
      return { ...base, route: "work", action: decision.action, reason: decision.reason };
    }
    return { ...base, route: "fact", action: "compress_coarse",
      reason: importance <= 3 ? "importance 1–3 直接压成客观事实" : "无高置信主核心或副核心接管，按事实简写" };
  });
}

function summarizeCompressionRouting(rows) {
  const routes = {}, actions = {};
  for (const row of rows || []) {
    routes[row.route] = (routes[row.route] || 0) + 1;
    actions[row.action] = (actions[row.action] || 0) + 1;
  }
  return { feelings: rows.length, routes, actions };
}

module.exports = { buildCompressionRouting, summarizeCompressionRouting };
