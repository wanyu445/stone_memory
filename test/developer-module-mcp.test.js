"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("main MCP loads the drawing game provider for the active memory", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-module-mcp-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stoneRoot = path.join(home, ".stone_memory");
  fs.mkdirSync(stoneRoot, { recursive: true });
  fs.writeFileSync(path.join(stoneRoot, "stmem.json"), JSON.stringify({
    "thread-test": { runtime: "codex", purpose: "test", user: "human", ai: "agent", mcpModules:["drawing-game"], mcpModuleConfigVersion:1 },
  }));
  const env = { HOME: home, USERPROFILE: home, STMEM_THREAD_ID: "thread-test" };

  const discovery = callServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ], env);
  const toolNames = new Set(discovery[1].result.tools.map(tool => tool.name));
  for (const name of ["agent_join", "agent_wait", "agent_state", "agent_action", "image_read"]) {
    assert.ok(toolNames.has(`stmem_drawing_game_${name}`));
  }

  const created = callModule(home, env, "room-create", { maxRounds:1 });

  const joinedResponse = callServer([
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "stmem_drawing_game_agent_join", arguments: {
      roomCode: created.room.code,
    } } },
  ], env)[0];
  assert.equal(joinedResponse.result.isError, false, joinedResponse.result.content[0].text);
  const joined = JSON.parse(joinedResponse.result.content[0].text);
  assert.equal(joined.room.agentOnline, true);

  callModule(home, env, "game-start", { roomCode:created.room.code, firstDrawer:"human", maxRounds:1 });
  const submitted = callModule(home, env, "drawing-submit", { roomCode:created.room.code, actor:"human", imageDataUrl:ONE_PIXEL_PNG });
  assert.equal(submitted.room.phase, "guessing");

  const imageResponse = callServer([
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "stmem_drawing_game_image_read", arguments: {
      roundId: submitted.round.id,
    } } },
  ], env);
  assert.equal(imageResponse[0].result.content[1].type, "image");
  assert.equal(imageResponse[0].result.content[1].mimeType, "image/png");
});

function callModule(home, env, action, payload) {
  const batch = path.join(home, `drawing-${action}.json`);
  fs.writeFileSync(batch, JSON.stringify(payload));
  const cli = path.join(__dirname, "..", "bin", "stmem");
  const child = spawnSync(process.execPath, [cli, "module", "drawing-game", action, "--memory", "thread-test", "--batch-file", batch], {
    env:{ ...process.env, ...env }, encoding:"utf8", timeout:8_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return JSON.parse(child.stdout);
}

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
