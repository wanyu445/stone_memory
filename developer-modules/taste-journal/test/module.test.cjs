"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const core = require("../frontend/domain");
const add = require("../backend/commands/add");
const list = require("../backend/commands/list");
const update = require("../backend/commands/update");
const stats = require("../backend/commands/stats");
const digest = require("../backend/commands/digest");

function stubContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taste-journal-test-"));
  return {
    dir,
    moduleId: "taste-journal",
    threadId: "t-test",
    moduleDataDir: dir,
    resolveDataPath(relativePath) {
      if (typeof relativePath !== "string" || relativePath.includes("..")) throw new Error("非法路径");
      return path.join(dir, relativePath);
    },
  };
}
const contexts = [];
function newContext() {
  const stub = stubContext();
  contexts.push(stub.dir);
  return stub;
}
test.after(() => {
  for (const dir of contexts) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  return { journal: core.cloneDefaults(), settings: core.defaultSettings(), today: "2026-09-06" };
}

test("新增记录：建档、盖章、精确归并", () => {
  const { journal, settings, today } = setup();
  const first = core.applyAdd(journal, settings, {
    product: { brand: "霸王茶姬", name: "伯牙绝弦", category: "drink", tags: ["茉莉"] },
    entry: { ratingId: "love", options: { 糖度: "微糖" }, note: "茶感清冽", price: 18 },
  }, { today });
  assert.equal(first.product.id, journal.products[0].id);
  assert.equal(journal.entries.length, 1);

  const second = core.applyAdd(journal, settings, {
    product: { brand: "霸王茶姬", name: "伯牙绝弦" },
    entry: { ratingId: "love" },
  }, { today });
  assert.equal(second.product.id, first.product.id);
  assert.equal(journal.products.length, 1);
  assert.equal(journal.entries.length, 2);
  assert.deepEqual(second.entry.options, { 糖度: "微糖" }, "不填配置时沿用上次");
});

test("查重：模糊相似返回候选而不是错误归并", () => {
  const { journal, settings, today } = setup();
  core.applyAdd(journal, settings, {
    product: { brand: "Manner", name: "桂花乌龙拿铁" },
    entry: { ratingId: "love" },
  }, { today });
  const result = core.applyAdd(journal, settings, {
    product: { brand: "Manner", name: "桂花乌龙拿铁燕麦版" },
    entry: { ratingId: "tried" },
  }, { today });
  assert.equal(journal.products.length, 2, "名字不完全一致时建新卡");
  assert.equal(result.similar.length, 1);
  assert.equal(result.similar[0].name, "桂花乌龙拿铁");
});

test("显式空配置不继承", () => {
  const { journal, settings, today } = setup();
  core.applyAdd(journal, settings, {
    product: { brand: "A", name: "B" },
    entry: { options: { 糖度: "微糖" }, ratingId: "love" },
  }, { today });
  const second = core.applyAdd(journal, settings, {
    product: { brand: "A", name: "B" },
    entry: { options: {}, ratingId: "tried" },
  }, { today });
  assert.deepEqual(second.entry.options, {});
});

test("汇总：集章档位、回购判定、点单口诀", () => {
  const { journal, settings, today } = setup();
  for (let i = 0; i < 8; i += 1) {
    core.applyAdd(journal, settings, {
      product: { brand: "霸王茶姬", name: "伯牙绝弦" },
      entry: { ratingId: i === 7 ? "avoid" : "love", options: i === 7 ? { 糖度: "标准糖" } : { 糖度: "微糖" } },
    }, { today });
  }
  const product = journal.products[0];
  const rollup = core.rollupProduct(product, journal.entries, settings);
  assert.equal(rollup.stamps, 8);
  assert.equal(rollup.tier.label, "本命");
  assert.equal(rollup.verdict.level, "rebuy", "7 正 1 负仍然是回购");
  assert.deepEqual(rollup.divergences[0], { key: "糖度", rows: [
    { value: "微糖", count: 7, love: 7, avoid: 0 },
    { value: "标准糖", count: 1, love: 0, avoid: 1 },
  ] });
  assert.equal(rollup.orderHint, "下次这么点：微糖");
});

test("汇总：负评占优时判定为拉黑", () => {
  const { journal, settings, today } = setup();
  core.applyAdd(journal, settings, { product: { brand: "X", name: "翻车奶茶" }, entry: { ratingId: "avoid" } }, { today });
  core.applyAdd(journal, settings, { product: { brand: "X", name: "翻车奶茶" }, entry: { ratingId: "avoid" } }, { today });
  const rollup = core.rollupProduct(journal.products[0], journal.entries, settings);
  assert.equal(rollup.verdict.level, "avoid");
});

test("手动覆盖判定优先于自动判定", () => {
  const { journal, settings, today } = setup();
  core.applyAdd(journal, settings, { product: { brand: "X", name: "Y" }, entry: { ratingId: "love" } }, { today });
  journal.products[0].verdictOverride = { level: "avoid", note: "喝完心悸" };
  const rollup = core.rollupProduct(journal.products[0], journal.entries, settings);
  assert.equal(rollup.verdict.level, "avoid");
  assert.equal(rollup.verdict.note, "喝完心悸");
});

test("merge：记录与标签并入目标卡", () => {
  const { journal, settings, today } = setup();
  const a = core.applyAdd(journal, settings, { product: { brand: "A", name: "拿铁", tags: ["燕麦"] }, entry: { ratingId: "love" } }, { today });
  const b = core.applyAdd(journal, settings, { product: { brand: "A", name: "燕麦拿铁", tags: ["桂花"] }, entry: { ratingId: "tried" } }, { today });
  core.applyUpdate(journal, settings, { op: "merge", fromProductId: b.product.id, intoProductId: a.product.id }, { today });
  assert.equal(journal.products.length, 1);
  assert.equal(journal.entries.length, 2);
  assert.ok(journal.products[0].tags.includes("燕麦") && journal.products[0].tags.includes("桂花"));
  assert.equal(journal.entries.every(entry => entry.productId === a.product.id), true);
});

test("评分档位：新增自定义档，删除在用档位需要 force", () => {
  const { journal, settings, today } = setup();
  core.applyAdd(journal, settings, { product: { brand: "A", name: "B" }, entry: { ratingId: "love" } }, { today });
  core.applyUpdate(journal, settings, { op: "settings", patch: { addRatingLabel: { label: "干杯不腻", sentiment: "positive" } } }, { today });
  const custom = settings.ratingLabels.find(label => label.label === "干杯不腻");
  assert.ok(custom);
  assert.throws(() => core.applyUpdate(journal, settings, { op: "settings", patch: { removeRatingLabel: "love" } }, { today }), /条记录在用/);
  core.applyUpdate(journal, settings, { op: "settings", patch: { removeRatingLabel: "love" }, force: true }, { today });
  assert.equal(settings.ratingLabels.some(label => label.id === "love"), false);
  assert.equal(journal.entries[0].ratingId, "tried", "在用记录改回尝鲜一次");
});

test("统计：月度聚合、标签好评率、糖度洞察", () => {
  const { journal, settings, today } = setup();
  core.applyAdd(journal, settings, { product: { brand: "霸王茶姬", name: "伯牙绝弦", tags: ["茉莉"] }, entry: { ratingId: "love", options: { 糖度: "微糖" }, price: 18 } }, { today });
  core.applyAdd(journal, settings, { product: { brand: "霸王茶姬", name: "伯牙绝弦", tags: ["茉莉"] }, entry: { ratingId: "avoid", options: { 糖度: "标准糖" }, price: 18 } }, { today });
  core.applyAdd(journal, settings, { product: { brand: "Manner", name: "桂花乌龙拿铁", tags: ["桂花"] }, entry: { ratingId: "love", options: { 糖度: "微糖" } } }, { today });
  const result = core.buildStats(journal, settings, { today });
  assert.equal(result.totals.entries, 3);
  assert.equal(result.totals.spend, 36);
  const month = result.months.find(row => row.month === "2026-09");
  assert.equal(month.count, 3);
  assert.equal(month.spend, 36);
  assert.equal(month.newProducts, 2);
  const jasmine = result.tags.find(row => row.tag === "茉莉");
  assert.equal(jasmine.loveRate, 50);
  const sugar = result.optionInsights.find(row => row.key === "糖度");
  assert.equal(sugar.rows.length, 2);
  assert.equal(sugar.rows[0].value, "微糖");
  assert.equal(result.topFans.length, 0, "判拉黑的档案不进本命榜");
  assert.deepEqual(result.avoidWall.map(product => product.name), ["伯牙绝弦"]);
});

test("digest 命令：proposal 校验、删除操作、跨月互不影响", async () => {
  const context = newContext();
  await digest.run(context, { payload: {
    scope: "month", month: "2026-09",
    sections: [{ heading: "九月", body: "桂花系 dominance" }],
    proposals: [{ kind: "ratingLabel", label: "干杯不腻", sentiment: "positive" }],
  } });
  await digest.run(context, { payload: {
    scope: "month", month: "2026-08",
    sections: [{ heading: "八月", body: "踩雷月" }],
  } });

  await assert.rejects(
    digest.run(context, { payload: { scope: "month", month: "2026-09", sections: [{ body: "x" }], proposals: [{ kind: "bad", label: "x" }] } }),
    /proposal\.kind/,
  );
  await assert.rejects(
    digest.run(context, { payload: { scope: "month", month: "2026-9", sections: [{ body: "x" }] } }),
    /month 格式/,
  );

  const listed = await list.run(context, { payload: {} });
  assert.equal(listed.digests.length, 2);
  const august = listed.digests.find(row => row.month === "2026-08");
  const removed = await digest.run(context, { payload: { op: "delete", digestId: august.id } });
  assert.equal(removed.ok, true);
  const after = await list.run(context, { payload: {} });
  assert.equal(after.digests.length, 1);
  assert.equal(after.digests[0].month, "2026-09");
});

test("命令链路：add → list → stats → update → digest（stub context）", async () => {
  const context = newContext();
  const added = await add.run(context, { payload: {
    product: { brand: "霸王茶姬", name: "伯牙绝弦", category: "drink", tags: ["茉莉"] },
    entry: { ratingId: "love", options: { 糖度: "微糖", 冰量: "去冰" }, note: "清冽", price: 18, date: "2026-09-06" },
  } });
  assert.equal(added.ok, true);
  assert.equal(added.product.stamps, 1);

  await add.run(context, { payload: { raw: "刚才那杯桂馥兰香好像一般般" } });
  const listed = await list.run(context, { payload: {} });
  assert.equal(listed.drafts.length, 1);

  const query = await list.run(context, { payload: { query: { tag: "茉莉" } } });
  assert.equal(query.count, 1);
  assert.equal(query.products[0].name, "伯牙绝弦");

  const monthQuery = await list.run(context, { payload: { query: { month: "2026-09" } } });
  assert.equal(monthQuery.count, 1);

  const stat = await stats.run(context, { payload: {} });
  assert.equal(stat.stats.totals.entries, 1);

  const updated = await update.run(context, { payload: { op: "entry", entryId: added.entry.id, patch: { ratingId: "tried", note: "其实还行" } } });
  assert.equal(updated.product.triedCount, 1);

  const resolved = await update.run(context, { payload: {
    op: "resolveDraft",
    draftId: listed.drafts[0].id,
    product: { brand: "霸王茶姬", name: "桂馥兰香", category: "drink", tags: ["桂花"] },
    entry: { ratingId: "tried", options: { 糖度: "正常糖" }, note: "桂花味淡" },
  } });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.pendingDrafts, 0);

  const digested = await digest.run(context, { payload: {
    scope: "month",
    month: "2026-09",
    sections: [{ heading: "九月口味", body: "微糖档表现最佳。" }],
    proposals: [{ kind: "ratingLabel", label: "微糖不腻", sentiment: "positive" }],
  } });
  assert.equal(digested.ok, true);
  const again = await digest.run(context, { payload: {
    scope: "month",
    month: "2026-09",
    sections: [{ heading: "九月口味", body: "修正：桂花系翻车。" }],
  } });
  const after = await list.run(context, { payload: {} });
  assert.equal(after.digests.length, 1, "同月覆盖写回");
  assert.equal(again.digest.sections[0].body.includes("翻车"), true);

  const final = await update.run(context, { payload: { op: "clearAll", confirm: true } });
  assert.equal(final.cleared, true);
  const empty = await list.run(context, { payload: {} });
  assert.equal(empty.products.length, 0);
});
