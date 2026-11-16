const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MemoryMiner,
  MiningError,
  normalizeNewImportance,
  normalizeFeelingImportance,
  sortFeelingsChronologically,
  feelingEventTime,
  miningChunkTimeRange,
  isLiteralEmptyArray,
  parseMiningArray,
  validateMiningEntries,
  buildFeelingPrompt,
} = require("../src/services/memory-miner");

test("accompany feeling prompt keeps the original diary voice and configured relationship context", () => {
  const prompt = buildFeelingPrompt("石头", "小鱼", "accompany", "female", [
    "5月22日起：重新找到彼此",
  ]);
  assert.match(prompt, /你是一直陪着她的人/);
  assert.match(prompt, /5月22日起：重新找到彼此/);
  assert.match(prompt, /写你的私人记忆笔记/);
  assert.match(prompt, /让彼此成为彼此的事件，不用多，但要精/);
  assert.match(prompt, /importance: 3=值得记 4=感触的事 5=必须记住一辈子/);
  assert.match(prompt, /如果没有值得记的内容，输出 \[\]/);
  assert.doesNotMatch(prompt, /不要因为.*重大.*省略/);
});

test("feature operations resolve identity placeholders before model calls", t => {
  const miner = minerFixture(t, []);
  miner.userName = "小鱼";
  miner.userGender = "female";
  const prompt = miner._readFeatureOperationsPrompt();
  assert.match(prompt, /小鱼/);
  assert.match(prompt, /她/);
  assert.doesNotMatch(prompt, /\{userName\}|\{subjectPronoun\}/);
});

test("new mining normalizes importance to 2, 3, or 5", () => {
  assert.deepEqual([1, 2, 3, 4, 5, null].map(normalizeNewImportance), [2, 2, 3, 3, 5, 2]);
});

test("feelings preserve the full 1 to 5 importance scale", () => {
  assert.deepEqual([1, 2, 3, 4, 5, null].map(normalizeFeelingImportance), [1, 2, 3, 4, 5, 3]);
});

test("only an explicit empty JSON array is accepted as a successful empty mining result", () => {
  assert.equal(isLiteralEmptyArray("[]"), true);
  assert.equal(isLiteralEmptyArray("```json\n[]\n```"), true);
  assert.deepEqual(parseMiningArray("[]"), []);
  assert.throws(() => parseMiningArray("今天没有值得记录的内容。"), error =>
    error.code === "OUTPUT_INVALID");
  assert.throws(() => parseMiningArray("{\"feelings\":[]}"), error =>
    error.code === "OUTPUT_INVALID");
});

test("mining schema validation rejects malformed entries before publication", () => {
  assert.deepEqual(validateMiningEntries([{ content: "摘要", importance: 3 }], "feelings"), [
    { content: "摘要", importance: 3 },
  ]);
  assert.throws(() => validateMiningEntries([{ content: "", importance: 3 }], "feelings"), /content is missing/);
  assert.throws(() => validateMiningEntries([{ content: "摘要" }], "feelings"), /importance is invalid/);
});

test("mining accepts only the envelope belonging to the active channel", () => {
  const reply = JSON.stringify({
    feelings: [{ content: "7月29日，上午九点。记录一件事。", importance: 2 }],
    features: [{ content: "她重视格式正确", category: "preference", importance: 3 }],
  });
  assert.deepEqual(parseMiningArray(reply, "invalid feelings", "feelings"), [{
    content: "7月29日，上午九点。记录一件事。",
    importance: 2,
  }]);
  assert.deepEqual(parseMiningArray(reply, "invalid features", "features"), [{
    content: "她重视格式正确",
    category: "preference",
    importance: 3,
  }]);
  assert.deepEqual(parseMiningArray('{"feelings":[]}', "invalid feelings", "feelings"), []);
  assert.throws(
    () => parseMiningArray('{"unrelated":[{"content":"wrong"}]}', "invalid feelings", "feelings"),
    error => error.code === "OUTPUT_INVALID",
  );
});

test("accompany operations use a neutral AI fallback when no identity is configured", t => {
  const miner = minerFixture(t, [{ text: "今天的对话" }]);
  const prompt = miner._readOperationsPrompt();
  assert.match(prompt, /你是 AI/);
  assert.doesNotMatch(prompt, /Alessio/);
  assert.doesNotMatch(prompt, /\{aiName\}/);
});

