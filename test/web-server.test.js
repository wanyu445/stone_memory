const test = require("node:test");
const assert = require("node:assert/strict");
const { previewRows, paginate, buildConversationCalendar, countFeelingsMinedSince, memoryGrowthDays, miningDatesFromStore, miningCommandArgs, miningCheckCommandArgs, targetedMiningCommandArgs, timelineCommandArgs, compactTimelineReport, compressionCommandArgs, safeStmemFailure, reviewCandidateForWeb, reviewProfileFromInput, reviewBatchPayload, reviewBatchCommandArgs, listDeveloperModules } = require("../src/web/server");
const { buildStdinCmd } = require("../src/services/subagent-runner");
const { itemKey, inspectClaude, inspectCodex, conversationWindow, latestConversationDate, trimRows, checkThreadIntegrity } = require("../src/services/rebuild-workbench");
const { validateThreadInput, validateSessionBinding } = require("../src/services/thread-setup");
const { INIT_SCHEMA, buildInitTemplate } = require("../src/services/init-contract");
const { findThreadSessionFile, findExactThreadSessionFile, listCodexSuccessors, resolveThreadSession } = require("../src/lib/thread-session-file");
const { usageFromRow } = require("../src/lib/thread-context-usage");
const { MemoryStore } = require("../src/storage/memory-store");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("context management keeps usage and rebuild provenance per binding", () => {
  const root = path.join(__dirname, "..");
  const watcher = fs.readFileSync(path.join(root, "scripts", "watcher.js"), "utf8");
  const service = fs.readFileSync(path.join(root, "src", "services", "rebuild-log.js"), "utf8");
  const rebuild = fs.readFileSync(path.join(root, "scripts", "stmem-rebuild.js"), "utf8");
  const codex = fs.readFileSync(path.join(root, "scripts", "rebuild-codex-thread.js"), "utf8");
  const claude = fs.readFileSync(path.join(root, "scripts", "rebuild-thread.js"), "utf8");
  assert.match(watcher, /for \(const binding of enabledWatcherBindings\(tid\)\)/);
  assert.match(watcher, /updateContextUsage\(tid, \{ \.\.\.usage, bindingId: binding\.id \}\)/);
  assert.match(service, /lastCompletedByBinding/);
  assert.match(service, /contextUsageByBinding/);
  assert.match(rebuild, /STMEM_REBUILD_BINDING_ID: binding\.id/);
  assert.match(codex, /bindingId:process\.env\.STMEM_REBUILD_BINDING_ID\|\|null/);
  assert.match(claude, /bindingId:process\.env\.STMEM_REBUILD_BINDING_ID\|\|null/);
});

test("active Web rebuild routes classify the selected binding runtime", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "src", "web", "server.js"), "utf8");
  const rebuildRoutes = server.slice(server.indexOf("const rebuildMatch ="), server.indexOf("const importPreviewMatch", server.indexOf("const rebuildMatch =")));
  assert.match(rebuildRoutes, /getConfiguredBinding\(threadId, bindingValue\)/);
  assert.match(rebuildRoutes, /buildRebuildPreview\(threadId, \{ windowDays, toolPairs, binding \}\)/);
  assert.match(rebuildRoutes, /\(binding\?\.provider \|\| threadSettings\.runtime\) === "codex"/);
  assert.match(rebuildRoutes, /\(binding\?\.provider \|\| threadSettings\.runtime\) !== "codex"/);
});

test("the mining prompt editor is hidden and its Web write route is disabled", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  const routes = fs.readFileSync(path.join(__dirname, "..", "src", "web", "routes", "memory.js"), "utf8");
  assert.doesNotMatch(app, /mining-prompts-save|调提示词 & 时间轴|loadMiningPrompts/u);
  assert.match(routes, /挖掘提示词编辑功能暂时关闭/u);
  assert.match(routes, /\["prompt", "show", "--memory", memoryId\]/u);
  assert.doesNotMatch(routes, /\["prompt", "show", "--thread"/u);
});

