const test = require("node:test");
const assert = require("node:assert/strict");
const { buildHiddenPlan } = require("../src/services/hidden-plan");

function feeling(overrides = {}) {
  return { id: "book", source_date: "2026-01-01", summary_mode: "coarse", importance: 3,
    content: "1月1日，晚上九点。她说想看《小王子》。",
    coarse_summary: "1月1日，晚上九点。她想看《小王子》。", coarse_terms: '["小王子"]', ...overrides };
}

test("hides an ordinary coarse fact when every core term has been silent long enough", () => {
  const plan = buildHiddenPlan({ feelings: [feeling()], messages: [
    { type: "user", sourceDate: "2026-01-01", text: "我们以后看小王子" },
    { type: "user", sourceDate: "2026-05-01", text: "今天聊别的" },
  ], afterDays: 90 });
  assert.equal(plan.decisions[0].action, "hide");
  assert.equal(plan.decisions[0].evidence[0].idleDays, 120);
});

test("keeps coarse when a core term was mentioned recently", () => {
  const plan = buildHiddenPlan({ feelings: [feeling()], messages: [
    { type: "user", sourceDate: "2026-04-20", text: "今天终于看了小王子" },
    { type: "user", sourceDate: "2026-05-01", text: "今天聊别的" },
  ], afterDays: 90 });
  assert.equal(plan.decisions[0].action, "keep_coarse");
});

test("never auto-hides anchors, relation, high importance, or legacy coarse without terms", () => {
  const rows = [
    feeling({ id: "anchor" }),
    feeling({ id: "relation", content: "1月1日，晚上九点。她叫我老公。", coarse_terms: '["老公"]' }),
    feeling({ id: "important", importance: 5 }),
    feeling({ id: "legacy", coarse_terms: null }),
  ];
  const plan = buildHiddenPlan({
    features: [{ id: "r", category: "relation", content: "称呼老公", importance: 5 }],
    feelings: rows,
    messages: [
      { type: "user", sourceDate: "2026-01-01", text: "小王子 老公" },
      { type: "user", sourceDate: "2026-05-01", text: "别的" },
    ],
    anchors: { eventAnchors: { anchor: true } }, afterDays: 90,
  });
  assert.ok(plan.decisions.every(row => row.action === "keep_coarse"));
});

test("does not auto-hide the current sustained secondary core", () => {
  const rows = Array.from({ length: 6 }, (_, index) => feeling({
    id: `philosophy-${index}`,
    source_date: `2026-01-${String(1 + index * 3).padStart(2, "0")}`,
    importance: 5,
    content: `${1 + index * 3}月1日，晚上九点。她讨论存在主义。`,
    coarse_terms: '["存在主义"]',
  }));
  const background = Array.from({ length: 6 }, (_, index) => ({
    id: `sleep-${index}`, source_date: `2026-02-${String(1 + index * 3).padStart(2, "0")}`,
    summary_mode: "daily", importance: 3, content: "2月1日，晚上十一点。她又熬夜了。",
  }));
  const plan = buildHiddenPlan({
    features: [
      { id: "p", category: "preference", content: "她重视存在主义", importance: 5 },
      { id: "s", category: "sleep", content: "她经常熬夜", importance: 3 },
    ],
    feelings: [...rows, ...background],
    messages: [
      { type: "user", sourceDate: "2026-01-01", text: "今天聊存在主义" },
      { type: "user", sourceDate: "2026-05-01", text: "今天聊别的" },
    ], afterDays: 90,
  });
  assert.equal(plan.secondaryCategory, "preference");
  assert.ok(plan.decisions.every(row => row.action === "keep_coarse"));
});