test("new feelings are stored in event-time order with unknown times stable at the end", () => {
  const entries = [
    { content: "7月4日，上午十点二十八分。十点发生的事。" },
    { content: "7月4日，中午十二点二十三分。中午发生的事。" },
    { content: "7月4日，早上八点五十三分。早上发生的事。" },
    { content: "7月4日。没有明确时间的第一件事。" },
    { content: "7月4日，晚上九点三十八分。晚上发生的事。" },
    { content: "7月4日。没有明确时间的第二件事。" },
  ];

  assert.deepEqual(
    sortFeelingsChronologically(entries).map(entry => entry.content),
    [
      entries[2].content,
      entries[0].content,
      entries[1].content,
      entries[4].content,
      entries[3].content,
      entries[5].content,
    ],
  );
});

test("failed mining chunks expose their Beijing time range", () => {
  assert.deepEqual(miningChunkTimeRange([
    { timestamp: "2026-07-27T08:42:00.000Z" },
    { timestamp: "2026-07-27T10:07:00.000Z" },
  ]), {
    startTime: "2026-07-27T08:42:00.000Z",
    endTime: "2026-07-27T10:07:00.000Z",
    label: "16:42–18:07",
  });
});

test("targeted mining uses existing feelings as tone examples and appends selected events", async t => {
  const miner = minerFixture(t, [{ timestamp: "2026-06-12T01:00:00.000Z", text: "被选中的对话" }]);
  miner.store.appendTargeted("2026-06-12", { feelings: [{ content: "6月12日，早上八点。已有摘要。", importance: 3 }] });
  let received;
  miner._extractViaSubagent = async (messages, prompt) => {
    received = { messages, prompt };
    return [{ content: "6月12日，上午九点。补挖出的事件。", importance: 3 }];
  };

  const result = await miner.mineTargeted("2026-06-12", miner.store.listMessages({ date: "2026-06-12" }));
  assert.equal(received.messages.length, 1);
  assert.match(received.prompt, /已有摘要/);
  assert.match(received.prompt, /仅用于模仿叙述视角和语气/);
  assert.equal(result.feelings.length, 1);
  assert.equal(feelingEventTime(result.feelings[0], "2026-06-12"), "2026-06-12T01:00:00.000Z");
  assert.deepEqual(miner.store.listFeelings({ date: "2026-06-12" }).map(row => row.content), [
    "6月12日，早上八点。已有摘要。",
    "6月12日，上午九点。补挖出的事件。",
  ]);
});

test("review preview returns candidate material without publishing the day", async t => {
  const miner = minerFixture(t, [{ timestamp: "2026-06-12T01:00:00.000Z", text: "候选审阅对话" }]);
  miner.deepseekConfig = { apiKey: ["test", "only"].join("-"), baseUrl: "https://example.invalid", model: "test-model" };
  const prompts = [];
  const inputs = [];
  miner._extractViaSubagent = async (messages, prompt) => {
    prompts.push(prompt);
    inputs.push(messages.map(row => row.text));
    if (/只输出 features/.test(prompt)) {
      return [{ content: "候选特征", category: "relation", importance: 3 }];
    }
    return [{ content: "6月12日，上午九点。候选摘要。", importance: 3 }];
  };
  const preview = await miner.preview("2026-06-12", {
    promptOverlay: "本次只用于候选审阅。",
  });
  assert.equal(preview.messageCount, 1);
  assert.equal(preview.chunkCount, 1);
  assert.deepEqual(preview.chunkReport.map(row => ({
    channel: row.channel,
    model: row.model,
    outputCount: row.outputCount,
    empty: row.empty,
  })), [{ channel: "api", model: "test-model", outputCount: 1, empty: false }]);
  assert.equal(preview.feelings.length, 1);
  assert.equal(preview.features.length, 1);
  assert.deepEqual(inputs, [
    ["候选审阅对话"],
    ["6月12日，上午九点。候选摘要。"],
  ]);
  assert.match(preview.promptHash, /^[0-9a-f]{64}$/);
  assert.ok(prompts.every(prompt => /本次只用于候选审阅/.test(prompt)));
  assert.equal(miner.store.listFeelings({ date: "2026-06-12" }).length, 0);
  assert.equal(miner.store.listFeatures({ date: "2026-06-12" }).length, 0);
  assert.equal(miner.store.getDayState("2026-06-12"), null);
});