test("import preview paginates only cleaned archive conversations", () => {
  const records = [
    { raw: { type: "session_meta" }, message: null },
    { raw: {}, message: { timestamp: "2026-07-20T00:59:00Z", type: "user", text: "<memory_context>\nprivate injected context" } },
    { raw: {}, message: { timestamp: "2026-07-20T00:59:30Z", type: "user", text: "<!-- stmem-rule: instructions.md -->" } },
    { raw: {}, message: { timestamp: "2026-07-20T01:00:00Z", type: "user", text: "你好" } },
    { raw: { type: "turn_context" }, message: null },
    { raw: {}, message: { timestamp: "2026-07-20T01:01:00Z", type: "assistant", text: "你好呀" } },
  ];
  const result = previewRows({ records }, 1);
  assert.equal(result.totalPages, 1);
  assert.deepEqual(result.rows.map(row => row.context), ["你好", "你好呀"]);
  assert.ok(result.rows.every(row => row.valid));
});

test("import preview uses twenty cleaned conversations per page", () => {
  const records = Array.from({ length: 45 }, (_, index) => ({
    raw: {}, message: { timestamp: `2026-07-20T01:${String(index).padStart(2, "0")}:00Z`, type: "user", text: `消息 ${index}` },
  }));
  const result = previewRows({ records }, 2);
  assert.equal(result.pageSize, 20);
  assert.equal(result.totalPages, 3);
  assert.equal(result.rows.length, 20);
  assert.equal(result.rows[0].context, "消息 20");
});

test("rebuild workbench uses stable selection keys and paginates", () => {
  assert.equal(itemKey("2026-07-20T01:00:00Z", "user", "你好"), itemKey("2026-07-20T01:00:00Z", "user", "你好"));
  assert.notEqual(itemKey("2026-07-20T01:00:00Z", "user", "你好"), itemKey("2026-07-20T01:00:00Z", "assistant", "你好"));
  const result = paginate(Array.from({ length: 47 }, (_, index) => index), 3);
  assert.equal(result.totalPages, 3);
  assert.deepEqual(result.rows, [40, 41, 42, 43, 44, 45, 46]);
});

test("integrity checks resolve the selected binding thread file", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-binding-integrity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = [
    { type: "system", subtype: "init", session_id: "t1", uuid: "11111111-1111-1111-1111-111111111111", timestamp: "2026-09-18T00:00:00.000Z" },
    { type: "user", uuid: "22222222-2222-2222-2222-222222222222", parentUuid: "11111111-1111-1111-1111-111111111111", timestamp: "2026-09-18T00:01:00.000Z", message: { content: [{ type: "text", text: "hi" }] } },
  ];
  fs.writeFileSync(path.join(dir, "t1.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
  const report = checkThreadIntegrity("memory-select", { provider: "claude", externalThreadId: "t1", sessionRoot: dir });
  assert.equal(report.healthy, true);
  assert.ok(report.file.endsWith("t1.jsonl"));
  assert.throws(() => checkThreadIntegrity("memory-select", { provider: "claude", externalThreadId: "missing-id", sessionRoot: dir }), /没有找到线程/);
});

test("home overview counts summaries mined today instead of today's conversation date", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-home-feelings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: dir, threadId: "memory-1" });
  try {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const dayStart = new Date(`${today}T00:00:00+08:00`).toISOString();
    // 自动挖掘只挖过去：夜里挖出的历史对话，应以"今天挖出"计入
    store.replaceDay("2026-01-05", { feelings: [{ content: "昨夜挖出的摘要", importance: 3 }] });
    // 对话日期是今天但很久以前就挖过的旧摘要，不应计入
    store.replaceDay(today, { feelings: [{ content: "旧摘要", importance: 3, createdAt: "2020-01-01T00:00:00.000Z" }] });
    assert.equal(countFeelingsMinedSince(store, "memory-1", dayStart), 1);
  } finally { store.close(); }
});

test("memory growth days anchor on creation or the first conversation date", () => {
  assert.equal(memoryGrowthDays("2026-04-15T01:30:11.034Z", "2026-04-15", "2026-09-19"), 158);
  assert.equal(memoryGrowthDays(null, "2026-04-15", "2026-09-19"), 158);
  assert.equal(memoryGrowthDays(null, "2026-09-19", "2026-09-19"), 1);
  assert.equal(memoryGrowthDays(null, null, "2026-09-19"), 0);
  assert.equal(memoryGrowthDays("not-a-date", "bad", "2026-09-19"), 0);
});

