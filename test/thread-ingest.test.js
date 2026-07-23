const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ingestMessages, parseThreadMessages } = require("../src/services/thread-ingest");
const { MemoryStore } = require("../src/storage/memory-store");

test("shared ingest handles Claude and Codex, deduplicates, and sorts late messages", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-ingest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fullDir = path.join(root, "archive", "full");
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => store.close());
  const messages = [
    { timestamp: "2026-05-12T02:00:00Z", type: "assistant", message: { content: [{ type: "text", text: "later" }] } },
    { timestamp: "2026-05-12T01:00:00Z", type: "user", message: { content: "earlier" } },
    { timestamp: "2026-05-12T16:30:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "next day" }] } },
  ];
  const first = ingestMessages(messages, { memoryStore: store, fullDir });
  const second = ingestMessages([...messages].reverse(), { memoryStore: store, fullDir });
  assert.deepEqual([first.imported, first.fullBacked, second.imported, second.fullBacked], [3, 3, 0, 0]);

  const day = store.listMessages({ date: "2026-05-12" });
  assert.deepEqual(day.map(row => row.text), ["earlier", "later"]);
  assert.equal(store.listMessages({ date: "2026-05-13" }).length, 1);
  assert.equal(fs.existsSync(path.join(root, "archive", "2026", "05", "2026-05-12.jsonl")), false);
});

test("thread parser accepts newline and adjacent JSON objects", () => {
  assert.deepEqual(parseThreadMessages('{"a":1}\n{"b":2}{"c":3}'), [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("native thread ingest preserves conversation text longer than 2000 characters", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-ingest-long-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => store.close());
  const text = "长".repeat(2500);
  ingestMessages([{ timestamp: "2026-05-12T01:00:00Z", type: "user", message: { content: text } }], { memoryStore: store });
  assert.equal(store.listMessages({ date: "2026-05-12" })[0].text, text);
});
