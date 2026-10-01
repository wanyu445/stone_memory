const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

test("MCP status and trigger checks enumerate canonical and legacy memories", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-memory-status-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stone = path.join(home, ".stone_memory");
  const canonicalId = "canonical-memory";
  const legacyId = "legacy-memory";
  const canonicalRoot = path.join(stone, "memories", canonicalId);
  const legacyRoot = path.join(stone, "runtimes", "claude", "coding", legacyId);
  fs.mkdirSync(path.join(canonicalRoot, "memory"), { recursive: true });
  fs.mkdirSync(path.join(legacyRoot, "memory"), { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
    memories: { [canonicalId]: { memoryId: canonicalId, label: "新版记忆", status: "active" } },
    [legacyId]: { label: "旧版记忆", ai: "旧助手", user: "旧用户", runtime: "claude", purpose: "coding" },
  }));
  fs.writeFileSync(path.join(canonicalRoot, ".layout-v1.json"), JSON.stringify({ status: "complete", memoryId: canonicalId }));
  fs.writeFileSync(path.join(canonicalRoot, "memory.json"), JSON.stringify({
    schemaVersion: 1, memoryId: canonicalId, label: "新版记忆", ai: "新助手", user: "新用户", purpose: "accompany",
    rebuild: { windowDays: 1 },
  }));
  fs.writeFileSync(path.join(canonicalRoot, "bindings.json"), JSON.stringify({
    schemaVersion: 1, primaryBindingId: "binding-1",
    bindings: [{ id: "binding-1", provider: "claude", externalThreadId: "external-thread", enabled: true }],
  }));
  fs.writeFileSync(path.join(canonicalRoot, "watcher.json"), JSON.stringify({ schemaVersion: 1, enabled: false, modules: {} }));

  const memoryModule = path.join(root, "src", "mcp", "core", "memory");
  const storeModule = path.join(root, "src", "storage", "memory-store");
  const code = `
    const path = require("node:path");
    const os = require("node:os");
    const { MemoryStore } = require(${JSON.stringify(storeModule)});
    const id = process.argv[1];
    const store = new MemoryStore({ memoryDir:path.join(os.homedir(), ".stone_memory", "memories", id, "memory"), threadId:id });
    store.setDayState("2026-09-30", { status:"blocked", attempt:3, errorCode:"TEST_BLOCKED", errorMessage:"fixture" });
    store.close();
    const { toolStatus, toolTriggersCheck } = require(${JSON.stringify(memoryModule)});
    console.log(JSON.stringify({ status:toolStatus(), triggers:toolTriggersCheck({}) }));
  `;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["-e", code, canonicalId], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = JSON.parse(result.stdout);
  assert.match(output.status, /新助手 × 新用户 \(新版记忆\)/u);
  assert.match(output.status, /旧助手 × 旧用户 \(旧版记忆\)/u);
  assert.match(output.status, /挖掘阻塞: 1 天/u);
  assert.match(output.triggers, /canonical-memory \/ 2026-09-30/u);
  assert.match(output.triggers, /TEST_BLOCKED: fixture/u);
});
