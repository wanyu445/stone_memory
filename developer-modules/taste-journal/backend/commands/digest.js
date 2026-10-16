"use strict";

const core = require("../../frontend/domain");

const MAX_SECTIONS = 8;
const MAX_PROPOSALS = 8;

function cleanSections(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("sections 必须是数组");
  return value.slice(0, MAX_SECTIONS).map(section => {
    if (!section || typeof section !== "object") throw new Error("section 必须是对象");
    const headingText = String(section.heading || "").trim().slice(0, 40);
    const bodyText = String(section.body || "").trim().slice(0, 1200);
    if (!bodyText) throw new Error("section.body 不能为空");
    return { heading: headingText, body: bodyText };
  });
}

function cleanProposals(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("proposals 必须是数组");
  return value.slice(0, MAX_PROPOSALS).map(proposal => {
    if (!proposal || typeof proposal !== "object") throw new Error("proposal 必须是对象");
    const kind = proposal.kind === "productTag" ? "productTag" : proposal.kind === "ratingLabel" ? "ratingLabel" : null;
    if (!kind) throw new Error("proposal.kind 必须是 ratingLabel 或 productTag");
    const label = String(proposal.label || "").trim().slice(0, 16);
    if (!label) throw new Error("proposal.label 不能为空");
    const item = { kind, label };
    if (proposal.sentiment && core.SENTIMENTS.includes(proposal.sentiment)) item.sentiment = proposal.sentiment;
    if (proposal.productId) item.productId = String(proposal.productId).slice(0, 40);
    return item;
  });
}

async function run(context, input) {
  if (!context || typeof context.resolveDataPath !== "function") {
    throw new Error("digest 命令需要 --memory <记忆体ID>");
  }
  const payload = input && typeof input.payload === "object" ? input.payload : {};
  const digests = core.loadDigests(context);

  if (payload.op === "delete") {
    const kept = digests.filter(digest => digest.id !== payload.digestId);
    core.saveDigests(context, kept);
    return { ok: true, digests: kept };
  }

  const scope = payload.scope === "all" ? "all" : payload.scope === "month" ? "month" : null;
  if (!scope) throw new Error('scope 必须是 "month" 或 "all"');
  let month = "";
  if (scope === "month") {
    month = String(payload.month || "").trim();
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 格式必须是 YYYY-MM");
  }
  const sections = cleanSections(payload.sections);
  if (!sections.length) throw new Error("至少写一段 sections");
  const proposals = cleanProposals(payload.proposals);
  const title = String(payload.title || "").trim().slice(0, 60);
  const author = String(payload.author || "").trim().slice(0, 40);

  const existing = digests.find(digest => digest.scope === scope && digest.month === month);
  const digest = {
    id: existing ? existing.id : core.makeId("dig"),
    scope,
    month,
    title,
    author,
    sections,
    proposals,
    updatedAt: new Date().toISOString(),
  };
  const kept = digests.filter(digest => !(digest.scope === scope && digest.month === month));
  kept.push(digest);
  kept.sort((a, b) => (a.scope === b.scope ? (a.month < b.month ? 1 : -1) : a.scope === "month" ? 1 : -1));
  core.saveDigests(context, kept);
  return { ok: true, digest };
}

module.exports = { run };
