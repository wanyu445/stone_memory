const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMcpRebuildPreviewArgs } = require("../src/services/mcp-rebuild-preview");

test("MCP rebuild generates a dry-run command without apply", () => {
  const args = buildMcpRebuildPreviewArgs("/project/scripts/stmem-rebuild.js", {
    threadId: "thread-1",
    windowDays: 5,
    toolPairs: 40,
  });
  assert.deepEqual(args, [
    "/project/scripts/stmem-rebuild.js",
    "--thread", "thread-1",
    "--window", "5",
    "--tool-pairs", "40",
    "--trigger", "mcp",
  ]);
  assert.equal(args.includes("--apply"), false);
});