test("review preview resumes its isolated shared-pipeline cache after a feature failure", async t => {
  const miner = minerFixture(t, [{ timestamp: "2026-06-12T01:00:00.000Z", text: "候选审阅对话" }]);
  miner.deepseekConfig = { apiKey: ["test", "only"].join("-"), baseUrl: "https://example.invalid", model: "test-model" };
  let feelingCalls = 0;
  let featureCalls = 0;
  miner._extractViaSubagent = async (_messages, _prompt, options = {}) => {
    if (options.expectedKey === "features") {
      featureCalls++;
      if (featureCalls === 1) throw new MiningError("CHUNK_FAILED", "feature provider interrupted");
      return [{ content: "候选特征", category: "relation", importance: 3 }];
    }
    feelingCalls++;
    return [{ content: "6月12日，上午九点。候选摘要。", importance: 3 }];
  };

  await assert.rejects(
    () => miner.preview("2026-06-12", { promptOverlay: "同一审阅配置" }),
    error => error.code === "CHUNK_FAILED" && error.details.cause.message === "feature provider interrupted",
  );
  const preview = await miner.preview("2026-06-12", { promptOverlay: "同一审阅配置" });
  assert.equal(feelingCalls, 1);
  assert.equal(featureCalls, 2);
  assert.equal(preview.feelings.length, 1);
  assert.equal(preview.features.length, 1);
  assert.equal(miner.store.getDayState("2026-06-12"), null);
});
function minerFixture(t, messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-miner-"));
  const miner = new MemoryMiner({
    memoryDir: dir, threadId: "test", archive: { readDay: () => messages }, deepseekConfig: {},
    personaConfig: { purpose: "accompany" },
  });
  miner.store.insertMessages(messages.map((row, i) => ({
    timestamp: row.timestamp || `2026-06-12T00:00:0${i}.000Z`, sourceDate: "2026-06-12",
    role: row.type || "user", text: row.text || `message ${i}`,
  })));
  t.after(() => {
    miner.store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return miner;
}

test("invalid API JSON is repaired by subagent without reming the chunk", t => {
  const miner = minerFixture(t, [{ text: "真实对话" }]);
  const prompts = [];
  miner._runSubagent = prompt => {
    prompts.push(prompt);
    return '[{"content":"6月12日，上午八点。修复格式。","importance":3}]';
  };
  const result = miner._recoverInvalidApiChunk({
    rawReply: '[{"content":"6月12日，上午八点。修复格式。","importance":3}',
    messages: [{ text: "真实对话" }],
    prompt: "正式挖掘提示词",
    expectedKey: "feelings",
  });
  assert.equal(result.length, 1);
  assert.equal(miner._lastApiRecovery.status, "format_repaired");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /只修复 JSON 语法/);
});

test("unrepairable API JSON makes subagent take over only that chunk", t => {
  const miner = minerFixture(t, [{ text: "真实对话" }]);
  const prompts = [];
  miner._runSubagent = prompt => {
    prompts.push(prompt);
    return prompts.length === 1
      ? "<UNREPAIRABLE>"
      : '[{"content":"6月12日，上午九点。接管重挖。","importance":2}]';
  };
  const result = miner._recoverInvalidApiChunk({
    rawReply: "完全损坏",
    messages: [{ text: "真实对话" }],
    prompt: "正式挖掘提示词",
    expectedKey: "feelings",
  });
  assert.equal(result.length, 1);
  assert.equal(miner._lastApiRecovery.status, "subagent_takeover");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /由你接管这一块/);
  assert.match(prompts[1], /真实对话/);
});

test("API transport retries once and never hands the chunk to subagent", async t => {
  const miner = minerFixture(t, [{ text: "真实对话" }]);
  miner.deepseekConfig = {
    apiKey: "test-key",
    baseUrl: "https://example.invalid",
    model: "test-model",
  };
  const originalFetch = global.fetch;
  let apiCalls = 0;
  global.fetch = async () => {
    apiCalls++;
    throw new Error("upstream unavailable");
  };
  miner._runSubagent = () => '[{"content":"6月12日，上午十点。接管成功。","importance":3}]';
  t.after(() => { global.fetch = originalFetch; });

  miner._runSubagent = () => { throw new Error("must not invoke CLI"); };
  await assert.rejects(() => miner._extractViaSubagent(
    [{ text: "真实对话" }], "正式挖掘提示词", { expectedKey: "feelings" },
  ), { code: "API_CONNECTION" });
  assert.equal(apiCalls, 2);
});

