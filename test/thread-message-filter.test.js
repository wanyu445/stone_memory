const test = require("node:test");
const assert = require("node:assert/strict");
const { isSystemInjection } = require("../src/lib/thread-message-filter");
const { itemKey, conversationWindow } = require("../src/services/rebuild-workbench");

test("background injections do not consume active conversation days", () => {
  const rows = [
    {
      type: "response_item",
      timestamp: "2026-07-20T01:00:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "今天一起散步吧" }] },
    },
    {
      type: "response_item",
      timestamp: "2026-07-23T01:00:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "[轮询唤醒] Trigger: 2026-07-23 09:00" }] },
    },
  ];

  assert.deepEqual(conversationWindow(rows, "codex", 1).activeDates, ["2026-07-20"]);
});

test("system injection matching tolerates changing timestamps and identifiers", () => {
  assert.equal(isSystemInjection("[轮询唤醒]\nTrigger: 2026-07-23 09:00\nid 8bfda474-2e96-4c0d-937d-0123456789ab"), true);
  assert.equal(isSystemInjection("我想聊聊今天的散步"), false);
});

test("message identity preserves repeated wording at different moments", () => {
  const first = itemKey("2026-07-20T01:00:00Z", "assistant", "我在这里");
  const later = itemKey("2026-07-21T01:00:00Z", "assistant", "我在这里");
  const duplicate = itemKey("2026-07-20T01:00:00Z", "assistant", "我在这里");

  assert.notEqual(first, later);
  assert.equal(first, duplicate);
});
