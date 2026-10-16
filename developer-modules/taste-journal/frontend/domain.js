"use strict";

/*
 * 味觉档案领域逻辑（唯一事实源）：浏览器加载为 window.TasteJournalCore，
 * backend/commands 通过 require("../../frontend/domain") 复用同一份。
 * 涉及 fs 的持久化助手只在 Node 侧调用。
 */

const CATEGORIES = [
  { id: "drink", label: "饮品", emoji: "🥤" },
  { id: "dessert", label: "甜品", emoji: "🍰" },
  { id: "takeout", label: "外卖", emoji: "🍜" },
  { id: "other", label: "其他", emoji: "🎁" },
];

const OPTION_KEYS = ["糖度", "冰量", "温度", "茶底", "小料", "规格"];

const DEFAULT_RATING_LABELS = [
  { id: "love", label: "特别喜欢", sentiment: "positive", emoji: "🔥" },
  { id: "tried", label: "尝鲜一次", sentiment: "neutral", emoji: "👀" },
  { id: "avoid", label: "避雷！", sentiment: "negative", emoji: "⛔" },
];

const DEFAULT_TIERS = [
  { count: 1, label: "点头之交" },
  { count: 3, label: "常客" },
  { count: 5, label: "老主顾" },
  { count: 8, label: "本命" },
];

const VERDICT_LABELS = { rebuy: "回购", maybe: "观望", avoid: "拉黑" };
const SENTIMENTS = ["positive", "neutral", "negative"];