test("conversation calendar renders complete months newest first", () => {
  const counts = [{ date: "2026-05-01", count: 8 }, { date: "2026-06-20", count: 205 }];
  const calendar = buildConversationCalendar(counts, 1);
  assert.equal(calendar.totalPages, 2);
  assert.equal(calendar.month, "2026-06");
  assert.equal(calendar.days.length, 30);
  assert.deepEqual(calendar.days.find(day => day.date === "2026-06-20"), { date: "2026-06-20", count: 205 });
  assert.deepEqual(calendar.days.find(day => day.date === "2026-06-03"), { date: "2026-06-03", count: 0 });
  const older = buildConversationCalendar(counts, 2);
  assert.equal(older.month, "2026-05");
  assert.deepEqual(older.days[0], { date: "2026-05-01", count: 8 });
});

test("web mining reuses one existing single-date CLI command per selected day", () => {
  assert.deepEqual(miningCommandArgs("thread-1", "2026-07-04", "api"), ["mine", "--thread", "thread-1", "--date", "2026-07-04", "--api", "--api-profile", "optimized"]);
  assert.deepEqual(miningCommandArgs("thread-1", "2026-07-04", "api", false, "optimized"), ["mine", "--thread", "thread-1", "--date", "2026-07-04", "--api", "--api-profile", "optimized"]);
  assert.deepEqual(miningCommandArgs("thread-1", "2026-07-16", "subagent"), ["mine", "--thread", "thread-1", "--date", "2026-07-16", "--subagent"]);
});

test("web mining self-check reuses the formal CLI diagnostic command", () => {
  assert.deepEqual(miningCheckCommandArgs("thread-1", "2026-07-04", "api"),
    ["mine", "--thread", "thread-1", "--date", "2026-07-04", "--check", "--json", "--api", "--api-profile", "optimized"]);
  assert.deepEqual(miningCheckCommandArgs("thread-1", "2026-07-04", "api", "optimized"),
    ["mine", "--thread", "thread-1", "--date", "2026-07-04", "--check", "--json", "--api", "--api-profile", "optimized"]);
});

test("web subprocess errors never expose unmarked conversation output", () => {
  const stderr = [
    "private conversation content",
    "more untrusted model output",
    "[memory-miner] subagent error: subagent failed: ERROR: 401 Unauthorized",
  ].join("\n");
  assert.equal(
    safeStmemFailure(stderr, "mine", 1),
    "subagent error: subagent failed: ERROR: 401 Unauthorized",
  );
  assert.equal(safeStmemFailure("private conversation content", "mine", 7), "stmem mine失败（退出码 7）");
  assert.equal(
    safeStmemFailure("[rebuild] 无法覆盖活动线程：EACCES", "rebuild", 1),
    "stmem rebuild失败（退出码 1）：[rebuild] 无法覆盖活动线程：EACCES",
  );
  assert.equal(
    safeStmemFailure("[memory-compressor] error: API 429: rate limited", "compress", 1),
    "error: API 429: rate limited",
  );
  assert.equal(
    safeStmemFailure("[module] error: GitHub 点星失败（HTTP 404）：OAuth App 无权访问这个仓库", "module", 1),
    "error: GitHub 点星失败（HTTP 404）：OAuth App 无权访问这个仓库",
  );
  assert.equal(safeStmemFailure("[init] error: 缺少必填项：threadId", "init", 1), "error: 缺少必填项：threadId");
});

test("web targeted mining goes through the CLI append command", () => {
  assert.deepEqual(
    targetedMiningCommandArgs("thread-1", "api", "/tmp/selection.json"),
    ["mine", "--thread", "thread-1", "--targeted", "--batch-file", "/tmp/selection.json", "--api", "--api-profile", "optimized"],
  );
});