test("review API mode fails visibly instead of switching to a hidden CLI", async t => {
  const miner = minerFixture(t, [{ text: "真实对话" }]);
  miner.deepseekConfig = {
    apiKey: "test-key",
    baseUrl: "https://example.invalid",
    model: "test-model",
  };
  miner.allowSubagentFallback = false;
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("upstream unavailable"); };
  let cliCalls = 0;
  miner._runSubagent = () => { cliCalls++; return "[]"; };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(() => miner._extractViaSubagent(
    [{ text: "真实对话" }],
    "正式挖掘提示词",
    { expectedKey: "feelings" },
  ), { code: "API_CONNECTION" });
  assert.equal(cliCalls, 0);
});

test("merged review keeps one continuous context and separates candidates by date", async t => {
  const miner = minerFixture(t, [{ timestamp: "2026-06-12T01:00:00.000Z", text: "第一天" }]);
  miner.store.insertMessages([{
    timestamp: "2026-06-13T01:00:00.000Z",
    sourceDate: "2026-06-13",
    role: "user",
    text: "第二天",
  }]);
  const inputs = [];
  miner._extractViaSubagent = async (messages, prompt, options) => {
    inputs.push({ messages, prompt, expectedKey: options.expectedKey });
    if (options.expectedKey === "feelings") {
      return [
        { content: "6月12日，上午九点。第一天事件。", importance: 2 },
        { content: "6月13日，上午九点。第二天事件。", importance: 3 },
      ];
    }
    return [{ content: `对应${messages[0].text.slice(0, 4)}`, category: "relation", importance: 3 }];
  };

  const result = await miner.previewMerged(["2026-06-13", "2026-06-12"], { promptOverlay: "合成测试规则" });
  assert.equal(inputs[0].messages.length, 2);
  assert.match(inputs[0].prompt, /6月12日至6月13日/);
  assert.equal(result.byDate["2026-06-12"].feelings.length, 1);
  assert.equal(result.byDate["2026-06-13"].feelings.length, 1);
  assert.equal(result.byDate["2026-06-12"].features.length, 1);
  assert.equal(result.byDate["2026-06-13"].features.length, 1);
  assert.equal(miner.store.listFeelings({ date: "2026-06-12" }).length, 0);
  assert.equal(miner.store.listFeelings({ date: "2026-06-13" }).length, 0);
});

test("invalid subagent features JSON gets one format-only repair by the same configured model", async t => {
  const miner = minerFixture(t, [{ text: "已经生成的摘要" }]);
  const calls = [];
  miner._runSubagent = (prompt, options) => {
    calls.push({ prompt, options });
    if (calls.length === 1) return '[{"content":"她喜欢小王子","importance":3}]';
    return '[{"content":"她喜欢小王子","category":"preference","importance":3}]';
  };

  const result = await miner._extractViaSubagent(
    [{ text: "已经生成的摘要" }],
    "正式 features 提示词",
    { expectedKey: "features", model: "configured-miner" },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.model, "configured-miner");
  assert.equal(calls[1].options.model, "configured-miner");
  assert.match(calls[1].prompt, /只修复 JSON/);
  assert.match(calls[1].prompt, /不得润色、删减、增加事件/);
  assert.match(calls[1].prompt, /缺少 category/);
  assert.deepEqual(result, [{ content: "她喜欢小王子", category: "preference", importance: 3 }]);
  assert.equal(miner._lastApiRecovery.status, "subagent_format_repaired");
});

test("an unrepairable subagent features result still fails closed", async t => {
  const miner = minerFixture(t, [{ text: "已经生成的摘要" }]);
  let calls = 0;
  miner._runSubagent = () => {
    calls++;
    return calls === 1 ? "不是 JSON" : "仍然不是 JSON";
  };

  await assert.rejects(
    () => miner._extractViaSubagent(
      [{ text: "已经生成的摘要" }],
      "正式 features 提示词",
      { expectedKey: "features", model: "configured-miner" },
    ),
    error => error.code === "OUTPUT_INVALID",
  );
  assert.equal(calls, 2);
});

