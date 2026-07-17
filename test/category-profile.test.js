const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCategoryProfile, buildSecondaryCorePlan } = require("../src/services/category-profile");

function feelings(categoryWord, count, importance = 3, startDay = 1) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(`2026-06-${String(startDay).padStart(2, "0")}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index * 2);
    return {
      id: `${categoryWord}-${index}`,
      source_date: date.toISOString().slice(0, 10),
      importance,
      content: `${date.getUTCMonth() + 1}月${date.getUTCDate()}日，上午九点。她认真聊${categoryWord}。`,
    };
  });
}

test("selects the strongest sustained non-relation category as secondary core", () => {
  const features = [
    { id: "r", category: "relation", content: "关系：老公", importance: 5 },
    { id: "w", category: "work", content: "项目：论文", importance: 3 },
    { id: "p", category: "preference", content: "观点：自由", importance: 5 },
  ];
  const rows = [
    ...feelings("老公", 8, 5),
    ...feelings("论文", 5, 3),
    ...feelings("自由", 7, 5),
  ];
  const profile = buildCategoryProfile({ features, feelings: rows });
  assert.equal(profile.primaryCategory, "relation");
  assert.equal(profile.secondaryCategory, "preference");
  const plan = buildSecondaryCorePlan(profile, rows);
  assert.equal(plan.length, 7);
  assert.ok(plan.every(row => row.compressionStyle === "secondary_core"));
});

test("prefers high-information density over a larger ordinary category", () => {
  const profile = buildCategoryProfile({
    features: [
      { id: "h", category: "habit", content: "习惯：熬夜", importance: 3 },
      { id: "w", category: "work", content: "项目：论文", importance: 5 },
    ],
    feelings: [...feelings("熬夜", 12, 3), ...feelings("论文", 6, 5)],
  });
  assert.equal(profile.secondaryCategory, "work");
  assert.equal(profile.categories.find(row => row.category === "work").highImportanceRatio, 1);
});

test("does not let a tiny intense topic replace a sustained secondary core", () => {
  const profile = buildCategoryProfile({
    features: [
      { id: "p", category: "preference", content: "观点：自由", importance: 4 },
      { id: "l", category: "location", content: "地点：上海", importance: 5 },
    ],
    feelings: [...feelings("自由", 30, 4), ...feelings("上海", 2, 5)],
  });
  assert.equal(profile.secondaryCategory, "preference");
});

test("promotes eat for a gourmet whose food feelings are sustained and high-density", () => {
  const profile = buildCategoryProfile({
    features: [
      { id: "e", category: "eat", content: "食物：寿司米", importance: 5 },
      { id: "h", category: "habit", content: "习惯：熬夜", importance: 3 },
    ],
    feelings: [...feelings("寿司米", 10, 5), ...feelings("熬夜", 15, 3)],
  });
  assert.equal(profile.secondaryCategory, "eat");
});

test("does not promote a one-week incidental category", () => {
  const profile = buildCategoryProfile({
    features: [{ id: "e", category: "eat", content: "食物：寿司", importance: 3 }],
    feelings: Array.from({ length: 8 }, (_, index) => ({
      id: `f${index}`, source_date: "2026-06-01", importance: 5, content: "6月1日，晚上。她吃寿司。",
    })),
  });
  assert.equal(profile.secondaryCategory, null);
});

test("a broad term appearing in every feeling contributes no category vote", () => {
  const rows = [
    ...feelings("系统", 6, 5),
    ...feelings("论文", 6, 4, 2),
  ];
  const profile = buildCategoryProfile({
    features: [
      { id: "h", category: "habit", content: "经常使用系统", importance: 3 },
      { id: "w", category: "work", content: "论文项目", importance: 3 },
    ],
    feelings: rows.map(row => ({ ...row, content: `${row.content} 系统` })),
  });
  assert.equal(profile.secondaryCategory, "work");
  assert.equal(profile.categories.find(row => row.category === "habit").feelingCount, 0);
});
