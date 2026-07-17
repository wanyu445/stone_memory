const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTermTimeline, buildCooccurrenceSignatures } = require("../src/services/term-timeline");
const { buildWorkLifecycles } = require("../src/services/work-lifecycle");

test("builds work signatures only from repeated feeling co-occurrence", () => {
  const messages = [
    { date: "2026-04-16", timestamp: "2026-04-16T08:00:00Z", text: "把开题报告缝进论文，先赶小论文" },
    { date: "2026-06-20", timestamp: "2026-06-20T08:00:00Z", text: "准备毕设中期检查" },
    { date: "2026-07-01", timestamp: "2026-07-01T15:44:00Z", text: "还要做学术海报" },
    { date: "2026-07-02", timestamp: "2026-07-01T16:06:00Z", text: "中期检查后继续论文" },
  ];
  const terms = ["开题报告", "小论文", "论文", "毕设", "中期检查", "学术海报"];
  const feelings = messages.map((row, index) => ({ id: `work-${index}`, source_date: row.date, importance: 3, content: row.text }));
  feelings.push({ id: "work-bridge", source_date: "2026-07-03", importance: 3, content: "中期检查材料继续沿用论文" });
  feelings.push(
    { id: "project-signature-1", source_date: "2026-07-01", importance: 3, content: "开题报告小论文论文毕设中期检查学术海报是同一毕业项目" },
    { id: "project-signature-2", source_date: "2026-07-02", importance: 3, content: "开题报告小论文论文毕设中期检查学术海报依次推进" },
  );
  const timelines = buildTermTimeline({ requestedTerms: terms, extractedTerms: [
    { normalizedTerm: "开题报告", category: "work", featureIds: ["project"] },
    { normalizedTerm: "论文", category: "work", featureIds: ["project"] },
    { normalizedTerm: "小论文", category: "work", featureIds: ["project"] },
    { normalizedTerm: "毕设", category: "work", featureIds: ["project"] },
    { normalizedTerm: "中期检查", category: "work", featureIds: ["project"] },
    { normalizedTerm: "学术海报", category: "work", featureIds: ["project"] },
  ], messages, feelings });
  const intersections = buildCooccurrenceSignatures({ termTimelines: timelines, messages, feelings });
  const work = buildWorkLifecycles({ termTimelines: timelines, intersections });
  assert.equal(work.links.length > 0, true);
  assert.equal(work.links.every(link => link.sameDays >= 2), true);
  assert.equal(work.groups.every(group => group.members.length <= terms.length), true);
});

test("excludes archive-only work terms until they appear in feelings", () => {
  const messages = [
    { date: "2026-06-20", timestamp: "2026-06-20T08:00:00Z", text: "完成中期检查" },
    { date: "2026-07-01", timestamp: "2026-07-01T08:00:00Z", text: "准备学术海报" },
  ];
  const feelings = [{ id: "midterm", source_date: "2026-06-20", importance: 3, content: "完成中期检查" }];
  const timelines = buildTermTimeline({
    requestedTerms: ["中期检查", "学术海报"],
    extractedTerms: [
      { normalizedTerm: "中期检查", category: "work", featureIds: ["project"] },
      { normalizedTerm: "学术海报", category: "work", featureIds: ["project"] },
    ], messages, feelings,
  });
  const work = buildWorkLifecycles({ termTimelines: timelines, intersections: [] });
  assert.deepEqual(work.terms.map(row => row.term), ["中期检查"]);
});

test("does not merge work terms from a single incidental feeling", () => {
  const feelings = [{ id: "once", source_date: "2026-06-01", importance: 3, content: "部署系统时顺便改论文" }];
  const timelines = buildTermTimeline({
    requestedTerms: ["部署", "论文"],
    extractedTerms: [
      { normalizedTerm: "部署", category: "work", featureIds: ["system"] },
      { normalizedTerm: "论文", category: "work", featureIds: ["paper"] },
    ], messages: [], feelings,
  });
  const work = buildWorkLifecycles({ termTimelines: timelines });
  assert.equal(work.groups.length, 2);
});

test("does not absorb an existing relation term into a work project", () => {
  const messages = [{ date: "2026-06-01", timestamp: "2026-06-01T08:00:00Z", text: "老公陪我改论文" }];
  const feelings = [{ id: "mixed", source_date: "2026-06-01", importance: 4, content: "老公陪我改论文" }];
  const timelines = buildTermTimeline({ requestedTerms: ["论文", "老公"], extractedTerms: [
    { normalizedTerm: "论文", category: "work", featureIds: [] },
    { normalizedTerm: "老公", category: "relation", featureIds: [] },
  ], messages, feelings });
  const intersections = buildCooccurrenceSignatures({ termTimelines: timelines, messages, feelings });
  const work = buildWorkLifecycles({ termTimelines: timelines, intersections });
  assert.deepEqual(work.terms.map(row => row.term), ["论文"]);
});
