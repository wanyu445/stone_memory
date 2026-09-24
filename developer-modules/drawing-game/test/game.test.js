const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const test = require("node:test");
const Database = require("better-sqlite3");

const game = require("../backend/commands/game");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawing-game-"));
  const context = {
    moduleDataDir: root,
    resolveDataPath(relative) {
      const resolved = path.resolve(root, relative);
      assert.equal(path.relative(root, resolved).startsWith(".."), false);
      return resolved;
    },
  };
  return { root, context, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function call(context, action, payload = {}, threadId = "thread-test") {
  return game.run(context, { action, payload, threadId });
}

test("creates a room and starts a human drawing round", () => {
  const item = fixture();
  try {
    const created = call(item.context, "room-create", { maxRounds: 4 });
    assert.match(created.room.code, /^\d{6}$/u);
    call(item.context, "agent-join", { roomCode: created.room.code });
    const started = call(item.context, "game-start", { roomCode: created.room.code, firstDrawer: "human" });
    assert.equal(started.room.status, "active");
    assert.equal(started.room.maxRounds, 4);
    assert.equal(started.round.drawer, "human");
    assert.ok(started.round.word);
  } finally { item.cleanup(); }
});

test("custom words normalize aliases and reject duplicate normalized values", () => {
  const item = fixture();
  try {
    const state = call(item.context, "word-add", { word: "小蜗牛", aliases: "蜗牛宝宝, snail", category: "我们的词" });
    const added = state.words.find(row => row.word === "小蜗牛");
    assert.deepEqual(added.aliases, ["蜗牛宝宝", "snail"]);
    assert.throws(() => call(item.context, "word-add", { word: " 小 蜗牛 " }), /UNIQUE|unique/iu);
  } finally { item.cleanup(); }
});

test("completed PNG stays in gallery while room events are cleared on end", () => {
  const item = fixture();
  try {
    const created = call(item.context, "room-create");
    call(item.context, "agent-join", { roomCode: created.room.code });
    call(item.context, "game-start", { roomCode: created.room.code, firstDrawer: "human", maxRounds: 1 });
    const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const submitted = call(item.context, "drawing-submit", { roomCode: created.room.code, actor: "human", imageDataUrl: onePixelPng });
    assert.equal(submitted.room.phase, "guessing");
    assert.equal(submitted.gallery.length, 1);
    const ended = call(item.context, "game-end", { roomCode: created.room.code });
    assert.equal(ended.historyCleared, true);
    assert.equal(fs.existsSync(path.join(item.root, ended.gallery[0].imageFile)), true);
    const refreshed = call(item.context, "state", { roomCode: created.room.code });
    assert.deepEqual(refreshed.events, []);
    assert.equal(refreshed.gallery.length, 1);
    const image = call(item.context, "image-read", { roundId: refreshed.gallery[0].id });
    assert.equal(image.mime, "image/png");
    assert.ok(image.data.length > 20);
  } finally { item.cleanup(); }
});

test("normalizes traditional and punctuated answers", () => {
  assert.equal(game.normalizeAnswer(" 蝸、牛！"), "蜗牛");
});

test("a wrong guess stays open for chat and another explicit guess", () => {
  const item = fixture();
  try {
    const created = call(item.context, "room-create");
    call(item.context, "agent-join", { roomCode: created.room.code });
    const started = call(item.context, "game-start", { roomCode: created.room.code, firstDrawer: "human" });
    const answer = started.round.word;
    const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    call(item.context, "drawing-submit", { roomCode: created.room.code, actor: "human", imageDataUrl: onePixelPng });

    const wrong = call(item.context, "guess", { roomCode: created.room.code, actor: "agent", answer: "肯定不是答案" });
    assert.equal(wrong.room.phase, "guessing");
    assert.equal(wrong.round.status, "guessing");

    const chatted = call(item.context, "chat", { roomCode: created.room.code, actor: "human", text: answer });
    assert.equal(chatted.room.phase, "guessing");
    assert.equal(chatted.round.winner, null);

    const correct = call(item.context, "guess", { roomCode: created.room.code, actor: "agent", answer });
    assert.equal(correct.room.phase, "round-complete");
    assert.equal(correct.round.winner, "agent");
    assert.equal(correct.room.scores.agent, 1);
    assert.throws(() => call(item.context, "guess", { roomCode: created.room.code, actor: "agent", answer }), /不能提交|已经结算/u);
  } finally { item.cleanup(); }
});

test("agent views never leak an unfinished human answer through round, words, gallery, or action responses", () => {
  const item = fixture();
  try {
    const created = call(item.context, "room-create");
    call(item.context, "agent-join", { roomCode: created.room.code });
    const started = call(item.context, "game-start", { roomCode: created.room.code, firstDrawer: "human" });
    const answer = started.round.word;
    const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    call(item.context, "drawing-submit", { roomCode: created.room.code, actor: "human", imageDataUrl: onePixelPng });

    const agentState = call(item.context, "agent-state", { roomCode: created.room.code });
    assert.equal(agentState.round.word, "");
    assert.deepEqual(agentState.words, []);
    assert.deepEqual(agentState.gallery, []);
    assert.doesNotMatch(JSON.stringify(agentState), new RegExp(answer, "u"));

    const chatted = call(item.context, "agent-action", { roomCode: created.room.code, kind: "chat", text: "我先看看" });
    assert.equal(chatted.round.word, "");
    assert.deepEqual(chatted.words, []);
    assert.deepEqual(chatted.gallery, []);
    assert.doesNotMatch(JSON.stringify(chatted), new RegExp(answer, "u"));

    const wrong = call(item.context, "agent-action", { roomCode: created.room.code, kind: "guess", answer: "肯定不是答案" });
    assert.equal(wrong.room.phase, "guessing");
    assert.equal(wrong.round.word, "");
    assert.equal(wrong.agent.actionTool, "stmem_drawing_game_agent_action");
    assert.match(wrong.agent.note, /猜词只能调用 stmem_drawing_game_agent_action/u);
    assert.match(wrong.agent.note, /不要调用独立 guess/u);
    assert.doesNotMatch(JSON.stringify(wrong), new RegExp(answer, "u"));
  } finally { item.cleanup(); }
});

test("agent joins and waits from an event cursor without losing room actions", () => {
  const item = fixture();
  try {
    const created = call(item.context, "room-create");
    assert.equal(created.room.agentJoined, false);
    const joined = call(item.context, "agent-join", { roomCode: created.room.code });
    assert.equal(joined.room.agentJoined, true);
    assert.ok(joined.room.eventCursor > created.room.eventCursor);
    assert.deepEqual(joined.agent.actions, ["agent-wait"]);

    const cursor = joined.room.eventCursor;
    call(item.context, "game-start", { roomCode: created.room.code, firstDrawer: "human" });
    const waited = call(item.context, "agent-wait", { roomCode: created.room.code, afterSeq: cursor, timeoutMs: 50 });
    assert.equal(waited.wait.timedOut, false);
    assert.ok(waited.room.eventCursor > cursor);
    assert.deepEqual(waited.events.map(event => event.kind), ["game-start", "round-start"]);
  } finally { item.cleanup(); }
});

test("agent wait returns a heartbeat timeout and keeps its cursor stable", () => {
  const item = fixture();
  try {
    const created = call(item.context, "room-create");
    call(item.context, "agent-join", { roomCode: created.room.code });
    const started = call(item.context, "game-start", { roomCode: created.room.code, firstDrawer: "human" });
    const waited = call(item.context, "agent-wait", { roomCode: created.room.code, afterSeq: started.room.eventCursor, timeoutMs: 50 });
    assert.equal(waited.wait.timedOut, true);
    assert.equal(waited.wait.cursor, started.room.eventCursor);
    assert.equal(waited.wait.continueWaiting, true);
    assert.equal(waited.room.agentJoined, true);
    assert.match(waited.wait.note, /仍在房间中/u);
    assert.deepEqual(waited.events, []);

    call(item.context, "chat", { roomCode: created.room.code, actor: "human", text: "超时以后还能收到我" });
    const resumed = call(item.context, "agent-wait", {
      roomCode: created.room.code,
      afterSeq: waited.wait.cursor,
      timeoutMs: 50,
    });
    assert.equal(resumed.wait.timedOut, false);
    assert.equal(resumed.events.at(-1).text, "超时以后还能收到我");
  } finally { item.cleanup(); }
});

test("a stale wait heartbeat does not remove the agent or block game start", () => {
  const item = fixture();
  try {
    const created = call(item.context, "room-create");
    call(item.context, "agent-join", { roomCode: created.room.code });
    const db = new Database(path.join(item.root, "module.sqlite"));
    db.prepare("UPDATE rooms SET agent_last_seen_at=? WHERE code=?")
      .run("2000-01-01T00:00:00.000Z", created.room.code);
    db.close();

    const stale = call(item.context, "state", { roomCode: created.room.code });
    assert.equal(stale.room.agentJoined, true);
    assert.equal(stale.room.agentOnline, false);
    const started = call(item.context, "game-start", { roomCode: created.room.code, firstDrawer: "human" });
    assert.equal(started.room.status, "active");
  } finally { item.cleanup(); }
});

test("agent wait unblocks when another connection writes a room event", async () => {
  const item = fixture();
  try {
    const created = call(item.context, "room-create");
    const joined = call(item.context, "agent-join", { roomCode: created.room.code });
    const started = call(item.context, "game-start", { roomCode: created.room.code, firstDrawer: "human" });
    const worker = new Worker(`
      const { workerData } = require("node:worker_threads");
      const game = require(workerData.moduleFile);
      const path = require("node:path");
      const root = workerData.root;
      const context = { moduleDataDir: root, resolveDataPath(relative) { return path.resolve(root, relative); } };
      setTimeout(() => game.run(context, { action: "chat", threadId: "thread-test", payload: {
        roomCode: workerData.roomCode, actor: "human", text: "我在房间里"
      }}), 150);
    `, {
      eval: true,
      workerData: {
        moduleFile: path.join(__dirname, "..", "backend", "commands", "game.js"),
        root: item.root,
        roomCode: created.room.code,
      },
    });
    const waited = call(item.context, "agent-wait", { roomCode: created.room.code, afterSeq: started.room.eventCursor, timeoutMs: 3000 });
    const exitCode = await new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", resolve);
    });
    assert.equal(exitCode, 0);
    assert.equal(waited.wait.timedOut, false);
    assert.equal(waited.events.at(-1).kind, "chat");
    assert.equal(waited.events.at(-1).text, "我在房间里");
  } finally { item.cleanup(); }
});

test("either player can give up and reveal without scoring", () => {
  for (const actor of ["human", "agent"]) {
    const item = fixture();
    try {
      const created = call(item.context, "room-create");
      call(item.context, "agent-join", { roomCode: created.room.code });
      call(item.context, "game-start", { roomCode: created.room.code, firstDrawer: "agent" });
      const revealed = call(item.context, "round-reveal", { roomCode: created.room.code, actor });
      assert.equal(revealed.room.phase, "round-complete");
      assert.equal(revealed.round.status, "complete");
      assert.ok(revealed.round.word);
      assert.equal(revealed.round.winner, null);
      assert.deepEqual(revealed.room.scores, { human: 0, agent: 0 });
      assert.match(revealed.events.at(-1).text, /放弃并揭晓答案/u);
    } finally { item.cleanup(); }
  }
});
