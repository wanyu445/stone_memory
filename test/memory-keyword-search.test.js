const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-keyword-search-"));
const originalHome = process.env.HOME;
process.env.HOME = testHome;

const threadId = "thread-deep-search";
const stoneDir = path.join(testHome, ".stone_memory");
fs.mkdirSync(stoneDir, { recursive: true });
fs.writeFileSync(path.join(stoneDir, "stmem.json"), JSON.stringify({
  [threadId]: {
    ai: "Qiheng",
    user: "Lili",
    runtime: "codex",
    purpose: "accompany",
  },
}));

const { getThreadDir } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { searchByKeyword, searchArchiveContext } = require("../src/services/memory-keyword-search");

test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

test("deep-search hits retain time metadata and archive lookup uses the configured thread", t => {
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const store = new MemoryStore({ memoryDir, threadId });
  t.after(() => store.close());

  store.insertMessages([
    {
      timestamp: "2026-06-17T11:58:00.000Z",
      sourceDate: "2026-06-17",
      role: "user",
      text: "我们继续整理归栖。",
    },
    {
      timestamp: "2026-06-17T12:02:00.000Z",
      sourceDate: "2026-06-17",
      role: "assistant",
      text: "我记得归栖的这条线。",
    },
  ]);
  store.replaceDay("2026-06-17", {
    feelings: [{
      id: "feeling-deep-search",
      eventTime: "2026-06-17T12:00:00.000Z",
      content: "6月17日，晚上八点。我们继续整理归栖。",
      importance: 3,
    }],
    features: [],
    source: "manual",
  });

  const keyword = searchByKeyword("归栖", { maxResults: 1, threadId });
  assert.deepEqual(keyword.hits, [{
    id: "feeling-deep-search",
    content: "6月17日，晚上八点。我们继续整理归栖。",
    score: 1,
    date: "2026-06-17",
    utcTime: "2026-06-17T12:00:00.000Z",
  }]);

  const archive = searchArchiveContext("2026-06-17", ["归栖"], {
    maxDays: 1,
    contextLines: 4,
    threadId,
  });
  assert.equal(archive.snippets.length, 1);
  assert.match(archive.text, /我们继续整理归栖/);
  assert.match(archive.text, /我记得归栖的这条线/);
});
