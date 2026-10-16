"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const provider = require("../backend/mcp");
const manifest = require("../module.json");

test("Provider has five closed schemas, shared readers and CLI-only writes", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taste-provider-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const context = { memoryId: "synthetic-memory", resolveDataPath: file => path.join(dir, file), runCommand: async (action, payload) => { calls.push({ action, payload }); return { ok: true }; } };
  const definitions = provider.tools();
  assert.deepEqual(definitions.map(x => x.name), ["list", "stats", "add", "update", "digest"]);
  function closed(schema) { if (schema.type === "object") { assert.equal(schema.additionalProperties, false); Object.values(schema.properties).forEach(closed); } if (schema.type === "array") closed(schema.items); }
  definitions.forEach(x => closed(x.inputSchema));
  await provider.call(context, "list", {}); await provider.call(context, "stats", {});
  assert.deepEqual(fs.readdirSync(dir), []); assert.equal(calls.length, 0);
  await provider.call(context, "add", { product: { brand: "测试店", name: "测试茶" }, entry: { options: [{ key: "自定义", value: "少量" }] } });
  assert.deepEqual(calls[0], { action: "add", payload: { product: { brand: "测试店", name: "测试茶" }, entry: { options: { 自定义: "少量" } } } });
  const denied = await provider.call(context, "update", { op: "clearAll" }); assert.equal(denied.isError, true); assert.equal(calls.length, 1);
  await provider.call(context, "update", { op: "product", productId: "p", patch: { clearVerdict: true } });
  assert.equal(calls[1].payload.patch.verdictOverride, null);
  assert.equal((await provider.call({ ...context, memoryId: null }, "list", {})).isError, true);
  assert.equal(manifest.sdkVersion, 2);
});

