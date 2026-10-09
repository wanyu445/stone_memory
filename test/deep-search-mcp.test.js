const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function callServer(messages, env = {}) {
  const server = path.join(__dirname, "..", "mcp-server.js");
  const input = messages.map(message => JSON.stringify(message)).join("\n") + "\n";
  const child = spawnSync(process.execPath, [server], {
    env: Object.fromEntries(Object.entries({
      ...process.env, STMEM_SKIP_PENDING_REBUILDS: "1", ...env,
    }).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
    input,
    encoding: "utf8",
    timeout: 2000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return child.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

test("deep-search child MCP exposes only its two read-only search tools", () => {
  const responses = callServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "not_a_search_tool", arguments: {} } },
  ], { STMEM_SEARCH_ONLY: "1", STMEM_THREAD_ID: "test-thread" });
  assert.deepEqual(responses[1].result.tools.map(tool => tool.name), [
    "memory_keyword_search",
    "memory_archive_context",
  ]);
  for (const tool of responses[1].result.tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
  assert.equal(responses[2].result.isError, true);
  assert.match(responses[2].result.content[0].text, /不提供工具/);
});

test("main MCP advertises multi-memory and rebuild controls and reports real tool errors", () => {
  const responses = callServer([
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "not_a_tool", arguments: {} } },
  ], { STMEM_SEARCH_ONLY: "0", STMEM_THREAD_ID: "" });
  const tools = new Map(responses[0].result.tools.map(tool => [tool.name, tool]));
  assert.ok(tools.get("stmem_memory_search").inputSchema.properties.thread);
  assert.ok(tools.get("stmem_memory_deep_search").inputSchema.properties.thread);
  assert.deepEqual(Object.keys(tools.get("stmem_memory_rebuild").inputSchema.properties), ["memoryId", "thread", "bindingId"]);
  assert.ok(tools.get("stmem_memory_rebuild_preview").inputSchema.properties.memoryId);
  assert.ok(tools.get("stmem_memory_rebuild_preview").inputSchema.properties.bindingId);
  const summary = tools.get("stmem_memory_rebuild_preview").inputSchema.properties.summary;
  assert.ok(summary);
  assert.ok(summary.properties.mode);
  assert.ok(summary.properties.limit);
  assert.ok(summary.properties.minImportance);
  assert.equal(responses[1].result.isError, true);
  assert.match(responses[1].result.content[0].text, /未知工具/);
});
