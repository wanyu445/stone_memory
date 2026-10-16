"use strict";

const core = require("../../frontend/domain");

async function run(context, input) {
  if (!context || typeof context.resolveDataPath !== "function") {
    throw new Error("list 命令需要 --memory <记忆体ID>");
  }
  const payload = input && typeof input.payload === "object" ? input.payload : {};
  const journal = core.loadJournal(context);
  const settings = core.loadSettings(context);
  const today = core.todayStr();

  if (payload.query) {
    const entries = core.filterEntries(journal, payload.query);
    const productIds = new Set(entries.map(entry => entry.productId));
    const products = journal.products
      .filter(product => productIds.has(product.id))
      .map(product => core.rollupProduct(product, journal.entries, settings));
    return { ok: true, today, query: payload.query, count: entries.length, products, entries };
  }

  return {
    ok: true,
    today,
    settings,
    categories: core.CATEGORIES,
    optionKeys: core.OPTION_KEYS,
    products: journal.products.map(product => core.rollupProduct(product, journal.entries, settings)),
    entries: journal.entries,
    digests: core.loadDigests(context),
    drafts: core.loadDrafts(context),
  };
}

module.exports = { run };
