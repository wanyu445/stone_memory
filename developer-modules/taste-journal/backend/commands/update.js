"use strict";

const core = require("../../frontend/domain");

async function run(context, input) {
  if (!context || typeof context.resolveDataPath !== "function") {
    throw new Error("update 命令需要 --memory <记忆体ID>");
  }
  const payload = input && typeof input.payload === "object" ? input.payload : {};
  const journal = core.loadJournal(context);
  const settings = core.loadSettings(context);
  const today = core.todayStr();

  if (payload.op === "deleteDraft") {
    const drafts = core.loadDrafts(context).filter(draft => draft.id !== payload.draftId);
    core.saveDrafts(context, drafts);
    return { ok: true, pendingDrafts: drafts.length };
  }

  if (payload.op === "resolveDraft") {
    const drafts = core.loadDrafts(context);
    const result = core.applyAdd(journal, settings, { product: payload.product, entry: payload.entry }, { today, source: "manual" });
    if (result.draft) throw new Error("补全内容缺少 product 信息");
    core.saveDrafts(context, drafts.filter(draft => draft.id !== payload.draftId));
    core.saveJournal(context, journal);
    return { ok: true, productId: result.product.id, pendingDrafts: drafts.length - 1 };
  }

  if (payload.op === "clearAll") {
    if (payload.confirm !== true) throw new Error("清空数据需要 confirm: true");
    core.saveJournal(context, core.cloneDefaults());
    core.saveDrafts(context, []);
    core.saveDigests(context, []);
    return { ok: true, cleared: true };
  }

  const touched = core.applyUpdate(journal, settings, payload, { today });
  core.saveJournal(context, journal);
  core.saveSettings(context, settings);

  const response = { ok: true };
  if (touched && touched.productId) {
    const product = journal.products.find(item => item.id === touched.productId);
    response.product = product ? core.rollupProduct(product, journal.entries, settings) : null;
  }
  if (payload.op === "settings") response.settings = settings;
  return response;
}

module.exports = { run };