test("review batch web input stays single-profile and routes through mine-review CLI", () => {
  const payload = reviewBatchPayload("thread", {
    dates: ["2026-07-02", "2026-07-01", "2026-07-02"],
    profile: { channel: "subagent", runtime: "codex", model: "gpt-test", reasoning: "low" },
    groupDays: 3,
    chunkKb: 100,
    parallel: 2,
    rules: { sourceAware: true },
  });
  assert.deepEqual(payload.dates, ["2026-07-01", "2026-07-02"]);
  assert.equal(payload.profile.channel, "subagent");
  assert.deepEqual(payload.ruleIds, ["source-aware"]);
  assert.deepEqual(reviewBatchCommandArgs("batch-create", "thread", "/tmp/batch.json"), [
    "mine-review", "batch-create", "--thread", "thread", "--batch-file", "/tmp/batch.json",
  ]);
  assert.deepEqual(reviewBatchCommandArgs("batch-status", "thread", "batch-abc"), [
    "mine-review", "batch-status", "--thread", "thread", "--batch", "batch-abc",
  ]);
});

test("web timeline reuses the read-only CLI report and limits comparison terms", () => {
  assert.deepEqual(timelineCommandArgs("thread-1", ["老公", "论文"], {
    from: "2026-07-01", to: "2026-07-20",
  }), [
    "term-timeline", "--thread", "thread-1", "--terms", "老公,论文", "--json", "--compact-json",
    "--from", "2026-07-01", "--to", "2026-07-20",
  ]);
  assert.throws(() => timelineCommandArgs("thread-1", ["一", "二", "三", "四"]), /1～3/);
  assert.throws(() => timelineCommandArgs("thread-1", ["论文"], { from: "2026-07-20", to: "2026-07-01" }), /开始日期/);
});

test("web timeline drops raw cooccurrence conversations from its browser payload", () => {
  const compact=compactTimelineReport({
    threadId:"thread-1",
    report:[{term:"论文",normalizedTerm:"论文",categories:["work"],timeline:[],feelings:[]}],
    intersections:[{terms:["论文","系统"],sameDays:[{}],sameMessages:[{text:"很长的原文"}],sameFeelings:[{}]}],
    relation:{terms:[],pairs:[{terms:["论文","系统"],state:"established",shape:"episodic_pair",evidence:{spanDays:12}}]},work:{groups:[]},
  });
  assert.deepEqual(compact.intersections,[{
    terms:["论文","系统"],sameDayCount:1,sameMessageCount:1,sameFeelingCount:1,
  }]);
  assert.doesNotMatch(JSON.stringify(compact),/很长的原文/);
  assert.deepEqual(compact.relation.pairs,[{
    terms:["论文","系统"],normalizedTerms:[],state:"established",shape:"episodic_pair",evidence:{spanDays:12},
  }]);
});

test("web compression previews and applies through existing compact and hidden CLI commands", () => {
  assert.deepEqual(compressionCommandArgs("thread-1", { kind:"compact" }),
    ["compact","--thread","thread-1","--json"]);
  assert.deepEqual(compressionCommandArgs("thread-1", {
    kind:"compact",apply:true,mode:"api",from:"2026-07-01",to:"2026-07-07",
  }), ["compact","--thread","thread-1","--json","--from","2026-07-01","--to","2026-07-07","--api","--apply"]);
  assert.deepEqual(compressionCommandArgs("thread-1", { kind:"hidden",apply:true,afterDays:120 }),
    ["hidden","--thread","thread-1","--json","--after-days","120","--apply"]);
});

test("review workbench maps canonical CLI candidates to the contributed frontend contract", () => {
  const candidate = reviewCandidateForWeb({
    id: "candidate-1",
    profile: { id: "api:provider:model", label: "模型甲" },
    ruleIds: ["source-aware"],
    feelings: [],
    features: [],
  });
  assert.equal(candidate.model, "api:provider:model");
  assert.equal(candidate.modelLabel, "模型甲");
  assert.equal(candidate.preset, "custom");
  assert.equal(candidate.rules.sourceAware, true);
  assert.equal(Object.keys(candidate.rules).length, 6);
  assert.equal(candidate.rules.countLimit, false);
});

test("review workbench exposes hybrid candidates without changing CLI provenance", () => {
  const hybrid = { parentCandidateIds: ["one", "two"], selectionProvenance: { feelings: [], features: [] } };
  const candidate = reviewCandidateForWeb({
    id: "candidate-hybrid",
    profile: { id: "hybrid", label: "Hybrid" },
    ruleIds: [],
    hybrid,
  });
  assert.equal(candidate.model, "hybrid");
  assert.equal(candidate.modelLabel, "混合精选");
  assert.equal(candidate.hybrid, hybrid);
});