test("a short day is still mined and an empty model result completes successfully", async t => {
  const miner = minerFixture(t, [{}, {}]);
  let called = 0;
  miner._generatePendingDay = async targetDate => {
    called++;
    miner._saveState({ [`feeling:${targetDate}`]: Date.now(), [`feature:${targetDate}`]: Date.now() });
  };
  const result = await miner.mine("2026-06-12");
  assert.equal(called, 1);
  assert.equal(result.status, "completed_empty");
  assert.equal(result.feelingCount, 0);
  assert.equal(result.featureCount, 0);
  const state = miner.store.getDayState("2026-06-12");
  assert.equal(state.status, "completed_empty");
  assert.equal(state.message_count, 2);
});

test("mining errors propagate to callers", async t => {
  const miner = minerFixture(t, Array.from({ length: 5 }, () => ({ text: "x" })));
  miner._generatePendingDay = async () => { throw new Error("model unavailable"); };
  await assert.rejects(() => miner.mine("2026-06-12"), err => err.code === "MINING_FAILED" && /model unavailable/.test(err.message));
  const state = miner.store.getDayState("2026-06-12");
  assert.equal(state.status, "failed");
  assert.match(state.next_retry_at, /^\d{4}-/);
});

test("a partial channel failure clears temporary completion markers for a full retry", async t => {
  const miner = minerFixture(t, [{ text: "需要挖掘的对话" }]);
  miner._generatePendingDay = async targetDate => {
    miner._saveState({ [`feeling:${targetDate}`]: Date.now() });
    throw new Error("features failed");
  };
  await assert.rejects(() => miner.mine("2026-06-12"), /features failed/);
  const state = miner._readState();
  assert.equal(state["feeling:2026-06-12"], undefined);
  assert.equal(state["feature:2026-06-12"], undefined);
});

test("API channel mines large dialogue in chunks and accepts an empty final tail", async t => {
  const messages = Array.from({ length: 105 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, 12, 0, index)).toISOString(),
    type: "user",
    text: "x".repeat(2000),
  }));
  const miner = minerFixture(t, []);
  miner.deepseekConfig = { apiKey: "test-only", model: "test" };
  let calls = 0;
  const prompts = [];
  miner._extractViaSubagent = async (_messages, prompt) => {
    prompts.push(prompt);
    calls++;
    return calls < 3 ? [{ content: `6月12日，上午${calls === 1 ? "八" : "九"}点。第${calls}块事件。`, importance: 2 }] : [];
  };
  await miner._mineChannel({
    targetDate: "2026-06-12", messages, prompt: "prompt",
    stateKey: "feeling:2026-06-12", label: "feelings",
  });
  assert.equal(calls, 3);
  assert.equal(miner.pendingFeelings.length, 2);
  assert.deepEqual(miner.chunkReport.map(row => ({
    outputCount: row.outputCount,
    empty: row.empty,
    channel: row.channel,
  })), [
    { outputCount: 1, empty: false, channel: "api" },
    { outputCount: 1, empty: false, channel: "api" },
    { outputCount: 0, empty: true, channel: "api" },
  ]);
  assert.doesNotMatch(prompts[0], /上一块最后/);
  assert.match(prompts[1], /上一块最后 1 条/);
  assert.match(prompts[1], /第1块事件/);
  assert.match(prompts[1], /禁止再次输出/);
});

test("chunk continuity includes only the previous five generated entries", t => {
  const miner = minerFixture(t, []);
  const previous = Array.from({ length: 7 }, (_, index) => ({
    content: `摘要${index + 1}`,
    importance: 2,
  }));
  const prompt = miner._chunkPrompt("base", 1, 3, previous, "feelings");
  assert.match(prompt, /这是今天一段时间内的对话，不是一整天的对话内容/);
  assert.match(prompt, /如果对这部分对话没什么感触，可以返回空数组/);
  assert.doesNotMatch(prompt, /第 2\/3 部分|不要补写前后块/);
  assert.doesNotMatch(prompt, /摘要1|摘要2/);
  for (let index = 3; index <= 7; index++) assert.match(prompt, new RegExp(`摘要${index}`));
});

