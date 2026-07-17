const DAY_MS = 86400000;

function selectEarliestWeek(decisions, days = 7) {
  const rows = [...(decisions || [])]
    .filter(row => row.sourceDate)
    .sort((a, b) => a.sourceDate.localeCompare(b.sourceDate) || a.feelingId.localeCompare(b.feelingId));
  if (!rows.length) return null;
  const firstCompressible = rows.find(row => row.action === "compress_coarse");
  if (!firstCompressible) return null;
  const from = firstCompressible.sourceDate;
  const to = addDays(from, Math.max(1, days) - 1);
  const selected = rows.filter(row => row.sourceDate >= from && row.sourceDate <= to);
  return {
    from,
    to,
    decisions: selected,
    keep: selected.filter(row => row.action === "keep_daily"),
    coarse: selected.filter(row => row.action === "compress_coarse"),
  };
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
    after += decision.action === "compress_coarse" ? Math.min(160, Math.ceil(length * ratio)) : length;
  }
  return { before, estimatedAfter: after, estimatedSaving: Math.max(0, before - after) };
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setTime(value.getTime() + days * DAY_MS);
  return value.toISOString().slice(0, 10);
}

module.exports = { selectEarliestWeek, measureInjectedCharacters, estimateWeekCharacters, addDays };
