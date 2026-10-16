const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const OpenCC = require("opencc-js");

const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });
const MAX_EVENT_TEXT = 1200;
const MAX_IMAGE_BYTES = 900 * 1024;
const MAX_STROKES = 240;
const MAX_POINTS_PER_STROKE = 360;
const MAX_WAIT_MS = 25_000;
const WAIT_POLL_MS = 150;
// A completed long-poll is only a heartbeat, not room membership. Keep the
// visual "waiting" hint forgiving enough for a model to process an event and
// issue its next tool call without making the UI look as if it left the room.
const AGENT_ONLINE_WINDOW_MS = 180_000;

const DEFAULT_WORDS = [
  ["蜗牛", "动物", "简单"], ["蝴蝶", "动物", "简单"], ["长颈鹿", "动物", "简单"], ["企鹅", "动物", "简单"],
  ["水母", "动物", "普通"], ["章鱼", "动物", "普通"], ["大熊猫", "动物", "简单"], ["袋鼠", "动物", "简单"],
  ["刺猬", "动物", "简单"], ["猫头鹰", "动物", "普通"], ["海豚", "动物", "简单"], ["孔雀", "动物", "普通"],
  ["骆驼", "动物", "简单"], ["松鼠", "动物", "简单"], ["斑马", "动物", "简单"], ["啄木鸟", "动物", "普通"],
  ["变色龙", "动物", "困难"], ["寄居蟹", "动物", "困难"],

  ["咖啡", "食物", "简单"], ["火锅", "食物", "简单"], ["生日蛋糕", "食物", "普通"], ["冰淇淋", "食物", "简单"],
  ["汉堡", "食物", "简单"], ["爆米花", "食物", "简单"], ["西瓜", "食物", "简单"], ["草莓", "食物", "简单"],
  ["甜甜圈", "食物", "普通"], ["糖葫芦", "食物", "普通"], ["饺子", "食物", "简单"], ["寿司", "食物", "普通"],
  ["珍珠奶茶", "食物", "普通"], ["棉花糖", "食物", "普通"], ["方便面", "食物", "普通"], ["煎鸡蛋", "食物", "简单"],

  ["雨伞", "物品", "简单"], ["机器人", "物品", "普通"], ["望远镜", "物品", "普通"], ["闹钟", "物品", "简单"],
  ["眼镜", "物品", "简单"], ["钥匙", "物品", "简单"], ["吉他", "物品", "简单"], ["相机", "物品", "简单"],
  ["耳机", "物品", "简单"], ["行李箱", "物品", "普通"], ["热气球", "物品", "普通"], ["指南针", "物品", "困难"],
  ["显微镜", "物品", "困难"], ["灭火器", "物品", "普通"], ["回形针", "物品", "困难"], ["自动售货机", "物品", "困难"],
  ["旋转木马", "物品", "普通"], ["宇宙飞船", "物品", "普通"],

  ["海风", "自然", "普通"], ["流星", "自然", "简单"], ["火山", "自然", "普通"], ["彩虹", "自然", "简单"],
  ["闪电", "自然", "简单"], ["龙卷风", "自然", "普通"], ["瀑布", "自然", "简单"], ["雪人", "自然", "简单"],
  ["月牙", "自然", "简单"], ["日落", "自然", "普通"], ["沙漠", "自然", "简单"], ["珊瑚礁", "自然", "困难"],
  ["北极光", "自然", "困难"], ["海市蜃楼", "自然", "困难"],

  ["看电影", "动作", "普通"], ["拥抱", "动作", "简单"], ["放风筝", "动作", "普通"], ["刷牙", "动作", "简单"],
  ["跳绳", "动作", "简单"], ["钓鱼", "动作", "简单"], ["游泳", "动作", "简单"], ["拍照", "动作", "简单"],
  ["打哈欠", "动作", "普通"], ["堆雪人", "动作", "简单"], ["吹泡泡", "动作", "普通"], ["拆礼物", "动作", "普通"],
  ["坐过山车", "动作", "普通"], ["追公交车", "动作", "困难"], ["梦游", "动作", "困难"], ["狼吞虎咽", "动作", "困难"],
  ["掩耳盗铃", "动作", "困难"], ["守株待兔", "动作", "困难"],

  ["电影院", "地点", "简单"], ["游乐园", "地点", "简单"], ["图书馆", "地点", "简单"], ["海底", "地点", "普通"],
  ["太空站", "地点", "普通"], ["动物园", "地点", "简单"], ["火车站", "地点", "简单"], ["露营地", "地点", "普通"],
  ["灯塔", "地点", "简单"], ["迷宫", "地点", "普通"], ["金字塔", "地点", "普通"], ["无人岛", "地点", "普通"],
  ["秘密基地", "地点", "困难"], ["海底隧道", "地点", "困难"],

  ["医生", "职业", "简单"], ["消防员", "职业", "简单"], ["宇航员", "职业", "简单"], ["厨师", "职业", "简单"],
  ["魔术师", "职业", "普通"], ["摄影师", "职业", "普通"], ["潜水员", "职业", "普通"], ["侦探", "职业", "普通"],
  ["考古学家", "职业", "困难"], ["天气预报员", "职业", "困难"], ["指挥家", "职业", "困难"], ["守门员", "职业", "普通"],

  ["春天", "时间", "简单"], ["午夜", "时间", "普通"], ["周末", "时间", "普通"], ["童年", "时间", "困难"],
  ["未来", "时间", "困难"], ["倒计时", "时间", "困难"], ["迟到", "时间", "普通"], ["一见钟情", "关系", "困难"],
  ["心有灵犀", "关系", "困难"], ["和好", "关系", "普通"], ["想念", "关系", "困难"], ["惊喜", "情绪", "普通"],
  ["害羞", "情绪", "普通"], ["吃醋", "情绪", "普通"], ["勇气", "抽象", "困难"], ["自由", "抽象", "困难"],
  ["秘密", "抽象", "困难"], ["好运", "抽象", "普通"], ["默契", "抽象", "困难"], ["白日梦", "抽象", "困难"],
];

