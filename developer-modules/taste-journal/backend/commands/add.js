"use strict";

const core = require("../../frontend/domain");

async function run(context, input) {
  if (!context || typeof context.resolveDataPath !== "function") {
    throw new Error("add 命令需要 --memory <记忆体ID>");
  }
  const payload = input && typeof input.payload === "object" ? input.payload : {};
  const journal = core.loadJournal(context);
  const settings = core.loadSettings(context);
  const today = core.todayStr();
  const source = payload.source === "manual" ? "manual" : "ai";
  const result = core.applyAdd(journal, settings, payload, { today, source });
  if (result.draft) {
    const drafts = core.loadDrafts(context);
    drafts.push(result.draft);
    core.saveDrafts(context, drafts);
    return { ok: true, draft: true, pendingDrafts: drafts.length };
  }
  core.saveJournal(context, journal);
  return {
    ok: true,
    product: core.rollupProduct(result.product, journal.entries, settings),
    entry: result.entry,
    similar: result.similar || [],
  };
}

module.exports = { run };
