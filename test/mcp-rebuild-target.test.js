const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveMcpRebuildTarget } = require("../src/services/mcp-rebuild-target");

const primary = {
  id: "binding-primary",
  provider: "codex",
  externalThreadId: "session-new",
  sessionRoot: "/sessions",
  resolvedThreadFile: "/sessions/new.jsonl",
};

function options(resolveResult, callingBinding = null) {
  return {
    resolveMcpThread(args, cfg, ids, env, hooks) {
      if (callingBinding) hooks.onResolveBinding(callingBinding);
      return resolveResult;
    },
    getMemoryRuntimeConfig: () => ({ windowDays: 3, keepToolPairs: 30 }),
    resolvePrimaryBinding: () => primary,
    getConfiguredBinding(memoryId, id) {
      assert.equal(memoryId, "memory-1");
      if (id === primary.id) return primary;
      if (id === "binding-other") return { ...primary, id, externalThreadId: "session-other" };
      throw new Error("missing binding");
    },
  };
}

test("memoryId and external thread must resolve to the same memory", () => {
  assert.throws(() => resolveMcpRebuildTarget({ memoryId: "memory-other", thread: "session-new" }, {}, options("memory-1", {
    memoryId: "memory-1", bindingId: "binding-primary", externalThreadId: "session-new", provider: "codex",
  })), /指向不同记忆体/);
});

test("memory-only rebuild resolves the current primary Binding", () => {
  const target = resolveMcpRebuildTarget({ memoryId: "memory-1" }, {}, options("memory-1"));
  assert.deepEqual(target, {
    threadId: "memory-1",
    bindingId: "binding-primary",
    externalThreadId: "session-new",
    resolvedThreadFile: "/sessions/new.jsonl",
    runtime: "codex",
    windowDays: 3,
    toolPairs: 30,
  });
});

test("calling external thread keeps its exact Binding", () => {
  const calling = { memoryId: "memory-1", bindingId: "binding-primary", externalThreadId: "session-new", provider: "codex" };
  const target = resolveMcpRebuildTarget({ thread: "session-new" }, {}, options("memory-1", calling));
  assert.equal(target.bindingId, "binding-primary");
  assert.equal(target.externalThreadId, "session-new");
});

test("rebuild rejects conflicting thread and Binding selectors", () => {
  assert.throws(() => resolveMcpRebuildTarget({ thread: "session-new", bindingId: "binding-other" }, {}, options("memory-1", {
    memoryId: "memory-1", bindingId: "binding-primary", externalThreadId: "session-new", provider: "codex",
  })), /指向不同窗口/);
});
