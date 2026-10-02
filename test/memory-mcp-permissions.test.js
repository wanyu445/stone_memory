const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");

function run(home, code, args = []) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["-e", code, ...args], { cwd: root, env, encoding: "utf8" });
}

test("canonical memories inherit old Binding MCP permissions until memory-level config is saved", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-mcp-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const memoryId = "11111111-1111-4111-8111-111111111111";
  const memoryRoot = path.join(home, ".stone_memory", "memories", memoryId);
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.writeFileSync(path.join(home, ".stone_memory", "stmem.json"), JSON.stringify({ memories: { [memoryId]: { memoryId, label: "迁移测试", status: "active" } } }));
  fs.writeFileSync(path.join(memoryRoot, ".layout-v1.json"), JSON.stringify({ schemaVersion: 1, status: "complete", memoryId }));
  fs.writeFileSync(path.join(memoryRoot, "memory.json"), JSON.stringify({ schemaVersion: 1, memoryId, label: "迁移测试", mcpModules: [] }));
  fs.writeFileSync(path.join(memoryRoot, "bindings.json"), JSON.stringify({ schemaVersion: 1, primaryBindingId: "old", bindings: [{ id: "old", provider: "codex", externalThreadId: "thread", enabled: true, mcpModules: ["dream-lab", "notebook-lab"] }] }));
  const modulePath = path.join(root, "src", "services", "developer-module-mcp-config");
  const result = run(home, `const service=require(${JSON.stringify(modulePath)});const before=service.moduleIdsForMemory(process.argv[1]);const plan=service.planChange({moduleId:"dream-lab",memoryId:process.argv[1],enabled:false});service.applyChange(plan);const after=service.moduleIdsForMemory(process.argv[1]);console.log(JSON.stringify({before,after,file:require("fs").readFileSync(require("path").join(require("os").homedir(),".stone_memory","memories",process.argv[1],"memory.json"),"utf8")}));`, [memoryId]);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.before, ["dream-lab", "notebook-lab"]);
  assert.deepEqual(output.after, ["notebook-lab"]);
  const saved = JSON.parse(output.file);
  assert.equal(saved.mcpModuleConfigVersion, 1);
  assert.deepEqual(saved.mcpModules, ["notebook-lab"]);
});

test("saving MCP permissions keeps declared providers and removes missing module ids", () => {
  const { reconcileMcpModules } = require("../src/services/developer-module-mcp-config");
  assert.deepEqual(
    reconcileMcpModules(["notebook-lab", "missing-community-module", "dream-lab", "notebook-lab"]),
    ["notebook-lab", "dream-lab"],
  );
});

test("legacy Claude sessions resolve by their config key and keep Notebook and Dream available", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-legacy-mcp-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessionId = "22222222-2222-4222-8222-222222222222";
  fs.mkdirSync(path.join(home, ".stone_memory"), { recursive: true });
  fs.writeFileSync(path.join(home, ".stone_memory", "stmem.json"), JSON.stringify({ [sessionId]: { runtime: "claude", purpose: "accompany", label: "旧记忆体" } }));
  const modulePath = path.join(root, "src", "services", "developer-module-mcp-config");
  const result = run(home, `const service=require(${JSON.stringify(modulePath)});console.log(JSON.stringify(service.resolveCurrentBinding({CLAUDE_CODE_SESSION_ID:process.argv[1]})));`, [sessionId]);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const session = JSON.parse(result.stdout);
  assert.equal(session.memoryId, sessionId);
  assert.deepEqual(session.modules, ["notebook-lab", "dream-lab"]);
});

test("legacy settings save preserves declared MCP module switches", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-legacy-settings-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const threadId = "55555555-5555-4555-8555-555555555555";
  fs.mkdirSync(path.join(home, ".stone_memory"), { recursive: true });
  fs.writeFileSync(path.join(home, ".stone_memory", "stmem.json"), JSON.stringify({
    [threadId]: { memoryId: threadId, label: "旧记忆体", runtime: "claude", purpose: "accompany",
      ai: "A", user: "U", userGender: "unspecified", sessionDir: home, minerMode: "subagent", scenario: "accompany",
      mcpModules: ["notebook-lab", "dream-lab", "drawing-game"], mcpModuleConfigVersion: 1 },
  }));
  const setupPath = path.join(root, "src", "services", "thread-setup");
  const code = `const { createThread } = require(${JSON.stringify(setupPath)});
const input = { threadId: process.argv[1], libraryName: "旧记忆体", runtime: "claude", purpose: "accompany",
  ai: "A", user: "U", userGender: "unspecified", sessionDir: process.argv[2], minerMode: "subagent", scenario: "accompany" };
createThread(input, { allowExisting: true, requireSession: false });
const saved = require("fs").readFileSync(require("path").join(require("os").homedir(), ".stone_memory", "stmem.json"), "utf8");
const entry = JSON.parse(saved)[process.argv[1]];
console.log(JSON.stringify({ mcpModules: entry.mcpModules, mcpModuleConfigVersion: entry.mcpModuleConfigVersion }));`;
  const result = run(home, code, [threadId, home]);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(out.mcpModules, ["notebook-lab", "dream-lab", "drawing-game"]);
  assert.equal(out.mcpModuleConfigVersion, 1);
});

test("module MCP resolves the configured legacy STMEM_THREAD_ID", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-legacy-thread-env-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessionId = "33333333-3333-4333-8333-333333333333";
  fs.mkdirSync(path.join(home, ".stone_memory"), { recursive: true });
  fs.writeFileSync(path.join(home, ".stone_memory", "stmem.json"), JSON.stringify({
    [sessionId]: {
      runtime: "codex",
      purpose: "accompany",
      label: "旧环境变量记忆体",
      mcpModules: ["notebook-lab", "dream-lab", "drawing-game"],
      mcpModuleConfigVersion: 1,
    },
  }));
  const modulePath = path.join(root, "src", "services", "developer-module-mcp-config");
  const result = run(home, `const service=require(${JSON.stringify(modulePath)});console.log(JSON.stringify(service.resolveCurrentBinding({STMEM_THREAD_ID:process.argv[1]})));`, [sessionId]);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const session = JSON.parse(result.stdout);
  assert.equal(session.memoryId, sessionId);
  assert.deepEqual(session.modules, ["notebook-lab", "dream-lab", "drawing-game"]);
});
