const DAY_MS = 86400000;

function rankCompressionWeeks(decisions, feelings = [], days = 7, ratio = 0.45) {
  const rows = [...(decisions || [])].filter(row => row.sourceDate);
  const allDates = (feelings || []).map(row => row.source_date || row.sourceDate).filter(Boolean);
  const anchorDate = [...allDates, ...rows.map(row => row.sourceDate)].sort()[0] || null;
  if (!anchorDate) return [];
  const weekSize = Math.max(1, days);
  const groups = new Map();
  for (const row of rows) {
    const index = Math.max(0, Math.floor(daysBetween(anchorDate, row.sourceDate) / weekSize));
    if (!groups.has(index)) groups.set(index, []);
    groups.get(index).push(row);
  }
  return [...groups.entries()].map(([index, group]) => {
    const from = addDays(anchorDate, index * weekSize);
    const to = addDays(from, weekSize - 1);
    const selected = group.sort((a, b) => a.sourceDate.localeCompare(b.sourceDate) || a.feelingId.localeCompare(b.feelingId));
    const keep = selected.filter(row => row.action === "keep_daily");
    const coarse = selected.filter(row => row.action === "compress_coarse");
    const totalCharacters = selected.reduce((sum, row) => sum + String(row.content || "").length, 0);
    const coarseCharacters = coarse.reduce((sum, row) => sum + String(row.content || "").length, 0);
    const keepCharacters = totalCharacters - coarseCharacters;
    const anchorCharacters = selected.filter(row => row.route === "anchor")
      .reduce((sum, row) => sum + String(row.content || "").length, 0);
    const week = { from, to, decisions: selected, keep, coarse };
    const estimate = estimateWeekCharacters(week, feelings, ratio);
    return {
      ...week,
      totalCharacters,
      coarseCharacters,
      keepCharacters,
      anchorCharacters,
      compressibleRatio: totalCharacters ? coarseCharacters / totalCharacters : 0,
      estimatedSaving: estimate.estimatedSaving,
    };
  }).filter(week => week.coarse.length > 0)
    .sort((left, right) => right.compressibleRatio - left.compressibleRatio
      || right.estimatedSaving - left.estimatedSaving
      || left.from.localeCompare(right.from))
    .map((week, index) => ({ ...week, rank: index + 1 }));
}

function buildCompressionWindow(decisions, feelings = [], from, to, ratio = 0.45) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "") || to < from) {
    throw new Error("精确压缩窗口需要合法的 --from/--to，且 to 不能早于 from");
  }
  const selected = (decisions || []).filter(row => row.sourceDate >= from && row.sourceDate <= to)
    .sort((a, b) => a.sourceDate.localeCompare(b.sourceDate) || a.feelingId.localeCompare(b.feelingId));
  const keep = selected.filter(row => row.action === "keep_daily");
  const coarse = selected.filter(row => row.action === "compress_coarse");
  const totalCharacters = selected.reduce((sum, row) => sum + String(row.content || "").length, 0);
  const coarseCharacters = coarse.reduce((sum, row) => sum + String(row.content || "").length, 0);
  const week = { from, to, decisions: selected, keep, coarse };
  const estimate = estimateWeekCharacters(week, feelings, ratio);
  return { ...week, totalCharacters, coarseCharacters,
    keepCharacters: totalCharacters - coarseCharacters,
    anchorCharacters: selected.filter(row => row.route === "anchor")
      .reduce((sum, row) => sum + String(row.content || "").length, 0),
    compressibleRatio: totalCharacters ? coarseCharacters / totalCharacters : 0,
    estimatedSaving: estimate.estimatedSaving, rank: 1 };
}

function measureInjectedCharacters(feelings) {
  return (feelings || []).reduce((total, row) => {
    const mode = row.summary_mode || row.summaryMode || "daily";
    if (mode === "hidden") return total;
    const text = mode === "coarse"
      ? (row.coarse_summary || row.coarseSummary || row.content || "")
      : (row.content || "");
    return total + String(text).length;
  }, 0);
}

function estimateWeekCharacters(week, feelings, ratio = 0.45) {
  const byId = new Map((feelings || []).map(row => [row.id, row]));
  let before = 0;
  let after = 0;
  for (const decision of week?.decisions || []) {
    const length = String(byId.get(decision.feelingId)?.content || decision.content || "").length;
    before += length;
    const secondary = decision.compressionStyle === "secondary_core";
    const compressionRatio = secondary ? 0.7 : ratio;
    const maxLength = secondary ? 220 : 160;
    after += decision.action === "compress_coarse" ? Math.min(maxLength, Math.ceil(length * compressionRatio)) : length;
  }
  return { before, estimatedAfter: after, estimatedSaving: Math.max(0, before - after) };
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setTime(value.getTime() + days * DAY_MS);
  return value.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

module.exports = { rankCompressionWeeks, buildCompressionWindow, measureInjectedCharacters, estimateWeekCharacters, addDays, daysBetween };