test("review workbench accepts per-candidate Claude Code and Codex profiles", () => {
  assert.deepEqual(reviewProfileFromInput("unused", {
    channel: "subagent", runtime: "claude", model: "claude-opus-4-6", label: "Claude 主候选",
  }), {
    id: "subagent:claude:claude-opus-4-6:default",
    label: "Claude 主候选",
    channel: "subagent",
    runtime: "claude",
    model: "claude-opus-4-6",
    reasoning: null,
  });
  assert.equal(reviewProfileFromInput("unused", {
    channel: "subagent", runtime: "codex", model: "gpt-5.5", reasoning: "high",
  }).reasoning, "high");
  assert.throws(() => reviewProfileFromInput("unused", {
    channel: "subagent", runtime: "claude", model: "claude-opus-4-6", reasoning: "high",
  }), /只有 Codex/);
});

test("subagent command adapter uses each CLI model flag and Codex-only reasoning", () => {
  assert.equal(buildStdinCmd("claude", { model: "claude-opus-4-6" }),
    "claude -p --model claude-opus-4-6");
  assert.equal(buildStdinCmd("codex", { model: "gpt-5.5", reasoning: "low" }),
    'codex exec --ephemeral --sandbox read-only --ignore-user-config --ignore-rules --color never -m gpt-5.5 -c model_reasoning_effort="low"');
  assert.throws(() => buildStdinCmd("claude", {
    model: "claude-opus-4-6", reasoning: "low",
  }), /only supported by the Codex/);
});

test("mining reports count real memories instead of stale day-state counters", t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-web-mining-")),store=new MemoryStore({memoryDir:dir,threadId:"thread-1"});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  store.insertMessages([{timestamp:"2026-07-04T01:00:00.000Z",sourceDate:"2026-07-04",role:"user",text:"hello"}]);
  store.appendTargeted("2026-07-04",{
    feelings:[{content:"7月4日，上午九点。一条旧摘要。",importance:3}],
    features:[{content:"旧特征",category:"relation",importance:3}],
  });
  store.setDayState("2026-07-04",{status:"completed",messageCount:1,feelingCount:0,featureCount:0});

  assert.deepEqual(miningDatesFromStore(store,"thread-1").map(row=>[
    row.date,row.messageCount,row.feelingCount,row.featureCount,
  ]),[["2026-07-04",1,1,1]]);
});

test("web mining adds force only for explicitly confirmed completed dates", () => {
  assert.deepEqual(miningCommandArgs("thread-1", "2026-07-04", "subagent"), [
    "mine", "--thread", "thread-1", "--date", "2026-07-04", "--subagent",
  ]);
  assert.deepEqual(miningCommandArgs("thread-1", "2026-07-04", "api", true), [
    "mine", "--thread", "thread-1", "--date", "2026-07-04", "--api", "--api-profile", "optimized", "--force",
  ]);
});

