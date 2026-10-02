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

test("drawing-game MCP returns compact agent receipts", async () => {
  const context = {
    async runCommand() {
      return {
        room: {
          id: "room-id", code: "123456", status: "active", phase: "guessing",
          roundNo: 2, maxRounds: 6, drawer: "human", scores: { human: 1, agent: 0 },
          eventCursor: 18, createdAt: "old", updatedAt: "new", agentJoinedAt: "old",
        },
        round: {
          id: "round-id", number: 2, drawer: "human", status: "guessing", word: "",
          wordLength: 2, hasImage: true, drawing: [{ points: [[1, 2], [3, 4]] }],
        },
        events: [{ id: "event-id", seq: 18, kind: "chat", actor: "human", text: "猜猜看", meta: {}, createdAt: "now" }],
        settings: { humanName: "37", agentName: "47" },
        words: [], gallery: [],
        agent: { role: "guesser", actionTool: "long-repeated-tool-name", actions: ["guess", "agent-wait"], imageAction: "stmem_drawing_game_image_read", roundId: "round-id", note: "a very long repeated instruction" },
      };
    },
  };
  const result = await provider.call(context, "agent_state", { roomCode: "123456" });
  const text = result.content[0].text;
  const parsed = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) < 600);
  assert.equal(parsed.room.id, undefined);
  assert.equal(parsed.round.drawing, undefined);
  assert.equal(parsed.settings, undefined);
  assert.equal(parsed.agent.note, undefined);
  assert.deepEqual(parsed.events, [{ seq: 18, kind: "chat", actor: "human", text: "猜猜看" }]);
});
