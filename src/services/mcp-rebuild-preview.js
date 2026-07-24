function buildMcpRebuildPreviewArgs(script, resolved, args = {}) {
  if (!script || !resolved?.threadId) throw new Error("thread rebuild preview requires a script and thread");
  return [
    script,
    "--thread", resolved.threadId,
    "--window", String(args.window || resolved.windowDays || 3),
    "--tool-pairs", String(args.toolPairs ?? resolved.toolPairs ?? 30),
    "--trigger", "mcp",
  ];
}

module.exports = { buildMcpRebuildPreviewArgs };