function todayStr(now) {
  const date = now instanceof Date ? now : new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function makeId(prefix) {
  const random = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\-—–·・、，,。.（）()'"“”‘’！!？?～~+]/g, "");
}

function fail(message) {
  throw new Error(message);
}

function cleanText(value, field, max, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${field}不能为空`);
    return "";
  }
  const text = String(value).trim().replace(/\s+/g, " ");
  if (required && !text) fail(`${field}不能为空`);
  if (text.length > max) fail(`${field}不能超过 ${max} 个字`);
  return text;
}

function cleanTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("tags 必须是字符串数组");
  const seen = new Set();
  const tags = [];
  for (const item of value.slice(0, 20)) {
    const tag = String(item || "").trim().replace(/\s+/g, "");
    if (!tag || seen.has(tag)) continue;
    if (tag.length > 16) fail("单个口味标签不能超过 16 个字");
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 12) break;
  }
  return tags;
}

function cleanOptions(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail("options 必须是键值对对象");
  const options = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 16)) {
    const key = String(rawKey || "").trim().slice(0, 12);
    const option = String(rawValue ?? "").trim().slice(0, 24);
    if (!key || !option) continue;
    options[key] = option;
    if (Object.keys(options).length >= 12) break;
  }
  return options;
}

function defaultSettings() {
  return {
    ratingLabels: DEFAULT_RATING_LABELS.map(label => ({ ...label })),
    tiers: DEFAULT_TIERS.map(tier => ({ ...tier })),
    showSpend: true,
  };
}

function cloneDefaults() {
  return { version: 1, products: [], entries: [] };
}

function normalizeSettings(settings) {
  const base = defaultSettings();
  if (!settings || typeof settings !== "object") return base;
  const labels = Array.isArray(settings.ratingLabels) && settings.ratingLabels.length
    ? settings.ratingLabels
    : base.ratingLabels;
  const tiers = Array.isArray(settings.tiers) && settings.tiers.length ? settings.tiers : base.tiers;
  return {
    ratingLabels: labels
      .filter(label => label && typeof label === "object")
      .map(label => ({
        id: String(label.id || "").trim() || makeId("rate"),
        label: String(label.label || "").trim().slice(0, 12) || "未命名",
        sentiment: SENTIMENTS.includes(label.sentiment) ? label.sentiment : "neutral",
        emoji: String(label.emoji || "").trim().slice(0, 4),
      })),
    tiers: tiers
      .filter(tier => tier && Number(tier.count) > 0)
      .map(tier => ({ count: Math.floor(Number(tier.count)), label: String(tier.label || "").trim().slice(0, 8) || "常客" }))
      .sort((a, b) => a.count - b.count),
    showSpend: settings.showSpend !== false,
  };
}

function sentimentOf(settings, ratingId) {
  const label = settings.ratingLabels.find(item => item.id === ratingId);
  return label ? label.sentiment : "neutral";
}

function ratingLabelOf(settings, ratingId) {
  return settings.ratingLabels.find(item => item.id === ratingId) || { id: ratingId, label: "未评分", sentiment: "neutral", emoji: "" };
}

function categoryOf(categoryId) {
  return CATEGORIES.find(item => item.id === categoryId) || CATEGORIES[3];
}

function optionSignature(options) {
  const keys = Object.keys(options || {});
  if (!keys.length) return "";
  return keys.sort().map(key => `${key}:${options[key]}`).join("｜");
}

function optionText(options) {
  const keys = Object.keys(options || {});
  if (!keys.length) return "";
  return keys.map(key => options[key]).join("·");
}

/* ---------- 查找与归并 ---------- */

function findProduct(journal, brand, name) {
  const brandKey = normalizeName(brand);
  const nameKey = normalizeName(name);
  if (!brandKey || !nameKey) return { product: null, exact: false, similar: [] };
  let exact = null;
  const similar = [];
  for (const product of journal.products) {
    const productBrand = normalizeName(product.brand);
    const productName = normalizeName(product.name);
    if (productBrand === brandKey && productName === nameKey) {
      exact = product;
      continue;
    }
    if (productBrand === brandKey && (productName.includes(nameKey) || nameKey.includes(productName))) {
      similar.push(product);
    }
  }
  return { product: exact || null, exact: Boolean(exact), similar };
}

/* ---------- 新增 ---------- */

function applyAdd(journal, settings, payload, { today, source } = {}) {
  if (!payload || typeof payload !== "object") fail("缺少记录内容");
  if (payload.raw !== undefined) {
    const raw = cleanText(payload.raw, "原话片段", 500);
    return { draft: { id: makeId("d"), raw, receivedAt: new Date().toISOString(), source: source || "ai" } };
  }
  const productInput = payload.product && typeof payload.product === "object" ? payload.product : fail("缺少 product 信息");
  const entryInput = payload.entry && typeof payload.entry === "object" ? payload.entry : {};
  const brand = cleanText(productInput.brand, "品牌", 40);
  const name = cleanText(productInput.name, "品名", 60);
  const categoryId = CATEGORIES.some(item => item.id === productInput.category) ? productInput.category : "other";
  const ratingId = entryInput.ratingId
    ? (settings.ratingLabels.some(label => label.id === entryInput.ratingId) ? entryInput.ratingId : fail(`未知评分：${entryInput.ratingId}`))
    : "tried";
  const date = entryInput.date ? requireDate(entryInput.date, today) : today;
  const price = normalizePrice(entryInput.price);
  const note = cleanText(entryInput.note, "短评", 140, { required: false });

  const found = findProduct(journal, brand, name);
  let product = found.product;
  if (!product) {
    product = {
      id: makeId("p"),
      brand,
      name,
      category: categoryId,
      tags: cleanTags(productInput.tags),
      verdictOverride: null,
      createdAt: new Date().toISOString(),
    };
    journal.products.push(product);
  } else {
    const mergedTags = cleanTags([...(product.tags || []), ...(productInput.tags || [])]);
    product.tags = mergedTags;
    if (productInput.category && CATEGORIES.some(item => item.id === productInput.category)) {
      product.category = productInput.category;
    }
  }

  // “老样子”：完全没提 options 时沿用该产品上一次的配置；显式给了（哪怕为空）就尊重原样。
  let options = cleanOptions(entryInput.options);
  if (!Object.keys(options).length && entryInput.options === undefined) {
    const lastMine = journal.entries
      .filter(entry => entry.productId === product.id)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || "").localeCompare(a.createdAt || "")));
    if (lastMine.length) options = { ...(lastMine[0].options || {}) };
  }

  const entry = {
    id: makeId("e"),
    productId: product.id,
    date,
    options,
    ratingId,
    note,
    price,
    source: source === "ai" || source === "manual" ? source : "ai",
    createdAt: new Date().toISOString(),
  };
  journal.entries.push(entry);
  return { product, entry, similar: found.exact ? [] : found.similar.map(item => ({ id: item.id, brand: item.brand, name: item.name })) };
}

function requireDate(value, today) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail("日期格式必须是 YYYY-MM-DD");
  if (text > `${Number(today.slice(0, 4)) + 1}-12-31`) fail("日期看起来太远了");
  return text;
}

function normalizePrice(value) {
  if (value === undefined || value === null || value === "") return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 9999) fail("价格需要在 0-9999 之间");
  return Math.round(price * 10) / 10;
}

/* ---------- 档案卡汇总（集章 / 回购判定 / 配置分歧 / 点单口诀） ---------- */

function rollupProduct(product, entries, settings) {
  const mine = entries
    .filter(entry => entry.productId === product.id)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || "").localeCompare(b.createdAt || "")));
  const count = mine.length;
  let loveCount = 0;
  let triedCount = 0;
  let avoidCount = 0;
  for (const entry of mine) {
    const sentiment = sentimentOf(settings, entry.ratingId);
    if (sentiment === "positive") loveCount += 1;
    else if (sentiment === "negative") avoidCount += 1;
    else triedCount += 1;
  }

  const tier = [...settings.tiers].reverse().find(item => count >= item.count) || null;

  let bestGroup = null;
  const groups = new Map();
  for (const entry of mine) {
    const signature = optionSignature(entry.options) || "（默认配置）";
    if (!groups.has(signature)) groups.set(signature, { signature, options: entry.options || {}, entries: [] });
    groups.get(signature).entries.push(entry);
  }
  for (const group of groups.values()) {
    const love = group.entries.filter(entry => sentimentOf(settings, entry.ratingId) === "positive").length;
    const avoid = group.entries.filter(entry => sentimentOf(settings, entry.ratingId) === "negative").length;
    group.love = love;
    group.avoid = avoid;
    group.count = group.entries.length;
    const best = group.entries
      .filter(entry => entry.note)
      .sort((a, b) => (sentimentOf(settings, a.ratingId) === "positive" ? -1 : 1))[0];
    group.topNote = best ? best.note : "";
    const score = love * 2 + group.count - avoid * 2;
    if (!bestGroup || score > bestGroup.score) bestGroup = { ...group, score };
  }

  // 配置分歧：同一维度的不同取值出现了“有特别喜欢、也有避雷”的对立。
  const divergences = [];
  const keySet = new Set();
  for (const group of groups.values()) {
    for (const key of Object.keys(group.options || {})) keySet.add(key);
  }
  for (const key of keySet) {
    const rows = [];
    for (const group of groups.values()) {
      const value = (group.options || {})[key];
      if (!value) continue;
      const existing = rows.find(row => row.value === value);
      if (existing) {
        existing.count += group.count;
        existing.love += group.love;
        existing.avoid += group.avoid;
        continue;
      }
      rows.push({ value, count: group.count, love: group.love, avoid: group.avoid });
    }
    if (rows.length >= 2 && rows.some(row => row.love > 0) && rows.some(row => row.avoid > 0)) {
      divergences.push({ key, rows: rows.sort((a, b) => b.love - a.love || b.count - a.count) });
    }
  }

  const bestOptions = bestGroup ? bestGroup.options || {} : {};
  let autoLevel;
  if (count === 0) autoLevel = "maybe";
  else if (avoidCount > 0 && avoidCount >= loveCount) autoLevel = "avoid";
  else if (loveCount > 0) autoLevel = "rebuy";
  else autoLevel = "maybe";
  const autoNote = autoLevel === "rebuy" && bestGroup && Object.keys(bestOptions).length ? `点${optionText(bestOptions)}` : "";
  const verdict = product.verdictOverride || { level: autoLevel, note: autoNote, auto: true };

  return {
    id: product.id,
    brand: product.brand,
    name: product.name,
    category: product.category,
    tags: product.tags || [],
    count,
    loveCount,
    triedCount,
    avoidCount,
    lastDate: mine.length ? mine[mine.length - 1].date : null,
    lastNote: mine.length ? mine[mine.length - 1].note || "" : "",
    stamps: count,
    tier: tier ? { count: tier.count, label: tier.label } : null,
    verdict,
    bestOptions,
    bestNote: bestGroup ? bestGroup.topNote : "",
    orderHint: verdict.level === "rebuy" && Object.keys(bestOptions).length ? `下次这么点：${optionText(bestOptions)}` : "",
    divergences,
  };
}

/* ---------- 全局统计 ---------- */

function buildStats(journal, settings, { today } = {}) {
  const monthMap = new Map();
  const tagMap = new Map();
  const optionKeyMap = new Map();
  const spendIgnore = !settings.showSpend;
  let spendTotal = 0;
  let loveTotal = 0;
  let avoidTotal = 0;

  for (const entry of journal.entries) {
    const month = entry.date.slice(0, 7);
    if (!monthMap.has(month)) monthMap.set(month, { month, count: 0, spend: 0, love: 0, avoid: 0, newProducts: new Set() });
    const bucket = monthMap.get(month);
    bucket.count += 1;
    if (!spendIgnore && entry.price) bucket.spend += entry.price;
    const sentiment = sentimentOf(settings, entry.ratingId);
    if (sentiment === "positive") {
      bucket.love += 1;
      loveTotal += 1;
    } else if (sentiment === "negative") {
      bucket.avoid += 1;
      avoidTotal += 1;
    }

    const product = journal.products.find(item => item.id === entry.productId);
    if (product) {
      const firstDate = journal.entries
        .filter(item => item.productId === product.id)
        .reduce((min, item) => (item.date < min ? item.date : min), entry.date);
      if (firstDate === entry.date) bucket.newProducts.add(product.id);
      for (const tag of product.tags || []) {
        if (!tagMap.has(tag)) tagMap.set(tag, { tag, count: 0, love: 0 });
        const tagBucket = tagMap.get(tag);
        tagBucket.count += 1;
        if (sentiment === "positive") tagBucket.love += 1;
      }
    }

    for (const [key, value] of Object.entries(entry.options || {})) {
      if (!optionKeyMap.has(key)) optionKeyMap.set(key, new Map());
      const valueMap = optionKeyMap.get(key);
      if (!valueMap.has(value)) valueMap.set(value, { value, count: 0, love: 0 });
      const valueBucket = valueMap.get(value);
      valueBucket.count += 1;
      if (sentiment === "positive") valueBucket.love += 1;
    }
  }

  if (!spendIgnore) {
    for (const entry of journal.entries) spendTotal += entry.price || 0;
  }

  const rollups = journal.products.map(product => rollupProduct(product, journal.entries, settings));
  const topFans = rollups
    .filter(item => item.count >= 2 && item.verdict.level !== "avoid")
    .sort((a, b) => b.count - a.count || b.loveCount - a.loveCount)
    .slice(0, 5);
  const avoidWall = rollups
    .filter(item => item.avoidCount > 0 && item.verdict.level === "avoid")
    .sort((a, b) => b.avoidCount - a.avoidCount)
    .slice(0, 8);
  const rebuyPool = rollups.filter(item => item.verdict.level === "rebuy" && item.count > 0);
  const freshPool = rollups.filter(item => item.count <= 1 && item.verdict.level !== "avoid");

  const optionInsights = [];
  for (const [key, valueMap] of optionKeyMap) {
    const rows = [...valueMap.values()];
    if (rows.length < 2 || rows.reduce((sum, row) => sum + row.count, 0) < 3) continue;
    optionInsights.push({ key, rows: rows.sort((a, b) => b.count - a.count) });
  }

  const months = [...monthMap.values()]
    .map(bucket => ({ ...bucket, spend: Math.round(bucket.spend * 10) / 10, newProducts: bucket.newProducts.size }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));

  return {
    today,
    totals: {
      products: journal.products.length,
      entries: journal.entries.length,
      love: loveTotal,
      avoid: avoidTotal,
      spend: settings.showSpend ? Math.round(spendTotal * 10) / 10 : null,
    },
    months,
    tags: [...tagMap.values()].map(row => ({ ...row, loveRate: row.count ? Math.round((row.love / row.count) * 100) : 0 })).sort((a, b) => b.count - a.count),
    optionInsights,
    topFans,
    avoidWall,
    pools: { rebuy: rebuyPool.map(item => item.id), fresh: freshPool.map(item => item.id) },
    recent: journal.entries
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || "").localeCompare(a.createdAt || "")))
      .slice(0, 12)
      .map(entry => {
        const product = journal.products.find(item => item.id === entry.productId);
        return {
          id: entry.id,
          date: entry.date,
          productId: entry.productId,
          brand: product ? product.brand : "",
          name: product ? product.name : "",
          category: product ? product.category : "other",
          ratingId: entry.ratingId,
          note: entry.note,
          options: entry.options || {},
        };
      }),
  };
}

/* ---------- 更新操作 ---------- */

function applyUpdate(journal, settings, payload, { today } = {}) {
  const op = payload && typeof payload === "object" ? payload.op : fail("缺少 update 操作");
  switch (op) {
    case "entry": {
      const entry = journal.entries.find(item => item.id === payload.entryId) || fail("找不到这条记录");
      const patch = payload.patch || {};
      if (patch.date !== undefined) entry.date = requireDate(patch.date, today);
      if (patch.ratingId !== undefined) {
        if (!settings.ratingLabels.some(label => label.id === patch.ratingId)) fail("未知评分");
        entry.ratingId = patch.ratingId;
      }
      if (patch.options !== undefined) entry.options = cleanOptions(patch.options);
      if (patch.note !== undefined) entry.note = cleanText(patch.note, "短评", 140, { required: false });
      if (patch.price !== undefined) entry.price = normalizePrice(patch.price);
      return { entryId: entry.id, productId: entry.productId };
    }
    case "deleteEntry": {
      const index = journal.entries.findIndex(item => item.id === payload.entryId);
      if (index < 0) fail("找不到这条记录");
      const [entry] = journal.entries.splice(index, 1);
      return { deletedEntryId: entry.id, productId: entry.productId };
    }
    case "product": {
      const product = journal.products.find(item => item.id === payload.productId) || fail("找不到档案卡");
      const patch = payload.patch || {};
      if (patch.brand !== undefined) product.brand = cleanText(patch.brand, "品牌", 40);
      if (patch.name !== undefined) product.name = cleanText(patch.name, "品名", 60);
      if (patch.category !== undefined) {
        if (!CATEGORIES.some(item => item.id === patch.category)) fail("未知品类");
        product.category = patch.category;
      }
      if (patch.tags !== undefined) product.tags = cleanTags(patch.tags);
      if (patch.verdictOverride !== undefined) {
        if (patch.verdictOverride === null) product.verdictOverride = null;
        else {
          if (!VERDICT_LABELS[patch.verdictOverride.level]) fail("未知回购判定");
          product.verdictOverride = {
            level: patch.verdictOverride.level,
            note: cleanText(patch.verdictOverride.note, "判定备注", 40, { required: false }),
          };
        }
      }
      return { productId: product.id };
    }
    case "deleteProduct": {
      const index = journal.products.findIndex(item => item.id === payload.productId);
      if (index < 0) fail("找不到档案卡");
      const [product] = journal.products.splice(index, 1);
      journal.entries = journal.entries.filter(entry => entry.productId !== product.id);
      return { deletedProductId: product.id };
    }
    case "merge": {
      const from = journal.products.find(item => item.id === payload.fromProductId) || fail("找不到要合并的档案卡");
      const into = journal.products.find(item => item.id === payload.intoProductId) || fail("找不到目标档案卡");
      if (from.id === into.id) fail("不能合并到同一张卡");
      for (const entry of journal.entries) {
        if (entry.productId === from.id) entry.productId = into.id;
      }
      into.tags = cleanTags([...(into.tags || []), ...(from.tags || [])]);
      journal.products = journal.products.filter(item => item.id !== from.id);
      return { mergedIntoId: into.id, removedId: from.id };
    }
    case "settings": {
      const patch = payload.patch || {};
      if (patch.showSpend !== undefined) settings.showSpend = patch.showSpend === true;
      if (patch.tiers !== undefined) {
        if (!Array.isArray(patch.tiers) || !patch.tiers.length) fail("集章档位不能为空");
        const tiers = patch.tiers
          .map(tier => ({ count: Math.floor(Number(tier.count)), label: String(tier.label || "").trim().slice(0, 8) }))
          .filter(tier => tier.count > 0 && tier.label);
        if (!tiers.length) fail("集章档位格式不对");
        settings.tiers = tiers.sort((a, b) => a.count - b.count);
      }
      if (patch.addRatingLabel !== undefined) {
        const label = patch.addRatingLabel || {};
        const text = cleanText(label.label, "评分档名", 12);
        if (!SENTIMENTS.includes(label.sentiment)) fail("评分档极性必须是 positive/neutral/negative");
        if (settings.ratingLabels.some(item => item.label === text)) fail("已经有同名的评分档了");
        settings.ratingLabels.push({ id: makeId("rate"), label: text, sentiment: label.sentiment, emoji: String(label.emoji || "").trim().slice(0, 4) });
      }
      if (patch.removeRatingLabel !== undefined) {
        const inUse = journal.entries.filter(entry => entry.ratingId === patch.removeRatingLabel).length;
        if (inUse > 0 && payload.force !== true) fail(`这个档位还有 ${inUse} 条记录在用，确认后会把它们改成“尝鲜一次”`);
        for (const entry of journal.entries) {
          if (entry.ratingId === patch.removeRatingLabel) entry.ratingId = "tried";
        }
        settings.ratingLabels = settings.ratingLabels.filter(label => label.id !== patch.removeRatingLabel);
        if (!settings.ratingLabels.length) settings.ratingLabels = defaultSettings().ratingLabels;
      }
      return { settings };
    }
    default:
      fail(`未知操作：${op}`);
      return {};
  }
}

/* ---------- 查询过滤（AI list 用） ---------- */

function filterEntries(journal, query) {
  if (!query || typeof query !== "object") return journal.entries;
  return journal.entries.filter(entry => {
    const product = journal.products.find(item => item.id === entry.productId);
    if (query.productId && entry.productId !== query.productId) return false;
    if (query.month && entry.date.slice(0, 7) !== query.month) return false;
    if (query.brand && (!product || normalizeName(product.brand) !== normalizeName(query.brand))) return false;
    if (query.tag && (!product || !(product.tags || []).includes(query.tag))) return false;
    return true;
  });
}

/* ---------- Node 侧持久化助手（浏览器不调用） ---------- */

function nodeFs() {
  if (typeof require !== "function") return null;
  try {
    return require("fs");
  } catch {
    return null;
  }
}

function readDataFile(context, name, fallback) {
  const fs = nodeFs();
  const file = context.resolveDataPath(name);
  if (!fs.existsSync(file)) return fallback();
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback();
  }
}

function writeDataFile(context, name, data) {
  const fs = nodeFs();
  const path = require("path");
  const file = context.resolveDataPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

function loadJournal(context) {
  return readDataFile(context, "journal.json", cloneDefaults);
}

function saveJournal(context, journal) {
  writeDataFile(context, "journal.json", journal);
}

function loadSettings(context) {
  const settings = readDataFile(context, "settings.json", () => null);
  const normalized = normalizeSettings(settings);
  const raw = settings || {};
  return { ...normalized, showSpend: raw.showSpend !== undefined ? raw.showSpend !== false : true };
}

function saveSettings(context, settings) {
  writeDataFile(context, "settings.json", settings);
}

function loadDigests(context) {
  return readDataFile(context, "digests.json", () => []);
}

function saveDigests(context, digests) {
  writeDataFile(context, "digests.json", digests);
}

function loadDrafts(context) {
  return readDataFile(context, "drafts.json", () => []);
}

function saveDrafts(context, drafts) {
  writeDataFile(context, "drafts.json", drafts);
}

const coreExports = {
  CATEGORIES,
  OPTION_KEYS,
  DEFAULT_RATING_LABELS,
  DEFAULT_TIERS,
  VERDICT_LABELS,
  SENTIMENTS,
  todayStr,
  makeId,
  normalizeName,
  normalizeSettings,
  defaultSettings,
  cloneDefaults,
  sentimentOf,
  ratingLabelOf,
  categoryOf,
  optionSignature,
  optionText,
  findProduct,
  applyAdd,
  applyUpdate,
  rollupProduct,
  buildStats,
  filterEntries,
  loadJournal,
  saveJournal,
  loadSettings,
  saveSettings,
  loadDigests,
  saveDigests,
  loadDrafts,
  saveDrafts,
};

if (typeof module === "object" && module.exports) {
  module.exports = coreExports;
} else if (typeof window !== "undefined") {
  window.TasteJournalCore = coreExports;
}
