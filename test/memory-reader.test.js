const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryStore } = require("../src/storage/memory-store");
const { readFeelings, readFeatures, readMessages } = require("../src/storage/memory-reader");
const { loadInjectableFeelings } = require("../src/services/thread-rebuilder");

test("SQLite reader applies daily, coarse, and hidden modes without destroying full content", t => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-reader-"));
  const store = new MemoryStore({ memoryDir, threadId: "thread-test" });
  t.after(() => { store.close(); fs.rmSync(memoryDir, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const insert = store.db.prepare(`INSERT INTO feelings
    (id,thread_id,source_date,event_time,order_key,content,importance,source,created_at,updated_at,summary_mode,coarse_summary)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run("daily", "thread-test", "2026-06-10", null, "1", "6月10日，完整日摘要。", 3, "manual", now, now, "daily", null);
  insert.run("coarse", "thread-test", "2026-06-11", null, "2", "6月11日，带感受的完整摘要。", 3, "manual", now, now, "coarse", "发生了一件事。");
  insert.run("hidden", "thread-test", "2026-06-12", null, "3", "6月12日，隐藏但仍保留。", 3, "manual", now, now, "hidden", null);

  const all = readFeelings(memoryDir, { threadId: "thread-test" });
  assert.deepEqual(all.map(row => row.fullContent), ["6月10日，完整日摘要。", "6月11日，带感受的完整摘要。", "6月12日，隐藏但仍保留。"]);
  const injected = readFeelings(memoryDir, { threadId: "thread-test", forInjection: true });
  assert.deepEqual(injected.map(row => [row.id, row.content]), [
    ["daily", "6月10日，完整日摘要。"],
    ["coarse", "6月11日，发生了一件事。"],
  ]);

  store.db.prepare("UPDATE feelings SET coarse_summary=? WHERE id='coarse'")
    .run("6月11日，晚上八点。发生了一件事。");
  assert.equal(readFeelings(memoryDir, { threadId: "thread-test", forInjection: true })[1].content,
    "6月11日，晚上八点。发生了一件事。");

  const rebuilt = loadInjectableFeelings(memoryDir, "thread-test");
  assert.deepEqual(rebuilt.map(row => row.id), ["daily", "coarse"]);
});

test("fork rebuild sees current parent memories while recent messages remain isolated", t => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-fork-reader-"));
  const parent = new MemoryStore({ memoryDir, threadId: "parent" });
  const child = new MemoryStore({ memoryDir, threadId: "child" });
  t.after(() => { child.close(); parent.close(); fs.rmSync(memoryDir, { recursive: true, force: true }); });
  child.setFork({ parentThreadId: "parent" });
  const now = new Date().toISOString();
  const addFeeling = parent.db.prepare(`INSERT INTO feelings
    (id,thread_id,source_date,event_time,order_key,content,importance,source,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  addFeeling.run("parent-old", "parent", "2026-07-12", null, "1", "7月12日，父线程旧记忆。", 3, "manual", now, now);
  addFeeling.run("child-own", "child", "2026-07-13", null, "2", "7月13日，子线程游戏记忆。", 3, "manual", now, now);
  addFeeling.run("parent-new", "parent", "2026-07-14", null, "3", "7月14日，父线程重建前新增记忆。", 3, "manual", now, now);
  parent.db.prepare(`INSERT INTO features
    (id,thread_id,source_date,category,content,importance,source,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("child-feature", "child", "2026-07-13", "game", "在玩星露谷", 3, "manual", now, now);
  parent.insertMessages([{ timestamp: "2026-07-14T01:00:00.000Z", sourceDate: "2026-07-14", role: "user", text: "父线程近期" }]);
  child.insertMessages([{ timestamp: "2026-07-14T02:00:00.000Z", sourceDate: "2026-07-14", role: "user", text: "子线程近期" }]);

  assert.deepEqual(readFeelings(memoryDir, { threadId: "child", forInjection: true }).map(row => row.id),
    ["parent-old", "child-own", "parent-new"]);
  assert.deepEqual(readFeelings(memoryDir, { threadId: "parent", forInjection: true }).map(row => row.id),
    ["parent-old", "child-own", "parent-new"]);
  assert.deepEqual(readFeatures(memoryDir, { threadId: "parent" }).map(row => row.id), ["child-feature"]);
  assert.deepEqual(readMessages(memoryDir, { threadId: "child" }).map(row => row.text), ["子线程近期"]);
});

test("fork can keep child memories private from parent", t => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-private-fork-"));
  const parent = new MemoryStore({ memoryDir, threadId: "parent" });
  const child = new MemoryStore({ memoryDir, threadId: "child" });
  t.after(() => { child.close(); parent.close(); fs.rmSync(memoryDir, { recursive: true, force: true }); });
  child.setFork({ parentThreadId: "parent", memoriesFlowToParent: false });
  const now = new Date().toISOString();
  parent.db.prepare(`INSERT INTO feelings
    (id,thread_id,source_date,event_time,order_key,content,importance,source,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("private", "child", "2026-07-14", null, "1", "子线程私有记忆", 3, "manual", now, now);

  assert.deepEqual(readFeelings(memoryDir, { threadId: "parent" }), []);
  assert.deepEqual(readFeelings(memoryDir, { threadId: "child" }).map(row => row.id), ["private"]);
});
