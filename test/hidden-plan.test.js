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

test("a relation word does not block hidden after relation yields a low-importance fact", () => {
  const row = feeling({ content: "1月1日，晚上九点。老公叫她点糖醋排骨。",
    coarse_summary: "1月1日，晚上九点。她点了糖醋排骨。", coarse_terms: '["糖醋排骨"]' });
  const plan = buildHiddenPlan({
    features: [
      { id: "r", category: "relation", content: "她称 AI 为老公", importance: 5 },
      { id: "e", category: "eat", content: "她吃糖醋排骨", importance: 3 },
    ], feelings: [row], messages: [
      { type: "user", sourceDate: "2026-01-01", text: "老公，点糖醋排骨" },
      { type: "user", sourceDate: "2026-05-01", text: "今天聊别的" },
    ], afterDays: 90,
  });
  assert.equal(plan.decisions[0].action, "hide");
});

test("stable relation identity terms are ignored as dormancy evidence for an ordinary fact", () => {
  const row = feeling({ content: "1月1日，晚上九点。她拿 Grok 和老公比较。",
    coarse_summary: "1月1日，晚上九点。她拿 Grok 和老公比较。", coarse_terms: '["Grok","老公"]' });
  const plan = buildHiddenPlan({
    features: [{ id: "r", category: "relation", content: "她称 AI 为老公", importance: 5 }],
    feelings: [row], messages: [
      { type: "user", sourceDate: "2026-01-01", text: "Grok 和老公不一样" },
      { type: "user", sourceDate: "2026-05-01", text: "老公今天在吗" },
    ], afterDays: 90,
  });
  assert.equal(plan.decisions[0].action, "hide");
  assert.deepEqual(plan.decisions[0].evidence.map(item => item.term), ["Grok"]);
});

test("never auto-hides anchors, relation, high importance, or legacy coarse without terms", () => {
  const rows = [
    feeling({ id: "anchor" }),
    feeling({ id: "relation", importance: 5, content: "1月1日，晚上九点。她叫我老公。", coarse_terms: '["老公"]' }),
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

test("secondary core hides an old line only after a new high-information line displaces it", () => {
  const oldRows = [0, 1].map(index => feeling({ id: `old-${index}`, source_date: `2026-01-0${index + 1}`,
    importance: 5, content: "1月1日，晚上九点。她研究存在主义。", coarse_terms: '["存在主义"]' }));
  const newRows = [
    ["new-1", "2026-03-01"], ["new-2", "2026-03-02"], ["new-3", "2026-03-02"],
  ].map(([id, date]) => feeling({ id, source_date: date, importance: 5,
    content: "3月1日，晚上九点。她开始持续研究斯多葛主义。", coarse_terms: '["斯多葛主义"]' }));
  const plan = buildHiddenPlan({
    features: [
      { id: "old-feature", category: "preference", content: "她思考存在主义", importance: 5 },
      { id: "new-feature", category: "preference", content: "她思考斯多葛主义", importance: 5 },
      { id: "sleep-feature", category: "sleep", content: "她经常熬夜", importance: 3 },
    ],
    feelings: [...oldRows, ...newRows, ...Array.from({ length: 5 }, (_, index) => ({
      id: `background-${index}`, source_date: `2026-02-0${index + 1}`, summary_mode: "daily",
      importance: 3, content: "2月1日，晚上十一点。她又熬夜了。",
    }))],
    messages: [
      { type: "user", sourceDate: "2026-01-01", text: "存在主义很有意思" },
      { type: "user", sourceDate: "2026-03-01", text: "开始看斯多葛主义" },
      { type: "user", sourceDate: "2026-03-02", text: "继续聊斯多葛主义" },
    ],
  });
  assert.equal(plan.secondaryCategory, "preference");
  assert.ok(plan.decisions.filter(row => row.feelingId.startsWith("old-")).every(row => row.action === "hide"));
  assert.ok(plan.decisions.filter(row => row.feelingId.startsWith("new-")).every(row => row.action === "keep_coarse"));
});

test("secondary core keeps the old line when no replacement line has stood up", () => {
  const rows = [0, 1, 2, 3, 4].map(index => feeling({ id: `old-${index}`,
    source_date: index ? "2026-01-08" : "2026-01-01", importance: 5,
    content: "1月1日，晚上九点。她研究存在主义。", coarse_terms: '["存在主义"]' }));
  const background = Array.from({ length: 5 }, (_, index) => ({ id: `sleep-${index}`,
    source_date: `2026-02-${String(1 + index * 3).padStart(2, "0")}`, summary_mode: "daily",
    importance: 3, content: "2月1日，晚上十一点。她又熬夜了。" }));
  const profilePlan = buildHiddenPlan({
    features: [
      { id: "p", category: "preference", content: "她思考存在主义", importance: 5 },
      { id: "s", category: "sleep", content: "她经常熬夜", importance: 3 },
    ], feelings: [...rows, ...background], messages: [
      { type: "user", sourceDate: "2026-01-01", text: "存在主义" },
      { type: "user", sourceDate: "2026-06-01", text: "最近没聊工作或哲学" },
    ] });
  assert.equal(profilePlan.secondaryCategory, "preference");
  assert.ok(profilePlan.decisions.every(row => row.action !== "hide"));
});