test("rebuild preview shows the newest conversation and tool pair first", () => {
  const claudeRows = [
    { type: "user", timestamp: "2026-07-19T01:00:00Z", message: { content: [{ type: "text", text: "较早对话" }] } },
    { type: "assistant", timestamp: "2026-07-20T01:00:00Z", message: { content: [{ type: "tool_use", id: "old-tool", name: "old" }] } },
    { type: "user", timestamp: "2026-07-20T01:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "old-tool", content: "old result" }] } },
    { type: "assistant", timestamp: "2026-07-21T01:00:00Z", message: { content: [{ type: "text", text: "最新对话" }, { type: "tool_use", id: "new-tool", name: "new" }] } },
    { type: "user", timestamp: "2026-07-21T01:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "new-tool", content: "new result" }] } },
  ];
  const claude = inspectClaude(claudeRows, "2026-07-01", 2);
  assert.deepEqual(claude.items.map(item => item.context), ["最新对话", "较早对话"]);
  assert.deepEqual(claude.tools.map(tool => tool.id), ["new-tool", "old-tool"]);

  const codexRows = [
    { type: "response_item", timestamp: "2026-07-19T01:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "较早对话" }] } },
    { type: "response_item", timestamp: "2026-07-20T01:00:00Z", payload: { type: "function_call", call_id: "old-tool", name: "old" } },
    { type: "response_item", timestamp: "2026-07-20T01:00:01Z", payload: { type: "function_call_output", call_id: "old-tool", output: "old result" } },
    { type: "response_item", timestamp: "2026-07-21T01:00:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "最新对话" }] } },
    { type: "response_item", timestamp: "2026-07-21T01:00:01Z", payload: { type: "function_call", call_id: "new-tool", name: "new" } },
    { type: "response_item", timestamp: "2026-07-21T01:00:02Z", payload: { type: "function_call_output", call_id: "new-tool", output: "new result" } },
  ];
  const codex = inspectCodex(codexRows, "2026-07-01", 2);
  assert.deepEqual(codex.items.map(item => item.context), ["最新对话", "较早对话"]);
  assert.deepEqual(codex.tools.map(tool => tool.id), ["new-tool", "old-tool"]);
});

test("rebuild window anchors to the latest real conversation instead of today", () => {
  const rows = [
    { type: "user", timestamp: "2025-01-01T01:00:00Z", message: { content: [{ type: "text", text: "较早" }] } },
    { type: "user", timestamp: "2025-01-10T01:00:00Z", message: { content: [{ type: "text", text: "最后对话" }] } },
    { type: "user", timestamp: "2026-07-22T01:00:00Z", message: { content: [{ type: "text", text: "<memory_context>注入内容</memory_context>" }] } },
  ];
  assert.equal(latestConversationDate(rows, "claude"), "2025-01-10");
});

test("rebuild window counts active conversation dates instead of calendar days", () => {
  const rows = ["2026-07-05", "2026-07-08", "2026-07-10", "2026-07-12"].map((date, index) => ({
    type: index % 2 ? "assistant" : "user", timestamp: `${date}T01:00:00Z`, message: { content: [{ type: "text", text: `对话 ${index}` }] },
  }));
  assert.deepEqual(conversationWindow(rows, "claude", 4), {
    cutoff: "2026-07-05", referenceDate: "2026-07-12", activeDates: ["2026-07-05", "2026-07-08", "2026-07-10", "2026-07-12"],
  });
  assert.equal(conversationWindow(rows, "claude", 2).cutoff, "2026-07-10");
});

test("rebuild active conversation dates use Beijing time", () => {
  const rows = [
    { type: "user", timestamp: "2026-07-05T15:59:00Z", message: { content: [{ type: "text", text: "北京时间5日" }] } },
    { type: "assistant", timestamp: "2026-07-05T16:01:00Z", message: { content: [{ type: "text", text: "北京时间6日" }] } },
  ];
  assert.deepEqual(conversationWindow(rows, "claude", 2).activeDates, ["2026-07-05", "2026-07-06"]);
});

test("permanent Codex trim removes selected messages and complete tool pairs", () => {
  const timestamp = "2026-07-20T01:00:00Z";
  const rows = [
    { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "删掉争吵" }] } },
    { timestamp, type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "shell" } },
    { timestamp, type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "ok" } },
    { timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "留下回答" }] } },
  ];
  const removed = trimRows(rows, "codex", new Set([itemKey(timestamp, "user", "删掉争吵")]), new Set(["call-1"]));
  assert.equal(removed.removedMessages, 1);
  assert.equal(removed.removedTools, 2);
  assert.deepEqual(removed.rows.map(row => row.payload.content?.[0]?.text).filter(Boolean), ["留下回答"]);
});

test("web init requires a configurable session search directory for both runtimes", () => {
  const input = { libraryName: "小绿", threadId: "thread-1", ai: "AI", user: "用户", runtime: "claude", purpose: "accompany", minerMode: "subagent" };
  assert.throws(() => validateThreadInput(input, {}), /线程文件/);
  assert.throws(() => validateThreadInput({ ...input, runtime: "codex" }, {}), /线程文件/);
  assert.doesNotThrow(() => validateThreadInput({ ...input, runtime: "codex", sessionDir: "C:\\Users\\you\\.codex\\sessions" }, {}));
});

test("API init requires an explicit upstream model name instead of a hidden default", () => {
  const input = {
    libraryName: "小绿", threadId: "thread-1", ai: "AI", user: "用户",
    runtime: "codex", purpose: "accompany", sessionDir: "/tmp", minerMode: "api",
    apiProvider: "provider", apiKey: "key",
  };
  assert.throws(() => validateThreadInput(input, {}), /模型名/);
});

