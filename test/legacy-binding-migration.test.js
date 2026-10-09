const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-legacy-binding-"));
process.env.HOME = home;

const { createMemory } = require("../src/services/memory-setup");
const {
  migrateLegacyBinding, readBindingConfig, applyBindingAdd, applyBindingPrimary,
  applyBindingState, resolvePrimaryBinding, planBindingSuccessorDiscovery, applyBindingSuccessorDiscovery,
} = require("../src/services/memory-binding-config");

test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("Codex fork successors are discovered and registered as child bindings", () => {
  const memory = createMemory({ label: "Fork 记忆" });
  const sessionRoot = path.join(home, "fork-sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const parentId = "019f648b-c71a-7783-8155-67206bc9eab3";
  const childId = "01a0565c-21a2-7461-bcda-4448938a1985";
  fs.writeFileSync(path.join(sessionRoot, `rollout-${parentId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { session_id: parentId } })}\n`);
  fs.writeFileSync(path.join(sessionRoot, `rollout-${childId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { session_id: childId, forked_from_id: parentId } })}\n`);
  applyBindingAdd(memory.memoryId, { provider: "codex", externalThreadId: parentId, sessionRoot, mode: "primary" });

  const plan = planBindingSuccessorDiscovery(memory.memoryId);
  assert.deepEqual(plan.candidates.map(item => item.externalThreadId), [childId]);
  const applied = applyBindingSuccessorDiscovery(memory.memoryId);
  assert.equal(applied.changed, true);
  assert.equal(applied.topology, "linear");
  assert.equal(applied.added[0].mode, "child");
  const after = readBindingConfig(memory.memoryId);
  assert.equal(after.bindings.length, 2);
  assert.equal(after.bindings.find(item => item.externalThreadId === parentId).enabled, false);
  assert.equal(after.bindings.find(item => item.id === after.primaryBindingId).externalThreadId, childId);
  assert.equal(applyBindingSuccessorDiscovery(memory.memoryId).changed, false);
});

test("linear forks keep only the newest leaf active while real branches keep every leaf", () => {
  const memory = createMemory({ label: "分支归并" });
  const sessionRoot = path.join(home, "branch-sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const ids = { root: "branch-root", middle: "branch-middle", left: "branch-left", right: "branch-right" };
  const write = (id, parentId, seconds) => {
    const file = path.join(sessionRoot, `rollout-${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { session_id: id, ...(parentId ? { forked_from_id: parentId } : {}) } })}\n`);
    fs.utimesSync(file, seconds, seconds);
  };
  write(ids.root, null, 1); write(ids.middle, ids.root, 2); write(ids.left, ids.middle, 3); write(ids.right, ids.middle, 4);
  applyBindingAdd(memory.memoryId, { provider: "codex", externalThreadId: ids.root, sessionRoot, mode: "primary" });

  const plan = planBindingSuccessorDiscovery(memory.memoryId);
  assert.equal(plan.topology, "branched");
  assert.deepEqual(plan.candidates.map(item => item.externalThreadId).sort(), [ids.left, ids.right]);
  assert.equal(plan.primaryLeaf.externalThreadId, ids.right);
  assert.ok(plan.supersededExternalThreadIds.includes(ids.root));
  assert.ok(plan.supersededExternalThreadIds.includes(ids.middle));

  const applied = applyBindingSuccessorDiscovery(memory.memoryId);
  const config = readBindingConfig(memory.memoryId);
  assert.equal(config.bindings.find(item => item.externalThreadId === ids.root).enabled, false);
  assert.equal(config.bindings.some(item => item.externalThreadId === ids.middle), false);
  assert.equal(config.bindings.find(item => item.externalThreadId === ids.left).enabled, true);
  assert.equal(config.bindings.find(item => item.externalThreadId === ids.right).enabled, true);
  assert.equal(config.bindings.find(item => item.id === config.primaryBindingId).externalThreadId, ids.right);
  assert.equal(applied.disabledBindingIds.length, 1);
});

test("Claude fork descendants use the same leaf consolidation policy", () => {
  const memory = createMemory({ label: "Claude 分支归并" });
  const sessionRoot = path.join(home, "claude-branch-sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const rootId = "claude-root", childId = "claude-child";
  fs.writeFileSync(path.join(sessionRoot, `${rootId}.jsonl`), `${JSON.stringify({ sessionId: rootId, type: "user", message: { role: "user", content: "root" } })}\n`);
  fs.writeFileSync(path.join(sessionRoot, `${childId}.jsonl`), `${JSON.stringify({ sessionId: childId, forkedFrom: { sessionId: rootId, messageUuid: "m1" }, type: "user", message: { role: "user", content: "child" } })}\n`);
  applyBindingAdd(memory.memoryId, { provider: "claude", externalThreadId: rootId, sessionRoot, mode: "primary" });

  const plan = planBindingSuccessorDiscovery(memory.memoryId);
  assert.equal(plan.topology, "linear");
  assert.deepEqual(plan.candidates.map(item => item.externalThreadId), [childId]);
  applyBindingSuccessorDiscovery(memory.memoryId);
  const config = readBindingConfig(memory.memoryId);
  assert.equal(config.bindings.find(item => item.externalThreadId === rootId).enabled, false);
  assert.equal(config.bindings.find(item => item.id === config.primaryBindingId).externalThreadId, childId);
});

test("legacy configured window becomes the first primary binding exactly once", () => {
  const memory = createMemory({ label: "旧记忆" });
  const sessionRoot = path.join(home, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, "rollout-old-window.jsonl"), "{}\n");
  const configFile = path.join(home, ".stone_memory", "stmem.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config["old-window"] = {
    memoryId: memory.memoryId,
    label: "旧记忆",
    runtime: "codex",
    purpose: "coding",
    sessionDir: sessionRoot,
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  const migrated = migrateLegacyBinding(memory.memoryId, { apply: true });
  assert.equal(migrated.changed, true);
  const bindings = readBindingConfig(memory.memoryId);
  assert.equal(bindings.bindings.length, 1);
  assert.equal(bindings.primaryBindingId, bindings.bindings[0].id);
  assert.equal(bindings.bindings[0].externalThreadId, "old-window");
  assert.equal(bindings.bindings[0].enabled, true);

  const repeated = migrateLegacyBinding(memory.memoryId, { apply: true });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.reason, "bindings-exist");

  fs.writeFileSync(path.join(sessionRoot, "rollout-new-window.jsonl"), "{}\n");
  const second = applyBindingAdd(memory.memoryId, {
    provider: "codex", externalThreadId: "new-window", sessionRoot, mode: "parallel",
  });
  const selected = applyBindingPrimary(memory.memoryId, second.binding.id);
  assert.equal(selected.changed, true);
  const afterPrimary = readBindingConfig(memory.memoryId);
  assert.equal(afterPrimary.primaryBindingId, second.binding.id);
  assert.equal(afterPrimary.bindings.find(item => item.id === second.binding.id).mode, "primary");
  assert.equal(afterPrimary.bindings.find(item => item.externalThreadId === "old-window").mode, "parallel");

  applyBindingState(memory.memoryId, second.binding.id, "disable");
  assert.equal(readBindingConfig(memory.memoryId).primaryBindingId, second.binding.id);
  assert.equal(resolvePrimaryBinding(memory.memoryId).id, second.binding.id);
  assert.throws(() => applyBindingState(memory.memoryId, second.binding.id, "remove"), /不能删除主 Binding/);
});