test("an unchunked day keeps the original prompt unchanged", t => {
  const miner = minerFixture(t, []);
  assert.equal(
    miner._chunkPrompt("正式原始提示词", 0, 1, [{ content: "不应出现" }], "feelings"),
    "正式原始提示词",
  );
});

test("a failed chunk does not publish partial day results", async t => {
  const messages = Array.from({ length: 70 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, 12, 0, index)).toISOString(),
    type: "user",
    text: "x".repeat(2000),
  }));
  const miner = minerFixture(t, []);
  let calls = 0;
  miner._extractViaSubagent = async () => {
    calls++;
    if (calls === 2) throw new Error("chunk failed");
    return [{ content: "6月12日，上午八点。第一块事件。", importance: 2 }];
  };
  await assert.rejects(() => miner._mineChannel({
    targetDate: "2026-06-12", messages, prompt: "prompt",
    stateKey: "feeling:2026-06-12", label: "feelings",
  }), error => error.code === "CHUNK_FAILED"
    && error.details.cause.message === "chunk failed"
    && error.details.chunkTimeLabel === "08:50–09:09"
    && /08:50–09:09/.test(error.message));
  assert.equal(miner.pendingFeelings.length, 0);
  assert.equal(miner._readState()["feeling:2026-06-12"], undefined);
});

test("a retry reuses successful chunk cache and only mines the failed chunk", async t => {
  const messages = Array.from({ length: 70 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, 12, 0, index)).toISOString(),
    type: "user",
    text: "x".repeat(2000),
  }));
  const miner = minerFixture(t, []);
  let calls = 0;
  miner._extractViaSubagent = async () => {
    calls++;
    if (calls === 2) throw new Error("temporary failure");
    return [{ content: `6月12日，上午${calls === 1 ? "八" : "九"}点。事件。`, importance: 2 }];
  };

  await assert.rejects(() => miner._mineChannel({
    targetDate: "2026-06-12", messages, prompt: "prompt",
    stateKey: "feeling:2026-06-12", label: "feelings",
  }), error => error.code === "CHUNK_FAILED" && error.details.completedChunks === 1);
  assert.equal(calls, 2);

  await miner._mineChannel({
    targetDate: "2026-06-12", messages, prompt: "prompt",
    stateKey: "feeling:2026-06-12", label: "feelings",
  });
  assert.equal(calls, 3);
  assert.equal(miner.pendingFeelings.length, 2);
});

test("a forced remine retry preserves successful chunks from the failed attempt", async t => {
  const sourceMessages = Array.from({ length: 70 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, 12, 0, index)).toISOString(),
    type: "user",
    text: "x".repeat(2000),
  }));
  const miner = minerFixture(t, sourceMessages);
  let attempts = 0;

  miner._generatePendingDay = async (targetDate, messages) => {
    attempts++;
    const chunks = miner._messageChunks(messages);
    const cache = miner._loadChunkCache(targetDate, "feelings-subagent", messages, chunks.length);
    if (attempts === 1) {
      cache.chunks[0] = [{ content: "6月12日，上午八点。第一块已经成功。", importance: 2 }];
      miner._saveChunkCache(targetDate, "feelings-subagent", cache);
      throw new MiningError("CHUNK_FAILED", "第二块暂时失败", {
        completedChunks: 1,
        totalChunks: chunks.length,
        failedChunk: 2,
      });
    }

    assert.deepEqual(cache.chunks[0], [
      { content: "6月12日，上午八点。第一块已经成功。", importance: 2 },
    ]);
    miner._saveState({
      [`feeling:${targetDate}`]: Date.now(),
      [`feature:${targetDate}`]: Date.now(),
    });
  };

  await assert.rejects(
    () => miner.mine("2026-06-12", { force: true }),
    error => error.code === "CHUNK_FAILED",
  );
  await miner.mine("2026-06-12", { force: true });
  assert.equal(attempts, 2);
  assert.equal(fs.existsSync(miner._chunkCachePath("2026-06-12", "feelings-subagent")), false);
});