test("machine init contract keeps display name separate from the real thread id", () => {
  const template = buildInitTemplate("codex");
  assert.equal(template.libraryName, "记忆体显示名称");
  assert.match(template.threadId, /真实线程ID/);
  assert.equal(template.runtime, "codex");
  assert.match(template.sessionDir, /\.codex[\\/]sessions$/);
  assert.equal(template.automaticCompression, false);
  assert.equal(INIT_SCHEMA.properties.automaticCompression.default, false);
  assert.deepEqual(INIT_SCHEMA.required, [
    "libraryName", "threadId", "ai", "user", "runtime", "sessionDir", "minerMode",
  ]);
});

test("session lookup recursively finds a Codex dated session directory", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dated = path.join(root, "2026", "07", "14");
  fs.mkdirSync(dated, { recursive: true });
  const file = path.join(dated, "rollout-thread-1.jsonl");
  fs.writeFileSync(file, "{}\n");
  assert.equal(findThreadSessionFile(root, "thread-1"), file);
  assert.equal(findThreadSessionFile(root, "missing-thread"), null);
});

test("session lookup follows a Codex forked_from_id lineage to the newest rollout", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-session-lineage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentId = "019f648b-c71a-7783-8155-67206bc9eab3";
  const childId = "01a0565c-21a2-7461-bcda-4448938a1985";
  const parentDir = path.join(root, "2026", "07", "15"), childDir = path.join(root, "2026", "08", "31");
  fs.mkdirSync(parentDir, { recursive: true }); fs.mkdirSync(childDir, { recursive: true });
  const parent = path.join(parentDir, `rollout-${parentId}.jsonl`), child = path.join(childDir, `rollout-${childId}.jsonl`);
  fs.writeFileSync(parent, `${JSON.stringify({ type: "session_meta", payload: { session_id: parentId } })}\n`);
  fs.writeFileSync(child, `${JSON.stringify({ type: "session_meta", payload: { session_id: childId, forked_from_id: parentId } })}\n`);
  const later = new Date(Date.now() + 1000); fs.utimesSync(child, later, later);
  assert.equal(findThreadSessionFile(root, `rollout-2026-07-15T14-51-49-${parentId}`), child);
  assert.equal(findExactThreadSessionFile(root, parentId), parent);
  assert.deepEqual(listCodexSuccessors(root, parentId).map(item => item.id), [childId]);
});

test("runtime session resolver reports a Claude branch without replacing its parent", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-claude-lineage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentId = "2cf80f4c-5e95-4b86-b395-82454e597d10";
  const childId = "dc8ba8dd-d38a-43eb-a79e-243d09c192af";
  const parent = path.join(root, `${parentId}.jsonl`), child = path.join(root, `${childId}.jsonl`);
  fs.writeFileSync(parent, `${JSON.stringify({ type: "user", sessionId: parentId, uuid: "message-1" })}\n`);
  fs.writeFileSync(child, [
    JSON.stringify({ type: "user", sessionId: childId, uuid: "message-1", forkedFrom: { sessionId: parentId, messageUuid: "message-1" } }),
    JSON.stringify({ type: "user", sessionId: childId, uuid: "message-2", message: { role: "user", content: "branch local" } }),
  ].join("\n") + "\n");

  const parentResult = resolveThreadSession({ root, threadId: parentId, runtime: "claude" });
  assert.equal(parentResult.file, parent);
  assert.equal(parentResult.strategy, "branch-set");
  assert.deepEqual(parentResult.branches.map(item => item.threadId), [childId]);

  const childResult = resolveThreadSession({ root, threadId: childId, runtime: "cc" });
  assert.equal(childResult.file, child);
  assert.equal(childResult.parentThreadId, parentId);
  assert.equal(childResult.inheritedPrefix.inheritedRecords, 1);
  assert.ok(childResult.inheritedPrefix.incrementalStartByte > 0);
});

