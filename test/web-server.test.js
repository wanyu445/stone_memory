const test = require("node:test");
const assert = require("node:assert/strict");
const { previewRows, paginate, buildConversationCalendar, miningDatesFromStore, miningCommandArgs, targetedMiningCommandArgs, timelineCommandArgs, compactTimelineReport, compressionCommandArgs } = require("../src/web/server");
const { itemKey, inspectClaude, inspectCodex, conversationWindow, latestConversationDate, trimRows } = require("../src/services/rebuild-workbench");
const { validateThreadInput } = require("../src/services/thread-setup");
const { findThreadSessionFile } = require("../src/lib/thread-session-file");
const { usageFromRow } = require("../src/lib/thread-context-usage");
const { MemoryStore } = require("../src/storage/memory-store");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("import preview paginates only cleaned archive conversations", () => {
  const records = [
    { raw: { type: "session_meta" }, message: null },
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
  assert.deepEqual(miningCommandArgs("thread-1", "2026-07-04", "api"), ["mine", "--thread", "thread-1", "--date", "2026-07-04", "--api"]);
  assert.deepEqual(miningCommandArgs("thread-1", "2026-07-16", "subagent"), ["mine", "--thread", "thread-1", "--date", "2026-07-16", "--subagent"]);
});

test("web targeted mining goes through the CLI append command", () => {
  assert.deepEqual(
    targetedMiningCommandArgs("thread-1", "api", "/tmp/selection.json"),
    ["mine", "--thread", "thread-1", "--targeted", "--batch-file", "/tmp/selection.json", "--api"],
  );
});

test("web timeline reuses the read-only CLI report and limits comparison terms", () => {
  assert.deepEqual(timelineCommandArgs("thread-1", ["老公", "论文"], {
    from: "2026-07-01", to: "2026-07-20",
  }), [
    "term-timeline", "--thread", "thread-1", "--terms", "老公,论文", "--json",
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

test("runtime usage extraction uses Claude cache totals and Codex input tokens", () => {
  const claude={timestamp:"2026-01-01",message:{model:"claude",usage:{input_tokens:144,cache_creation_input_tokens:0,cache_read_input_tokens:180864}}};
  assert.equal(usageFromRow(claude,"claude").usedTokens,181008);
  const codex={timestamp:"2026-01-01",type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:216081,cached_input_tokens:214784},model_context_window:258400}}};
  assert.deepEqual(usageFromRow(codex,"codex"),{usedTokens:216081,detectedMaxTokens:258400,observedAt:"2026-01-01",source:"codex_token_count"});
});