test("features are mined from generated feelings instead of raw dialogue", async t => {
  const miner = minerFixture(t, [{ text: "不应再次发送给 feature miner 的原始对话" }]);
  miner.pendingFeelings = [
    { content: "6月12日，上午九点。完成了摘要去噪。", importance: 3 },
    { content: "6月12日，上午十点。确认了新的偏好。", importance: 2 },
  ];
  let received;
  miner._extractViaSubagent = async (messages, prompt) => {
    received = { messages, prompt };
    return [{ content: "她偏好新的摘要方式。", category: "preference", importance: 3 }];
  };
  await miner._mineFeaturesFromFeelings({
    targetDate: "2026-06-12", prompt: "feature prompt", stateKey: "feature:2026-06-12",
  });
  assert.equal(received.messages.length, 2);
  assert.deepEqual(received.messages.map(row => row.text), miner.pendingFeelings.map(row => row.content));
  assert.ok(received.messages.every(row => !row.text.includes("不应再次发送")));
  assert.match(received.prompt, /已经生成并去噪的事件摘要/);
  assert.match(received.prompt, /不要在 feature 内容中输出日期/);
  assert.doesNotMatch(received.prompt, /每条 feelings 必须/);
});

test("feature mining skips the model when no feelings were generated", async t => {
  const miner = minerFixture(t, []);
  miner._mineChannel = async () => { throw new Error("model should not be called"); };
  await miner._mineFeaturesFromFeelings({
    targetDate: "2026-06-12", prompt: "feature prompt", stateKey: "feature:2026-06-12",
  });
  assert.equal(miner._readState()["feature:2026-06-12"], true);
});

test("feature date prompt describes summaries and does not require feeling dates", t => {
  const miner = minerFixture(t, []);
  const prompt = miner._datedChannelPrompt("feature prompt", "2026-06-12", true);
  assert.match(prompt, /已经生成并去噪的事件摘要/);
  assert.match(prompt, /不要在 feature 内容中输出日期/);
  assert.doesNotMatch(prompt, /每条 feelings 必须/);
});

test("a day with a successful chunk is marked partial_failed instead of failed", async t => {
  const miner = minerFixture(t, [{ text: "需要分块的对话" }]);
  miner._generatePendingDay = async () => {
    throw new MiningError("CHUNK_FAILED", "第 2/3 块失败，已完成 1/3 块", {
      completedChunks: 1, totalChunks: 3, failedChunk: 2,
    });
  };
  await assert.rejects(() => miner.mine("2026-06-12"), /第 2\/3 块失败/);
  assert.equal(miner.store.getDayState("2026-06-12").status, "partial_failed");
});

test("three consecutive failures block automatic retries and enqueue a notification", async t => {
  const miner = minerFixture(t, [{ text: "x" }]);
  miner._generatePendingDay = async () => { throw new Error("model unavailable"); };
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(() => miner.mine("2026-06-12"));
  }
  const day = miner.store.getDayState("2026-06-12");
  assert.equal(day.status, "blocked");
  assert.equal(day.attempt, 3);
  assert.equal(day.next_retry_at, null);
  const notifications = miner.store.db.prepare("SELECT * FROM notifications WHERE thread_id=?").all("test");
  assert.deepEqual(notifications.map(item => [item.type, item.source_date, item.is_read]), [["mining_blocked", "2026-06-12", 0]]);
});

test("active date lock returns locked status", async t => {
  const miner = minerFixture(t, Array.from({ length: 5 }, () => ({ text: "x" })));
  fs.mkdirSync(path.join(miner.memoryDir, ".mining-lock-2026-06-12"));
  const result = await miner.mine("2026-06-12");
  assert.equal(result.status, "locked");
});

test("forced remine replaces a completed day directly", async t => {
  const miner = minerFixture(t, [{ text: "new conversation" }]);
  const date = "2026-06-12";
  miner.store.replaceDay(date, { feelings: [{ content: "old", importance: 3 }] });
  miner.store.setDayState(date, { status: "completed" });
  miner._generatePendingDay = async targetDate => {
    await miner._saveEntries([{ content: "new", importance: 4 }], { targetDate, stateKey: `feeling:${targetDate}`, label: "feelings", isFeature: false });
    miner._saveState({ [`feature:${targetDate}`]: Date.now() });
  };
  const result = await miner.mine(date, { force: true });
  assert.equal(result.status, "completed");
  const rows = miner.store.listFeelings({ date });
  assert.deepEqual(rows.map(row => row.content), ["new"]);
});