function run(context, input) {
  const action = String(input.action || "").trim();
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  fs.mkdirSync(context.moduleDataDir, { recursive: true });
  fs.mkdirSync(context.resolveDataPath("gallery"), { recursive: true });
  const db = openDatabase(context.resolveDataPath("module.sqlite"));
  try {
    seedWords(db);
    const handlers = {
      state: () => readState(db, context, payload),
      "agent-state": () => readState(db, context, { ...payload, viewer: "agent", excludeDrawing: true }),
      "agent-join": () => agentJoin(db, context, payload),
      "agent-wait": () => agentWait(db, context, payload),
      "room-create": () => createRoom(db, context, payload, input.threadId),
      "game-start": () => startGame(db, context, payload),
      chat: () => addChat(db, context, payload),
      guess: () => addGuess(db, context, payload),
      "round-reveal": () => revealRound(db, context, payload),
      "drawing-submit": () => submitDrawing(db, context, payload),
      "round-next": () => nextRound(db, context, payload),
      "game-end": () => endGame(db, context, payload),
      "word-add": () => addWord(db, context, payload),
      "word-delete": () => deleteWord(db, context, payload),
      "image-read": () => readImage(db, context, payload),
      "settings-save": () => saveSettings(db, context, payload),
      "agent-action": () => agentAction(db, context, payload),
    };
    if (!handlers[action]) throw new Error(`不支持的游戏命令：${action}`);
    return handlers[action]();
  } finally {
    db.close();
  }
}

function openDatabase(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      normalized TEXT NOT NULL UNIQUE,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT '自定义',
      difficulty TEXT NOT NULL DEFAULT '普通',
      source TEXT NOT NULL DEFAULT 'custom',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      round_no INTEGER NOT NULL DEFAULT 0,
      max_rounds INTEGER NOT NULL DEFAULT 6,
      drawer TEXT,
      scores_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS rounds (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      drawer TEXT NOT NULL,
      word_id TEXT NOT NULL,
      word TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      image_file TEXT,
      drawing_json TEXT,
      winner TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(room_id, number)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(room_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_events_room_seq ON events(room_id, seq);
    CREATE INDEX IF NOT EXISTS idx_rounds_room_number ON rounds(room_id, number);
  `);
  ensureRoomColumn(db, "event_seq", "INTEGER NOT NULL DEFAULT 0");
  ensureRoomColumn(db, "agent_joined_at", "TEXT");
  ensureRoomColumn(db, "agent_last_seen_at", "TEXT");
  db.exec(`UPDATE rooms
    SET event_seq = MAX(event_seq, COALESCE((SELECT MAX(events.seq) FROM events WHERE events.room_id=rooms.id), 0))`);
  return db;
}

function ensureRoomColumn(db, name, definition) {
  const columns = new Set(db.pragma("table_info(rooms)").map(column => column.name));
  if (!columns.has(name)) db.exec(`ALTER TABLE rooms ADD COLUMN ${name} ${definition}`);
}

function seedWords(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO words
    (id, word, normalized, aliases_json, category, difficulty, source, enabled, created_at)
    VALUES (?, ?, ?, '[]', ?, ?, 'builtin', 1, ?)`);
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    for (const [word, category, difficulty] of DEFAULT_WORDS) {
      insert.run(`builtin-${hashId(word)}`, word, normalizeAnswer(word), category, difficulty, now);
    }
  });
  transaction();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('humanName','你'),('agentName','AI')").run();
}

