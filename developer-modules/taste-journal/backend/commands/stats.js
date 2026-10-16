"use strict";

const core = require("../../frontend/domain");

async function run(context, input) {
  if (!context || typeof context.resolveDataPath !== "function") {
    throw new Error("stats 命令需要 --memory <记忆体ID>");
  }
  const journal = core.loadJournal(context);
  const settings = core.loadSettings(context);
  return { ok: true, stats: core.buildStats(journal, settings, { today: core.todayStr() }) };
}

module.exports = { run };