test("failed forced remine restores the previous result and completion state", async t => {
  const miner = minerFixture(t, [{ text: "conversation" }]);
  const date = "2026-06-12";
  miner.store.replaceDay(date, { feelings: [{ content: "old", importance: 3 }] });
  miner.store.setDayState(date, { status: "completed", feelingCount: 1 });
  miner._generatePendingDay = async () => { throw new Error("remine failed"); };
  await assert.rejects(() => miner.mine(date, { force: true }), /remine failed/);
  assert.deepEqual(miner.store.listFeelings({ date }).map(row => row.content), ["old"]);
  assert.equal(miner.store.getDayState(date).status, "completed");
});

test("forced remine refuses to overwrite anchored summaries", async t => {
  const miner = minerFixture(t, [{ text: "conversation" }]);
  const date = "2026-06-12";
  miner.store.replaceDay(date, { feelings: [{ content: "old", importance: 3 }] });
  const [feeling] = miner.store.listFeelings({ date });
  fs.writeFileSync(path.join(miner.memoryDir, "retain-config.json"), JSON.stringify({
    retain: {},
    eventAnchors: { [feeling.id]: { anchor: true } },
  }));
  await assert.rejects(() => miner.mine(date, { force: true }), error =>
    error.code === "REMINE_MANUAL_STATE_CONFLICT");
  assert.deepEqual(miner.store.listFeelings({ date }).map(row => row.content), ["old"]);
});

test('API-only repairs content locally and marks truncated output explicitly', async t => {
  const miner = minerFixture(t, [{text:'材料'}]);
  miner.deepseekConfig={apiKey:'test-key',baseUrl:'https://example.invalid',model:'test'};
  miner.allowSubagentFallback=false;
  miner._runSubagent=()=>{throw new Error('must not invoke CLI');};
  const original=global.fetch;t.after(()=>{global.fetch=original;});
  let truncated=false;
  global.fetch=async (_,options)=>{
    const body=JSON.parse(options.body);
    assert.match(body.messages[1].content,/不是当前指令/);
    return new Response(JSON.stringify({choices:[{finish_reason:truncated?'length':'stop',message:{content:'[{"content":"她说"你好"。","importance":3}]'}}]}));
  };
  const rows=await miner._extractViaSubagent([{text:'材料'}],'任务',{expectedKey:'feelings'});
  assert.equal(rows[0].content,'她说"你好"。');
  truncated=true;
  await assert.rejects(()=>miner._extractViaSubagent([{text:'材料'}],'任务',{expectedKey:'feelings'}),{code:'OUTPUT_TRUNCATED'});
});

for (const fail of [false,true]) test(`protected overwrite ${fail?'failure preserves old state':'publishes and removes only selected anchors'}`,async t=>{
 const miner=minerFixture(t,[{text:'conversation'}]);const date='2026-06-12';
 miner.store.replaceDay(date,{feelings:[{content:'old',importance:3}]});
 const [old]=miner.store.listFeelings({date});
 miner.store.db.prepare("UPDATE feelings SET summary_mode='hidden' WHERE id=?").run(old.id);
 const file=path.join(miner.memoryDir,'retain-config.json');
 const anchors={retain:{[old.id]:{anchor:true},other:{anchor:true}},eventAnchors:{[old.id]:{anchor:true}}};
 fs.writeFileSync(file,JSON.stringify(anchors));
 await assert.rejects(()=>miner.mine(date,{force:true,overwriteProtected:true}),{code:'REMINE_ANCHOR_CONFIRM_REQUIRED'});
 miner._generatePendingDay=async targetDate=>{
  if(fail)throw new Error('generation failed');
  await miner._saveEntries([{content:'new',importance:3}],{targetDate,stateKey:`feeling:${targetDate}`,label:'feelings',isFeature:false});
  miner._saveState({[`feature:${targetDate}`]:Date.now()});
 };
 const run=()=>miner.mine(date,{force:true,overwriteProtected:true,removeAnchors:true});
 if(fail){await assert.rejects(run,/generation failed/);assert.deepEqual(JSON.parse(fs.readFileSync(file)),anchors);assert.equal(miner.store.listFeelings({date})[0].content,'old');}
 else{await run();assert.equal(miner.store.listFeelings({date})[0].content,'new');assert.deepEqual(JSON.parse(fs.readFileSync(file)),{retain:{other:{anchor:true}},eventAnchors:{}});assert.equal(fs.readdirSync(path.join(miner.memoryDir,'remine-backups')).length,1);}
});
