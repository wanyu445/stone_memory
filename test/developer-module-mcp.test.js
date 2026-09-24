"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("main MCP discovers and calls developer modules through the formal CLI", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-module-mcp-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stoneRoot = path.join(home, ".stone_memory");
  fs.mkdirSync(stoneRoot, { recursive: true });
  fs.writeFileSync(path.join(stoneRoot, "stmem.json"), JSON.stringify({
    "thread-test": { runtime: "codex", purpose: "test", user: "human", ai: "agent" },
  }));
  const env = { HOME: home, USERPROFILE: home, STMEM_THREAD_ID: "thread-test" };

  const discovery = callServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "stmem_module_list", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "stmem_module_inspect", arguments: { moduleId: "drawing-game" } } },
  ], env);
  const toolNames = new Set(discovery[1].result.tools.map(tool => tool.name));
  assert.ok(toolNames.has("stmem_module_list"));
  assert.ok(toolNames.has("stmem_module_inspect"));
  assert.ok(toolNames.has("stmem_module_call"));
  assert.ok(JSON.parse(discovery[2].result.content[0].text).some(item => item.id === "drawing-game"));
  assert.ok(JSON.parse(discovery[3].result.content[0].text).manifest.entry.commands["agent-state"]);
  assert.ok(JSON.parse(discovery[3].result.content[0].text).manifest.entry.commands["agent-wait"]);

  const createdResponse = callServer([
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "stmem_module_call", arguments: {
      moduleId: "drawing-game", action: "room-create", input: { maxRounds: 1 },
    } } },
  ], env)[0];
  assert.equal(createdResponse.result.isError, false, createdResponse.result.content[0].text);
  const created = JSON.parse(createdResponse.result.content[0].text);

  const joinedResponse = callServer([
    { jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "stmem_module_call", arguments: {
      moduleId: "drawing-game", action: "agent-join", input: { roomCode: created.room.code },
    } } },
  ], env)[0];
  assert.equal(joinedResponse.result.isError, false, joinedResponse.result.content[0].text);
  const joined = JSON.parse(joinedResponse.result.content[0].text);
  assert.equal(joined.room.agentOnline, true);

  const startedResponse = callServer([
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "stmem_module_call", arguments: {
      moduleId: "drawing-game", action: "game-start", input: { roomCode: created.room.code, firstDrawer: "human", maxRounds: 1 },
    } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "stmem_module_call", arguments: {
      moduleId: "drawing-game", action: "drawing-submit", input: { roomCode: created.room.code, actor: "human", imageDataUrl: ONE_PIXEL_PNG },
    } } },
  ], env);
  assert.equal(startedResponse[0].result.isError, false, startedResponse[0].result.content[0].text);
  const submitted = JSON.parse(startedResponse[1].result.content[0].text);
  assert.equal(submitted.room.phase, "guessing");

  const imageResponse = callServer([
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "stmem_module_call", arguments: {
      moduleId: "drawing-game", action: "image-read", input: { roundId: submitted.round.id },
    } } },
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "stmem_module_call", arguments: {
      moduleId: "drawing-game", action: "not-registered", input: {},
    } } },
  ], env);
  assert.equal(imageResponse[0].result.content[1].type, "image");
  assert.equal(imageResponse[0].result.content[1].mimeType, "image/png");
  assert.equal(imageResponse[1].result.isError, true);
  assert.match(imageResponse[1].result.content[0].text, /未登记命令/u);
});

function callServer(messages, env) {
  const server = path.join(__dirname, "..", "mcp-server.js");
  const child = spawnSync(process.execPath, [server], {
    env: Object.fromEntries(Object.entries({
      ...process.env,
      STMEM_SKIP_PENDING_REBUILDS: "1",
      STMEM_SEARCH_ONLY: "0",
      STMEM_THREAD_ID: "",
      ...env,
    }).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
    input: `${messages.map(message => JSON.stringify(message)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 8_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return child.stdout.trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}