function createRoom(db, context, payload, threadId) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const code = uniqueRoomCode(db);
  const maxRounds = clampInteger(payload.maxRounds, 1, 20, 6);
  const settings = readSettings(db);
  db.prepare(`INSERT INTO rooms
    (id, code, thread_id, status, phase, max_rounds, scores_json, created_at, updated_at)
    VALUES (?, ?, ?, 'lobby', 'waiting', ?, ?, ?, ?)`)
    .run(id, code, cleanText(threadId, 200), maxRounds, JSON.stringify({ human: 0, agent: 0 }), now, now);
  appendEvent(db, id, "system", "system", `房间 ${code} 已创建。`);
  return readState(db, context, { roomCode: code });
}

function agentJoin(db, context, payload) {
  const room = requireRoom(db, payload.roomCode);
  if (room.status === "ended") throw new Error("房间已经结束，请创建新房间");
  const now = new Date().toISOString();
  const firstJoin = !room.agent_joined_at;
  db.prepare("UPDATE rooms SET agent_joined_at=COALESCE(agent_joined_at,?),agent_last_seen_at=?,updated_at=? WHERE id=?")
    .run(now, now, now, room.id);
  if (firstJoin) appendEvent(db, room.id, "agent-join", "agent", `${readSettings(db).agentName}进入了房间。`);
  return readState(db, context, { roomCode: room.code, viewer: "agent", excludeDrawing: true });
}

