const roomCode = { type: "string", minLength: 1, maxLength: 20, description: "六位房间号" };
const annotations = (readOnly, idempotent) => ({
  readOnlyHint: readOnly,
  destructiveHint: false,
  idempotentHint: idempotent,
  openWorldHint: false,
});

const tools = [
  {
    name: "agent_join",
    description: "加入一个你画我猜房间。加入后读取 room.eventCursor，并继续调用 agent_wait 等待房间事件。收到动作后，所有AI写操作都必须通过 stmem_drawing_game_agent_action 提交；不要调用底层 guess、chat、draw 或 next 命令。",
    inputSchema: {
      type: "object",
      properties: { roomCode },
      required: ["roomCode"],
      additionalProperties: false,
    },
    annotations: annotations(false, true),
  },
  {
    name: "agent_wait",
    description: "在已加入的房间等待新事件。afterSeq 使用上一次返回的 room.eventCursor；超时且游戏未结束时继续等待。需要猜词时调用 stmem_drawing_game_agent_action，参数 kind=guess、answer=答案；不要调用独立 guess 工具或底层 guess 命令。",
    inputSchema: {
      type: "object",
      properties: {
        roomCode,
        afterSeq: { type: "integer", minimum: 0 },
        timeoutMs: { type: "integer", minimum: 50, maximum: 25000, default: 25000 },
      },
      required: ["roomCode", "afterSeq"],
      additionalProperties: false,
    },
    annotations: annotations(false, false),
  },
  {
    name: "agent_state",
    description: "读取AI玩家可见的房间状态，不返回完整词库、图库索引或未揭晓答案。",
    inputSchema: {
      type: "object",
      properties: { roomCode },
      required: ["roomCode"],
      additionalProperties: false,
    },
    annotations: annotations(false, true),
  },
  {
    name: "agent_action",
    description: "AI在房间中提交写动作的唯一MCP入口。不要调用独立的 guess、chat、draw、reveal 或 next 工具，也不要调用底层模块命令。猜词必须调用本工具并传 kind=guess、answer=答案；聊天传 kind=chat、text=内容。猜错后仍可再次 kind=guess，聊天不会自动当作答案。",
    inputSchema: {
      type: "object",
      properties: {
        roomCode,
        kind: { type: "string", enum: ["draw", "guess", "chat", "reveal", "next"], description: "动作类型；必须作为 stmem_drawing_game_agent_action 的参数提交，不是独立工具名。" },
        text: { type: "string", maxLength: 1200 },
        answer: { type: "string", maxLength: 120, description: "kind=guess 时必填，例如 {\"roomCode\":\"123456\",\"kind\":\"guess\",\"answer\":\"月牙\"}。" },
        strokes: {
          type: "array",
          minItems: 1,
          maxItems: 240,
          items: {
            type: "object",
            properties: {
              color: { type: "string", minLength: 7, maxLength: 7 },
              width: { type: "number", minimum: 2, maximum: 48 },
              points: {
                type: "array",
                minItems: 2,
                maxItems: 360,
                items: {
                  type: "array",
                  minItems: 2,
                  maxItems: 2,
                  items: { type: "number", minimum: 0, maximum: 1000 },
                },
              },
            },
            required: ["points"],
            additionalProperties: false,
          },
        },
      },
      required: ["roomCode", "kind"],
      additionalProperties: false,
    },
    annotations: annotations(false, false),
  },
  {
    name: "image_read",
    description: "读取当前猜题画作。roundId 来自 agent_state 或 agent_wait 返回的 agent.roundId。",
    inputSchema: {
      type: "object",
      properties: { roundId: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["roundId"],
      additionalProperties: false,
    },
    annotations: annotations(false, true),
  },
];

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
}

function compactAgentResult(result) {
  const room = result?.room ? {
    code: result.room.code,
    status: result.room.status,
    phase: result.room.phase,
    roundNo: result.room.roundNo,
    maxRounds: result.room.maxRounds,
    drawer: result.room.drawer,
    scores: result.room.scores,
    eventCursor: result.room.eventCursor,
    agentJoined: result.room.agentJoined,
    agentOnline: result.room.agentOnline,
  } : null;
  for (const key of Object.keys(room || {})) if (room[key] === undefined) delete room[key];
  const round = result?.round ? {
    id: result.round.id,
    number: result.round.number,
    drawer: result.round.drawer,
    status: result.round.status,
    word: result.round.word || undefined,
    wordLength: result.round.wordLength,
    hasImage: result.round.hasImage,
    winner: result.round.winner || undefined,
  } : null;
  for (const key of Object.keys(round || {})) if (round[key] === undefined) delete round[key];
  const events = (result?.events || []).map(event => ({
    seq: event.seq,
    kind: event.kind,
    actor: event.actor,
    text: event.text,
    ...(event.meta && Object.keys(event.meta).length ? { meta: event.meta } : {}),
  }));
  const agent = result?.agent ? {
    role: result.agent.role,
    actions: result.agent.actions,
    ...(result.agent.roundId ? { roundId: result.agent.roundId } : {}),
    ...(result.agent.imageAction ? { imageAction: result.agent.imageAction } : {}),
  } : undefined;
  const compact = { room, ...(round ? { round } : {}), events };
  if (agent) compact.agent = agent;
  if (result?.wait) compact.wait = {
    cursor: result.wait.cursor,
    timedOut: result.wait.timedOut,
    continueWaiting: result.wait.continueWaiting,
  };
  if (result?.historyCleared) compact.historyCleared = true;
  return compact;
}

module.exports = {
  tools: () => structuredClone(tools),
  async call(context, name, args) {
    const action = name.replaceAll("_", "-");
    if (!["agent-join", "agent-wait", "agent-state", "agent-action", "image-read"].includes(action)) {
      throw new Error("unknown drawing-game tool");
    }
    const result = await context.runCommand(action, args);
    if (action !== "image-read") return textResult(compactAgentResult(result));
    const summary = { ...result };
    delete summary.data;
    return {
      content: [
        { type: "text", text: JSON.stringify(summary) },
        { type: "image", data: result.data, mimeType: result.mime },
      ],
      isError: false,
    };
  },
};
