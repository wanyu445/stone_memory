const { Jieba } = require("@node-rs/jieba");
const { dict } = require("@node-rs/jieba/dict");
const OpenCC = require("opencc-js");

const jieba = Jieba.withDict(dict);
const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });

const STOP_TERMS = new Set([
  "她", "他", "它", "祂", "ta", "TA", "自己", "本人", "用户", "使用者", "对方", "别人", "其他人",
  "一个", "一种", "一些", "东西", "事情", "方面", "相关", "内容", "时候", "期间", "现在", "之前", "之后",
  "喜欢", "觉得", "认为", "希望", "需要", "主动", "容易", "进行", "非常", "比较", "已经", "一直", "ai", "AI",
]);
const NOUN_TAGS = new Set(["n", "nr", "ns", "nt", "nz", "vn", "eng"]);
const TITLE_SUFFIXES = new Set(["老师", "先生", "女士", "姐姐", "妹妹", "哥哥", "弟弟", "医生", "博士", "教授"]);
const TITLE_PREFIX_BLOCKLIST = new Set(["她", "他", "我", "你", "喜欢", "讨厌", "称呼", "一个"]);

function extractTermsFromFeature(feature) {
  const content = String(feature?.content || "").trim();
  if (!content) return [];
  const analysisContent = toSimplified(content);
  const candidates = new Set();

  extractMarkedSpans(analysisContent, candidates);
  extractTaggedTerms(analysisContent, candidates);

  return [...candidates]
    .map(cleanTerm)
    .filter(isUsefulTerm)
    .filter((term, index, rows) => rows.findIndex(other => normalizeTerm(other) === normalizeTerm(term)) === index);
}

function extractMarkedSpans(content, candidates) {
  for (const match of content.matchAll(/[“”"'「」『』]([^“”"'「」『』]{1,40})[“”"'「」『』]/gu)) {
    for (const part of splitMarkedList(match[1])) candidates.add(part);
  }
  for (const match of content.matchAll(/[（(]([^（）()]{1,60})[）)]/gu)) {
    for (const part of splitMarkedList(match[1])) candidates.add(part);
  }
}

function splitMarkedList(value) {
  return String(value).split(/[、,，/]|(?:和|或)/gu).map(part => cleanTerm(part).replace(/等$/u, "")).filter(Boolean);
}

function extractTaggedTerms(content, candidates) {
  const tagged = jieba.tag(content);
  extractTitleTerms(tagged, candidates);
  let chunk = [];
  const flush = () => {
    if (!chunk.length) return;
    const firstNoun = chunk.findIndex(isNounToken);
    if (firstNoun >= 0) {
      const useful = chunk.slice(firstNoun);
      const whole = joinTokens(useful);
      if (useful.length > 1 && whole.length <= 20) candidates.add(whole);
      for (const token of useful) {
        if (isNounToken(token) && token.word.length >= 2) candidates.add(token.word);
      }
    }
    chunk = [];
  };

  for (const token of tagged) {
    if (isNounToken(token)) chunk.push(token);
    else if (token.tag === "x" && /^\s+$/u.test(token.word) && chunk.length && chunk.every(row => row.tag === "eng")) chunk.push(token);
    else flush();
  }
  flush();
}

function extractTitleTerms(tagged, candidates) {
  for (let i = 1; i < tagged.length; i++) {
    const suffix = tagged[i];
    const prefix = tagged[i - 1];
    if (!TITLE_SUFFIXES.has(suffix.word) || TITLE_PREFIX_BLOCKLIST.has(prefix.word)) continue;
    if (prefix.tag === "x" || prefix.tag === "p" || prefix.tag === "c" || prefix.tag === "r" || prefix.word.length > 8) continue;
    candidates.add(`${prefix.word}${suffix.word}`);
  }
}

function isNounToken(token) {
  return NOUN_TAGS.has(token.tag) || (token.tag === "l" && /(?:性|感|力|权|度|边界|关系|状态)$/u.test(token.word));
}

function joinTokens(tokens) {
  return tokens.map(token => token.word).join("").replace(/\s+/gu, " ").trim();
}

function cleanTerm(value) {
  return String(value || "").replace(/^[的地得]+|[的地得]$/gu, "").replace(/[。！？；：]+$/gu, "").trim();
}

function normalizeTerm(term) {
  return toSimplified(String(term || "")).toLowerCase().replace(/\s+/gu, " ").trim();
}

function isUsefulTerm(term) {
  const value = cleanTerm(term);
  const normalized = normalizeTerm(value);
  if (!normalized || normalized.length < 2 || normalized.length > 40) return false;
  if (STOP_TERMS.has(value) || STOP_TERMS.has(normalized)) return false;
  if (/^[\d\s]+$/u.test(normalized)) return false;
  return true;
}

function extractFeatureTerms(features, categories = null) {
  const selected = categories ? new Set(categories) : null;
  const terms = new Map();
  for (const feature of features) {
    if (selected && !selected.has(feature.category)) continue;
    for (const term of extractTermsFromFeature(feature)) {
      const normalizedTerm = normalizeTerm(term);
      const key = `${feature.category}\0${normalizedTerm}`;
      if (!terms.has(key)) terms.set(key, {
        term,
        normalizedTerm,
        category: feature.category,
        featureIds: [],
        importance: null,
        sourceDates: [],
      });
      const row = terms.get(key);
      if (feature.id && !row.featureIds.includes(feature.id)) row.featureIds.push(feature.id);
      const sourceDate = feature.source_date || feature.sourceDate;
      if (sourceDate && !row.sourceDates.includes(sourceDate)) row.sourceDates.push(sourceDate);
      if (feature.importance != null) row.importance = Math.max(row.importance ?? 0, Number(feature.importance));
    }
  }
  return [...terms.values()].sort((a, b) => a.category.localeCompare(b.category) || a.term.localeCompare(b.term, "zh-CN"));
}

module.exports = { STOP_TERMS, extractTermsFromFeature, extractFeatureTerms, normalizeTerm, isUsefulTerm };
