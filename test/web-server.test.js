const test = require("node:test");
const assert = require("node:assert/strict");
const { previewRows, paginate } = require("../src/web/server");
const { itemKey, trimRows } = require("../src/services/rebuild-workbench");
const { validateThreadInput } = require("../src/services/thread-setup");

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

test("web init requires Claude session directory but lets Codex use its fixed directory", () => {
  const input = { libraryName: "小绿", threadId: "thread-1", ai: "AI", user: "用户", runtime: "claude", purpose: "accompany", minerMode: "subagent" };
  assert.throws(() => validateThreadInput(input, {}), /线程文件目录/);
  assert.doesNotThrow(() => validateThreadInput({ ...input, runtime: "codex" }, {}));
});
