const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeThreadMessage } = require("../src/lib/thread-message");

test("normalizes Codex response_item messages and ignores developer messages", () => {
  const rows = [
    { timestamp: "2026-05-12T16:01:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "用户消息" }] } },
    { timestamp: "2026-05-12T16:02:00Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "系统指令" }] } },
    { timestamp: "2026-05-12T16:03:00Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "助手回复" }] } },
  ];
  const normalized = rows.map(normalizeThreadMessage).filter(Boolean);
  assert.deepEqual(normalized.map(row => [row.type, row.text]), [
    ["user", "用户消息"],
    ["assistant", "助手回复"],
  ]);
});