function agentWait(db, context, payload) {
  const initial = requireRoom(db, payload.roomCode);
  if (!initial.agent_joined_at) throw new Error("AI尚未加入房间，请先调用 agent-join");
  const afterSeq = clampInteger(payload.afterSeq, 0, Number.MAX_SAFE_INTEGER, 0);
  const timeoutMs = clampInteger(payload.timeoutMs, 50, MAX_WAIT_MS, MAX_WAIT_MS);
  const deadline = Date.now() + timeoutMs;
  db.prepare("UPDATE rooms SET agent_last_seen_at=? WHERE id=?").run(new Date().toISOString(), initial.id);

  while (true) {
    const room = requireRoom(db, initial.code);
    const cursor = Number(room.event_seq || 0);
    if (cursor > afterSeq || room.status === "ended") {
      const result = readState(db, context, { roomCode: room.code, viewer: "agent", afterSeq, excludeDrawing: true });
      return {
        ...result,
        wait: {
          afterSeq,
          cursor,
          timedOut: false,
          continueWaiting: room.status !== "ended",
        },
      };
    }
    if (Date.now() >= deadline) {
      return {
        room: {
          code: room.code,
          status: room.status,
          eventCursor: cursor,
        },
        events: [],
        wait: {
          cursor,
          timedOut: true,
          continueWaiting: room.status !== "ended",
        },
      };
    }
    sleep(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function startGame(db, context, payload) {
  const room = requireRoom(db, payload.roomCode);
  if (!new Set(["lobby", "ended"]).has(room.status)) throw new Error("房间已经在游戏中");
  if (!room.agent_joined_at) throw new Error("AI尚未进入房间，请先邀请AI加入房间");
  const maxRounds = clampInteger(payload.maxRounds, 1, 20, room.max_rounds || 6);
  const drawer = payload.firstDrawer === "agent" ? "agent" : "human";
  const settings = readSettings(db);
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM events WHERE room_id=?").run(room.id);
    db.prepare("DELETE FROM rounds WHERE room_id=?").run(room.id);
    db.prepare(`UPDATE rooms SET status='active',phase='drawing',round_no=1,max_rounds=?,drawer=?,scores_json=?,ended_at=NULL,updated_at=? WHERE id=?`)
      .run(maxRounds, drawer, JSON.stringify({ human: 0, agent: 0 }), now, room.id);
    createRound(db, room.id, 1, drawer);
    appendEvent(db, room.id, "game-start", "system", `游戏开始，共 ${maxRounds} 轮。`);
    appendEvent(db, room.id, "round-start", "system", `第1轮由${drawer === "agent" ? settings.agentName : settings.humanName}作画。`);
  });
  transaction();
  return readState(db, context, { roomCode: room.code });
}

function addChat(db, context, payload) {
  const room = requireActiveRoom(db, payload.roomCode);
  const actor = normalizeActor(payload.actor, "human");
  const text = requireText(payload.text, "聊天内容", MAX_EVENT_TEXT);
  appendEvent(db, room.id, "chat", actor, text);
  touchRoom(db, room.id);
  return readState(db, context, { roomCode: room.code });
}

function addGuess(db, context, payload) {
  const room = requireActiveRoom(db, payload.roomCode);
  if (room.phase !== "guessing") throw new Error("当前还不能提交答案");
  const actor = normalizeActor(payload.actor, "human");
  if (actor === room.drawer) throw new Error("作画者不能猜自己的题目");
  const answer = requireText(payload.answer || payload.text, "答案", 120);
  const round = currentRound(db, room);
  if (round.status !== "guessing") throw new Error("本轮已经结算");
  const accepted = [round.word, ...parseJson(round.aliases_json, [])].map(normalizeAnswer);
  const correct = accepted.includes(normalizeAnswer(answer));
  appendEvent(db, room.id, "guess", actor, answer, { correct });
  if (correct) {
    const scores = parseJson(room.scores_json, { human: 0, agent: 0 });
    scores[actor] = Number(scores[actor] || 0) + 1;
    const now = new Date().toISOString();
    const transaction = db.transaction(() => {
      const locked = db.prepare("UPDATE rounds SET status='complete',winner=?,completed_at=? WHERE id=? AND status='guessing'").run(actor, now, round.id);
      if (locked.changes !== 1) throw new Error("本轮已经结算");
      db.prepare("UPDATE rooms SET phase='round-complete',scores_json=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(scores), now, room.id);
      const settings = readSettings(db);
      appendEvent(db, room.id, "round-result", "system", `${actor === "agent" ? settings.agentName : settings.humanName}猜中了，答案是“${round.word}”。`, { answer: round.word, winner: actor });
    });
    transaction();
  }
  return readState(db, context, { roomCode: room.code });
}

function revealRound(db, context, payload) {
  const room = requireActiveRoom(db, payload.roomCode);
  if (!new Set(["drawing", "guessing"]).has(room.phase)) throw new Error("本轮已经结算");
  const actor = normalizeActor(payload.actor, "human");
  completeRoundWithoutWinner(db, context, room, actor);
  return readState(db, context, { roomCode: room.code });
}

function submitDrawing(db, context, payload) {
  const room = requireActiveRoom(db, payload.roomCode);
  if (room.phase !== "drawing") throw new Error("当前不是作画阶段");
  const actor = normalizeActor(payload.actor, "human");
  if (actor !== room.drawer) throw new Error("现在没有轮到这个玩家作画");
  const round = currentRound(db, room);
  const imageFile = savePng(context, room, round, payload.imageDataUrl);
  const now = new Date().toISOString();
  db.prepare("UPDATE rounds SET image_file=?,status='guessing',drawing_json=NULL WHERE id=?").run(imageFile, round.id);
  db.prepare("UPDATE rooms SET phase='guessing',updated_at=? WHERE id=?").run(now, room.id);
  const settings = readSettings(db);
  appendEvent(db, room.id, "drawing", actor, `${actor === "agent" ? settings.agentName : settings.humanName}画好了。`, { imageFile });
  return readState(db, context, { roomCode: room.code });
}

function nextRound(db, context, payload) {
  const room = requireActiveRoom(db, payload.roomCode);
  if (room.phase !== "round-complete") throw new Error("当前回合还没有结束");
  if (room.round_no >= room.max_rounds) return endGame(db, context, payload);
  const number = room.round_no + 1;
  const drawer = room.drawer === "agent" ? "human" : "agent";
  const settings = readSettings(db);
  const now = new Date().toISOString();
  db.prepare("UPDATE rooms SET round_no=?,drawer=?,phase='drawing',updated_at=? WHERE id=?").run(number, drawer, now, room.id);
  createRound(db, room.id, number, drawer);
  appendEvent(db, room.id, "round-start", "system", `第${number}轮由${drawer === "agent" ? settings.agentName : settings.humanName}作画。`);
  return readState(db, context, { roomCode: room.code });
}

function endGame(db, context, payload) {
  const room = requireRoom(db, payload.roomCode);
  if (room.status === "ended") return readState(db, context, { roomCode: room.code });
  const now = new Date().toISOString();
  appendEvent(db, room.id, "game-end", "system", "游戏结束，恢复普通聊天模式。");
  const finalState = readState(db, context, { roomCode: room.code, revealAnswer: true });
  db.prepare("UPDATE rooms SET status='ended',phase='ended',ended_at=?,updated_at=? WHERE id=?").run(now, now, room.id);
  db.prepare("DELETE FROM events WHERE room_id=?").run(room.id);
  return { ...finalState, room: { ...finalState.room, status: "ended", phase: "ended", endedAt: now }, historyCleared: true };
}

function addWord(db, context, payload) {
  const word = requireText(payload.word, "词语", 40);
  const normalized = normalizeAnswer(word);
  if (normalized.length < 2) throw new Error("词语至少需要两个字符");
  const aliases = normalizeAliases(payload.aliases, word);
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO words
    (id,word,normalized,aliases_json,category,difficulty,source,enabled,created_at)
    VALUES (?,?,?,?,?,?,'custom',1,?)`)
    .run(id, word, normalized, JSON.stringify(aliases), cleanText(payload.category, 30) || "自定义", normalizeDifficulty(payload.difficulty), new Date().toISOString());
  return readState(db, context, { roomCode: payload.roomCode });
}

function deleteWord(db, context, payload) {
  const id = cleanText(payload.wordId, 100);
  const word = db.prepare("SELECT * FROM words WHERE id=?").get(id);
  if (!word) throw new Error("词语不存在");
  if (word.source === "builtin") throw new Error("基础词不能删除，可以在后续版本中停用");
  db.prepare("DELETE FROM words WHERE id=?").run(id);
  return readState(db, context, { roomCode: payload.roomCode });
}

function readImage(db, context, payload) {
  const roundId = cleanText(payload.roundId, 100);
  const row = db.prepare("SELECT image_file FROM rounds WHERE id=? AND image_file IS NOT NULL").get(roundId);
  if (!row) throw new Error("画作不存在");
  const file = context.resolveDataPath(row.image_file);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("画作文件不存在");
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("画作文件过大");
  return { roundId, mime: "image/png", data: bytes.toString("base64") };
}

function saveSettings(db, context, payload) {
  const humanName = requireText(payload.humanName, "你的名字", 24);
  const agentName = requireText(payload.agentName, "AI名字", 24);
  const write = db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const transaction = db.transaction(() => {
    write.run("humanName", humanName);
    write.run("agentName", agentName);
  });
  transaction();
  return readState(db, context, { roomCode: payload.roomCode });
}

function agentAction(db, context, payload) {
  const kind = cleanText(payload.kind, 40);
  const common = { ...payload, actor: "agent" };
  const beforeSeq = Number(requireRoom(db, payload.roomCode).event_seq || 0);
  if (kind === "chat") {
    addChat(db, context, { ...common, text: payload.text });
    return readState(db, context, { roomCode: payload.roomCode, viewer: "agent", afterSeq: beforeSeq, excludeDrawing: true });
  }
  if (kind === "guess") {
    addGuess(db, context, { ...common, answer: payload.answer });
    return readState(db, context, { roomCode: payload.roomCode, viewer: "agent", afterSeq: beforeSeq, excludeDrawing: true });
  }
  if (kind === "reveal") {
    revealRound(db, context, common);
    return readState(db, context, { roomCode: payload.roomCode, viewer: "agent", afterSeq: beforeSeq, excludeDrawing: true });
  }
  if (kind === "next") {
    nextRound(db, context, common);
    return readState(db, context, { roomCode: payload.roomCode, viewer: "agent", afterSeq: beforeSeq, excludeDrawing: true });
  }
  if (kind === "draw") {
    const room = requireActiveRoom(db, payload.roomCode);
    if (room.phase !== "drawing" || room.drawer !== "agent") throw new Error("当前没有轮到AI作画");
    const strokes = normalizeStrokes(payload.strokes);
    db.prepare("UPDATE rounds SET drawing_json=? WHERE id=?").run(JSON.stringify(strokes), currentRound(db, room).id);
    appendEvent(db, room.id, "drawing-plan", "agent", `${readSettings(db).agentName}开始画了。`, { strokeCount: strokes.length });
    touchRoom(db, room.id);
    return readState(db, context, { roomCode: room.code, viewer: "agent", afterSeq: beforeSeq, excludeDrawing: true });
  }
  throw new Error("不支持的AI游戏动作");
}

function readState(db, context, payload = {}) {
  const room = payload.roomCode ? findRoom(db, payload.roomCode) : db.prepare("SELECT * FROM rooms ORDER BY updated_at DESC LIMIT 1").get();
  const words = db.prepare("SELECT id,word,aliases_json,category,difficulty,source,enabled FROM words ORDER BY source DESC,category,word").all()
    .map(row => ({ ...row, aliases: parseJson(row.aliases_json, []), aliases_json: undefined, enabled: Boolean(row.enabled) }));
  const gallery = db.prepare(`SELECT r.id,r.room_id roomId,r.number,r.drawer,r.word,r.image_file imageFile,r.completed_at completedAt,rooms.code roomCode
    FROM rounds r JOIN rooms ON rooms.id=r.room_id WHERE r.image_file IS NOT NULL ORDER BY COALESCE(r.completed_at,r.created_at) DESC LIMIT 120`).all();
  const settings = readSettings(db);
  if (!room) return { room: null, words, gallery, settings };
  const round = currentRound(db, room, false);
  const afterSeq = clampInteger(payload.afterSeq, 0, Number.MAX_SAFE_INTEGER, 0);
  const events = room.status === "ended" ? [] : db.prepare("SELECT id,seq,kind,actor,text,meta_json,created_at createdAt FROM events WHERE room_id=? AND seq>? ORDER BY seq").all(room.id, afterSeq)
    .map(row => ({ ...row, meta: parseJson(row.meta_json, {}), meta_json: undefined }));
  const viewer = payload.viewer === "agent" ? "agent" : "human";
  const reveal = payload.revealAnswer === true || round?.status === "complete" || room.status === "ended" || round?.drawer === viewer;
  const result = {
    room: {
      id: room.id,
      code: room.code,
      status: room.status,
      phase: room.phase,
      roundNo: room.round_no,
      maxRounds: room.max_rounds,
      drawer: room.drawer,
      scores: parseJson(room.scores_json, { human: 0, agent: 0 }),
      createdAt: room.created_at,
      updatedAt: room.updated_at,
      endedAt: room.ended_at,
      threadBound: Boolean(room.thread_id),
      eventCursor: Number(room.event_seq || 0),
      agentJoined: Boolean(room.agent_joined_at),
      agentOnline: isAgentOnline(room),
      agentJoinedAt: room.agent_joined_at,
      agentLastSeenAt: room.agent_last_seen_at,
    },
    round: round ? {
      id: round.id,
      number: round.number,
      drawer: round.drawer,
      status: round.status,
      word: reveal ? round.word : "",
      wordLength: [...round.word].length,
      hasImage: Boolean(round.image_file),
      drawing: payload.excludeDrawing !== true && (payload.includeDrawing === true || round.drawer === "agent") ? parseJson(round.drawing_json, null) : null,
      winner: round.winner,
    } : null,
    events,
    words: viewer === "agent" ? [] : words,
    gallery: viewer === "agent" ? [] : gallery,
    settings,
  };
  if (viewer === "agent") result.agent = agentGuidance(room, round);
  return result;
}

function agentGuidance(room, round) {
  if (room.status === "lobby") return { role: "player", actionTool: "stmem_drawing_game_agent_action", actions: ["agent-wait"], note: "你已进入房间。用 room.eventCursor 作为 afterSeq 调用 stmem_drawing_game_agent_wait；处理事件或等待超时后立即再次等待。所有AI写动作唯一入口是 stmem_drawing_game_agent_action；不要调用底层 guess、chat、draw 或 next 命令。游戏期间不要把房间回复发到外部聊天。" };
  if (!round || room.status !== "active") return { role: "observer", actions: ["agent-state"] };
  if (room.phase === "round-complete") return { role: "observer", actionTool: "stmem_drawing_game_agent_action", actions: ["chat", "next", "agent-wait"], note: "本轮已经结算，不要重复提交答案；只能调用 stmem_drawing_game_agent_action 并传 kind=next 进入下一轮，不要调用底层 next 命令。完成动作后用最新 eventCursor 继续 stmem_drawing_game_agent_wait。" };
  if (round.drawer === "agent" && room.phase === "drawing") {
    return { role: "drawer", actionTool: "stmem_drawing_game_agent_action", actions: ["draw", "chat", "reveal", "agent-wait"], note: "所有写动作只能调用 stmem_drawing_game_agent_action：作画传 kind=draw 与 strokes，聊天传 kind=chat 与 text，放弃传 kind=reveal。不要调用底层 draw/chat/reveal 命令。完成动作后用最新 eventCursor 继续 stmem_drawing_game_agent_wait。" };
  }
  if (round.drawer === "human" && room.phase === "guessing") {
    return { role: "guesser", actionTool: "stmem_drawing_game_agent_action", actions: ["guess", "chat", "reveal", "agent-wait"], imageAction: "stmem_drawing_game_image_read", roundId: round.id, note: `猜词只能调用 stmem_drawing_game_agent_action，参数示例：{\"roomCode\":\"${room.code}\",\"kind\":\"guess\",\"answer\":\"你的答案\"}。不要调用独立 guess 工具或底层 guess 命令。猜错后仍可再次 kind=guess；聊天必须用同一工具传 kind=chat、text=内容，不会自动成为答案。完成动作后用最新 eventCursor 继续 stmem_drawing_game_agent_wait。` };
  }
  return { role: "observer", actionTool: "stmem_drawing_game_agent_action", actions: ["chat", "reveal", "agent-wait"], note: "等待对方完成当前动作；如需聊天或放弃，只能调用 stmem_drawing_game_agent_action 并传对应 kind。用最新 eventCursor 调用 stmem_drawing_game_agent_wait。" };
}

function isAgentOnline(room) {
  const lastSeen = Date.parse(String(room?.agent_last_seen_at || ""));
  return Boolean(room?.agent_joined_at) && Number.isFinite(lastSeen) && Date.now() - lastSeen <= AGENT_ONLINE_WINDOW_MS;
}

function createRound(db, roomId, number, drawer) {
  const candidates = db.prepare("SELECT * FROM words WHERE enabled=1 ORDER BY RANDOM() LIMIT 30").all();
  if (!candidates.length) throw new Error("词库为空，请先添加词语");
  const prior = new Set(db.prepare("SELECT word_id FROM rounds WHERE room_id=?").all(roomId).map(row => row.word_id));
  const word = candidates.find(row => !prior.has(row.id)) || candidates[0];
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO rounds
    (id,room_id,number,drawer,word_id,word,aliases_json,status,created_at)
    VALUES (?,?,?,?,?,?,?,'drawing',?)`)
    .run(id, roomId, number, drawer, word.id, word.word, word.aliases_json, new Date().toISOString());
  return id;
}

function completeRoundWithoutWinner(db, context, room, actor) {
  const round = currentRound(db, room);
  const now = new Date().toISOString();
  const settings = readSettings(db);
  const label = actor === "agent" ? settings.agentName : settings.humanName;
  const message = `${label}选择放弃并揭晓答案：“${round.word}”。`;
  const transaction = db.transaction(() => {
    const locked = db.prepare("UPDATE rounds SET status='complete',winner=NULL,completed_at=? WHERE id=? AND status!='complete'").run(now, round.id);
    if (locked.changes !== 1) return false;
    db.prepare("UPDATE rooms SET phase='round-complete',updated_at=? WHERE id=?").run(now, room.id);
    appendEvent(db, room.id, "round-result", "system", message, { answer: round.word, reason: "revealed", actor });
    return true;
  });
  const completed = transaction();
  return completed;
}

function savePng(context, room, round, dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/u.exec(String(dataUrl || ""));
  if (!match) throw new Error("请提交PNG画作");
  const bytes = Buffer.from(match[1].replace(/\s/gu, ""), "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("画作文件过大");
  if (bytes.length < 8 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("画作不是有效PNG");
  const roomDir = context.resolveDataPath(path.join("gallery", room.code));
  fs.mkdirSync(roomDir, { recursive: true });
  const relative = path.join("gallery", room.code, `round-${round.number}-${round.drawer}.png`).replace(/\\/gu, "/");
  const target = context.resolveDataPath(relative);
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return relative;
}

function normalizeStrokes(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_STROKES) throw new Error("画笔轨迹数量无效");
  return value.map((stroke, strokeIndex) => {
    const points = Array.isArray(stroke?.points) ? stroke.points : [];
    if (points.length < 2 || points.length > MAX_POINTS_PER_STROKE) throw new Error(`第${strokeIndex + 1}笔的点数无效`);
    return {
      color: /^#[0-9a-f]{6}$/iu.test(String(stroke.color || "")) ? String(stroke.color).toLowerCase() : "#18230f",
      width: clampNumber(stroke.width, 2, 48, 10),
      points: points.map((point) => {
        if (!Array.isArray(point) || point.length < 2) throw new Error("画笔坐标格式无效");
        return [clampNumber(point[0], 0, 1000, 0), clampNumber(point[1], 0, 1000, 0)];
      }),
    };
  });
}

function appendEvent(db, roomId, kind, actor, text = "", meta = {}) {
  const updated = db.prepare("UPDATE rooms SET event_seq=event_seq+1 WHERE id=? RETURNING event_seq").get(roomId);
  if (!updated) throw new Error("房间不存在");
  const next = Number(updated.event_seq);
  db.prepare("INSERT INTO events (id,room_id,seq,kind,actor,text,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), roomId, next, kind, actor, cleanText(text, MAX_EVENT_TEXT), JSON.stringify(meta || {}), new Date().toISOString());
}

function requireRoom(db, code) {
  const room = findRoom(db, code);
  if (!room) throw new Error("房间不存在");
  return room;
}

function requireActiveRoom(db, code) {
  const room = requireRoom(db, code);
  if (room.status !== "active") throw new Error("房间当前没有进行中的游戏");
  return room;
}

function findRoom(db, code) {
  const normalized = cleanText(code, 20);
  return normalized ? db.prepare("SELECT * FROM rooms WHERE code=? OR id=?").get(normalized, normalized) : null;
}

function currentRound(db, room, required = true) {
  const row = room?.round_no ? db.prepare("SELECT * FROM rounds WHERE room_id=? AND number=?").get(room.id, room.round_no) : null;
  if (!row && required) throw new Error("当前回合不存在");
  return row || null;
}

function touchRoom(db, roomId) {
  db.prepare("UPDATE rooms SET updated_at=? WHERE id=?").run(new Date().toISOString(), roomId);
}

function uniqueRoomCode(db) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = String(crypto.randomInt(100000, 1000000));
    if (!db.prepare("SELECT 1 FROM rooms WHERE code=?").get(code)) return code;
  }
  throw new Error("暂时无法生成房间号，请重试");
}

function normalizeActor(value, fallback) {
  return value === "agent" ? "agent" : value === "human" ? "human" : fallback;
}

function readSettings(db) {
  const values = Object.fromEntries(db.prepare("SELECT key,value FROM settings").all().map(row => [row.key, row.value]));
  return { humanName: values.humanName || "你", agentName: values.agentName || "AI" };
}

function normalizeAliases(value, word) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[，,、\n]/u);
  return [...new Set(source.map(item => cleanText(item, 40)).filter(Boolean))]
    .filter(item => normalizeAnswer(item) !== normalizeAnswer(word)).slice(0, 20);
}

function normalizeDifficulty(value) {
  return new Set(["简单", "普通", "困难"]).has(value) ? value : "普通";
}

function normalizeAnswer(value) {
  return toSimplified(String(value || "")).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").trim();
}

function requireText(value, label, max) {
  const text = cleanText(value, max);
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function cleanText(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function hashId(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

module.exports = { run, normalizeAnswer, normalizeStrokes };
