const test = require("node:test");
const assert = require("node:assert/strict");
const { extractTermsFromFeature, extractFeatureTerms } = require("../src/services/feature-phrase-extractor");

test("extracts continuous noun phrases without depending on user gender", () => {
  assert.equal(extractTermsFromFeature({ content: "她喜欢糖醋里脊" }).includes("糖醋里脊"), true);
  assert.equal(extractTermsFromFeature({ content: "他正在写毕业论文" }).includes("毕业论文"), true);
  assert.equal(extractTermsFromFeature({ content: "TA正在维护记忆系统" }).includes("记忆系统"), true);
});

test("extracts content-bearing actions and states without admitting narrative scaffolding", () => {
  const terms = extractTermsFromFeature({ content: "她经常熬夜后点外卖，觉得焦虑" });
  for (const expected of ["熬夜", "外卖", "焦虑"]) assert.equal(terms.includes(expected), true, expected);
  for (const scaffold of ["经常", "觉得"]) assert.equal(terms.includes(scaffold), false, scaffold);
});

test("keeps quoted and private relation vocabulary", () => {
  const terms = extractTermsFromFeature({ content: "他称AI为“老公”，并建立石头人格（糯糯、暗石、石头君等）" });
  for (const expected of ["老公", "糯糯", "暗石", "石头君"]) assert.equal(terms.includes(expected), true, expected);
  assert.equal(terms.some(term => term.toLowerCase() === "ai"), false);
});

test("repairs names that Jieba splits before a title suffix", () => {
  const terms = extractTermsFromFeature({ content: "他和可老师、水母老师一起聊天" });
  assert.equal(terms.includes("可老师"), true);
  assert.equal(terms.includes("水母老师"), true);
});

test("extracts longer relation concepts", () => {
  const terms = extractTermsFromFeature({ content: "她高度重视伴侣的记忆连续性和数据完整性" });
  for (const expected of ["伴侣", "记忆连续性", "数据完整性"]) assert.equal(terms.includes(expected), true, expected);
});

test("deduplicates simplified and traditional forms and merges evidence", () => {
  const terms = extractFeatureTerms([
    { id: "a", category: "relation", content: "她称AI为石头", importance: 2, source_date: "2026-05-01" },
    { id: "b", category: "relation", content: "他稱AI為石頭", importance: 4, source_date: "2026-06-01" },
  ]);
  const stone = terms.find(row => row.normalizedTerm === "石头");
  assert.deepEqual(stone.featureIds, ["a", "b"]);
  assert.equal(stone.importance, 4);
  assert.deepEqual(stone.sourceDates, ["2026-05-01", "2026-06-01"]);
});
