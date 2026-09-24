const assert = require("node:assert/strict");
const test = require("node:test");

const manifest = require("../module.json");
const provider = require("../backend/mcp");
const { validateTools } = require("../../../src/mcp/provider-contract");

test("drawing-game exposes a valid SDK v2 MCP provider", () => {
  const tools = provider.tools();
  assert.doesNotThrow(() => validateTools(manifest, tools));
  assert.deepEqual(tools.map(tool => tool.name), [
    "agent_join",
    "agent_wait",
    "agent_state",
    "agent_action",
    "image_read",
  ]);
  assert.equal(tools.find(tool => tool.name === "agent_wait").inputSchema.properties.timeoutMs.default, 25_000);
  assert.equal(tools.find(tool => tool.name === "agent_state").annotations.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === "image_read").annotations.readOnlyHint, false);
  assert.match(tools.find(tool => tool.name === "agent_join").description, /所有AI写操作.*stmem_drawing_game_agent_action/u);
  assert.match(tools.find(tool => tool.name === "agent_wait").description, /kind=guess.*answer=答案/u);
  assert.match(tools.find(tool => tool.name === "agent_action").description, /唯一MCP入口/u);
  assert.match(tools.find(tool => tool.name === "agent_action").inputSchema.properties.answer.description, /kind=guess/u);
});

test("drawing-game MCP delegates writes through the governed command bridge", async () => {
  const calls = [];
  const context = {
    async runCommand(action, args) {
      calls.push({ action, args });
      return { room: { code: args.roomCode } };
    },
  };
  const result = await provider.call(context, "agent_wait", { roomCode: "123456", afterSeq: 7 });
  assert.deepEqual(calls, [{ action: "agent-wait", args: { roomCode: "123456", afterSeq: 7 } }]);
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content[0].text).room.code, "123456");
});