test("strict init binding rejects a display name used as thread id", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-session-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dated = path.join(root, "2026", "07", "25");
  fs.mkdirSync(dated, { recursive: true });
  const realId = "019f91-real-thread";
  const file = path.join(dated, `rollout-${realId}.jsonl`);
  fs.writeFileSync(file, "{}\n");
  assert.equal(validateSessionBinding({ sessionDir: root, threadId: realId }), file);
  assert.throws(
    () => validateSessionBinding({ sessionDir: root, threadId: "alisa" }),
    /记忆体名字应填入 libraryName.*真实线程 ID/,
  );
});

test("runtime usage extraction uses Claude cache totals and Codex input tokens", () => {
  const claude={timestamp:"2026-01-01",message:{model:"claude",usage:{input_tokens:144,cache_creation_input_tokens:0,cache_read_input_tokens:180864}}};
  assert.equal(usageFromRow(claude,"claude").usedTokens,181008);
  const codex={timestamp:"2026-01-01",type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:216081,cached_input_tokens:214784},model_context_window:258400}}};
  assert.deepEqual(usageFromRow(codex,"codex"),{usedTokens:216081,detectedMaxTokens:258400,observedAt:"2026-01-01",source:"codex_token_count"});
});

test("developer experiments register through removable bootstraps instead of app.js", () => {
  const publicDir = path.join(__dirname, "..", "src", "web", "public");
  const appSource = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const themeBootstrap = fs.readFileSync(path.join(publicDir, "theme-studio", "bootstrap.js"), "utf8");

  assert.match(appSource, /id="developer-module-host"/);
  assert.doesNotMatch(appSource, /enter-review-lab|贡献人：@小思飞刀/);
  assert.doesNotMatch(indexSource, /\/review-lab\/bootstrap\.js/);
  assert.doesNotMatch(appSource, /loadOptionalScript\("\/review-lab\/bootstrap\.js"\)/);
  assert.match(indexSource, /\/theme-studio\/bootstrap\.js/);
  assert.match(themeBootstrap, /dataModule = MODULE_ID|dataset\.developerModule = MODULE_ID/);
});

test("binding status adopts a legacy configured window through the formal CLI", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "src", "web", "server.js"), "utf8");
  assert.match(server, /layout !== "memory-v1" \? legacyThreadId : null/);
  assert.match(server, /"binding", "migrate-legacy", "--memory", threadId, "--apply"/);
  assert.match(server, /settings\.layout !== "memory-v1" && settings\.externalThreadId/);
  assert.match(server, /legacy-config:/);
  assert.match(server, /settings\.externalThreadId/);
  assert.match(server, /source:\s*"legacy-config"/);
  assert.match(server, /readOnly:\s*true/);
});

test("legacy fork cards disappear only after their thread is absorbed as a Binding", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "src", "web", "server.js"), "utf8");
  assert.match(server, /config\[context\.legacyKey\]\?\.parentThreadId/);
  assert.match(server, /binding\.externalThreadId === context\.legacyKey && fs\.existsSync\(bindingCursorFile\(ancestor\.memoryId, binding\)\)/);
  assert.match(server, /if \(absorbed\) return \[\]/);
  assert.match(server, /runStmem\(\["sync", "--memory", memoryId, "--binding", binding\.id\]\)/);
});

test("canonical developer modules are discovered without copying frontend code into public", () => {
  const modules = listDeveloperModules();
  const continuity = modules.find(module => module.id === "continuity-lab");
  assert.ok(continuity);
  assert.equal(continuity.entry, "/developer-modules/continuity-lab/");
  assert.equal(continuity.scope, "memory");
  assert.equal(continuity.status, "官方架构实验");
  const root = path.join(__dirname, "..", "developer-modules", "continuity-lab");
  assert.ok(fs.existsSync(path.join(root, "frontend", "index.html")));
  assert.equal(fs.existsSync(path.join(__dirname, "..", "src", "web", "public", "developer-modules", "continuity-lab")), false);
  assert.equal(modules.length, 8);
  assert.equal(modules.filter(module => module.entry === "/developer-modules/my-module/").length, 1);
  assert.equal(modules.find(module => module.id === "dream-lab").entry, "/developer-modules/dream-lab/");
  assert.equal(modules.find(module => module.id === "notebook-lab").entry, "/notebook-lab/");
  assert.equal(modules.find(module => module.id === "theme-studio").entry, "/theme-studio/");
});