const host = process.env.STMEM_TEST_CORE;
test("Real MCP process: authorization, complete operations, isolation, errors and disable", { skip: !host && "Set STMEM_TEST_CORE to the isolated SM host with this module installed" }, t => {
  assert.ok(fs.existsSync(path.join(host, "developer-modules", "taste-journal", "backend", "mcp.js")));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taste-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stone = path.join(home, require("./fixtures/host-layout.json").dataDirectory);
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  fs.mkdirSync(stone, { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({ memories: Object.fromEntries(ids.map(memoryId => [memoryId, { memoryId, label: "测试记忆体", status: "active" }])) }));
  ids.forEach((memoryId, i) => {
    const dir = path.join(stone, "memories", memoryId); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".layout-v1.json"), JSON.stringify({ schemaVersion: 1, status: "complete", memoryId }));
    fs.writeFileSync(path.join(dir, "memory.json"), JSON.stringify({ memoryId, label: "测试记忆体", mcpModules: [], mcpModuleConfigVersion: 1 }));
    fs.writeFileSync(path.join(dir, "bindings.json"), JSON.stringify({ schemaVersion: 1, primaryBindingId: "b" + i, bindings: [{ id: "b" + i, provider: "codex", externalThreadId: "session-" + i, enabled: true }] }));
  });
  function env(i = 0) {
    const result = { ...process.env, HOME: home, USERPROFILE: home, STMEM_DB_PATH: path.join(stone, "stone-memory.db"), STMEM_SKIP_PENDING_REBUILDS: "1", STMEM_CURRENT_THREAD_ID: "session-" + i, STMEM_MEMORY_ID: ids[i], CODEX_HOME: path.join(home, ".codex") };
    for (const key of ["NODE_TEST_CONTEXT", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "STMEM_BINDING_ID", "STMEM_SEARCH_ONLY", "STMEM_NOTEBOOK_STEWARD"]) delete result[key];
    return result;
  }
  function cli(args) { const p = spawnSync(process.execPath, [path.join(host, "bin/stmem"), ...args], { env: env(), cwd: host, encoding: "utf8", timeout: 20000 }); assert.equal(p.status, 0, p.stderr || String(p.error)); return JSON.parse(p.stdout); }
  function request(method, params = {}, i = 0, bound = true) {
    const e = env(i); if (!bound) { delete e.STMEM_CURRENT_THREAD_ID; delete e.STMEM_MEMORY_ID; }
    const p = spawnSync(process.execPath, [path.join(host, "mcp-server.js")], { env: e, cwd: host, encoding: "utf8", timeout: 20000, input: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n" });
    assert.equal(p.status, 0, p.stderr || String(p.error)); return JSON.parse(p.stdout.trim().split(/\r?\n/).find(line => JSON.parse(line).id === 1)).result;
  }
  const names = (i = 0, bound = true) => request("tools/list", {}, i, bound).tools.map(x => x.name);
  const call = (name, args = {}, i = 0) => request("tools/call", { name: "stmem_taste_journal_" + name, arguments: args }, i);
  const data = result => { assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  const count = () => data(call("list")).entries.length;
  assert.equal(request("initialize").serverInfo.name, "stmem-mcp");
  assert.equal(names().some(x => x.includes("taste_journal")), false);
  const configFile = path.join(stone, "memories", ids[0], "memory.json"); const before = fs.readFileSync(configFile);
  assert.equal(cli(["module", "mcp", "enable", "--module", "taste-journal", "--memory", ids[0]]).dryRun, true);
  assert.deepEqual(fs.readFileSync(configFile), before);
  cli(["module", "mcp", "enable", "--module", "taste-journal", "--memory", ids[0], "--apply"]);
  assert.equal(names().filter(x => x.includes("taste_journal")).length, 5);
  assert.equal(names(1).some(x => x.includes("taste_journal")), false);
  assert.equal(names(0, false).some(x => x.includes("taste_journal")), false);
  assert.equal(call("list", { memoryId: ids[1] }).isError, true);
  const moduleDir = path.join(stone, "developer-module-data", ids[0], "taste-journal");
  assert.equal(count(), 0); data(call("stats")); assert.equal(fs.existsSync(moduleDir), false);
  const first = data(call("add", { product: { brand: "测试店", name: "桂花茶", tags: ["桂花"] }, entry: { ratingId: "love", price: 12.5, options: [{ key: "糖度", value: "微糖" }] } }));
  const second = data(call("add", { product: { brand: "测试店", name: "桂花茶" }, entry: { ratingId: "tried" } }));
  assert.equal(first.product.id, second.product.id); assert.deepEqual(second.entry.options, { 糖度: "微糖" });
  data(call("update", { op: "entry", entryId: first.entry.id, patch: { note: "更新短评" } }));
  data(call("update", { op: "product", productId: first.product.id, patch: { tags: ["桂花", "茶"] } }));
  data(call("update", { op: "settings", patch: { addRatingLabel: { label: "测试档", sentiment: "neutral" } } }));
  assert.equal(data(call("list", { query: { tag: "桂花" } })).count, 2); data(call("stats"));
  const report = data(call("digest", { scope: "month", month: "2026-09", sections: [{ body: "合成月报，保留标点——与换行。\n第二行。" }] }));
  assert.ok(report.digest.id); assert.equal(call("digest", { op: "delete", digestId: report.digest.id }).isError, true);
  data(call("digest", { op: "delete", digestId: report.digest.id, confirm: true }));
  data(call("add", { raw: "记不清是哪杯，保留原话" })); const draftId = data(call("list")).drafts[0].id;
  data(call("update", { op: "resolveDraft", draftId, product: { brand: "测试店", name: "另一杯" }, entry: { ratingId: "tried" } }));
  const entriesBefore = count(); assert.equal(call("update", { op: "clearAll" }).isError, true); assert.equal(count(), entriesBefore);
  assert.equal(call("add", { product: { brand: "测试店", name: "x" }, entry: { note: "x".repeat(141) } }).isError, true);
  assert.equal(call("update", { op: "entry", entryId: "missing", patch: { note: "秘密路径 /private/test" } }).isError, true);
  const filesBefore = Object.fromEntries(fs.readdirSync(moduleDir).map(f => [f, fs.readFileSync(path.join(moduleDir, f), "utf8")]));
  data(call("list")); data(call("stats"));
  assert.deepEqual(Object.fromEntries(fs.readdirSync(moduleDir).map(f => [f, fs.readFileSync(path.join(moduleDir, f), "utf8")])), filesBefore);
  data(call("update", { op: "deleteEntry", entryId: first.entry.id, confirm: true }));
  data(call("update", { op: "clearAll", confirm: true })); assert.equal(count(), 0);
  cli(["module", "mcp", "disable", "--module", "taste-journal", "--memory", ids[0], "--apply"]);
  assert.equal(names().some(x => x.includes("taste_journal")), false); assert.equal(call("list").isError, true);
  assert.equal(fs.existsSync(path.join(stone, "stone-memory.db")), false, "module operations must not create the core database");
});
