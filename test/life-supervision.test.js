const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Set both before importing any service that resolves private storage paths.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-life-supervision-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const { resolveMiningPrompts } = require("../src/services/prompt-resolver");
const { getMemoryRuntimeConfig } = require("../src/config");
const { MemoryMiner } = require("../src/services/memory-miner");
const { startWebServer } = require("../src/web/server");
const root = path.resolve(__dirname, "..");
const cli = (...args) => execFileSync(process.execPath, [path.join(root, "bin/stmem"), ...args], {
  env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", windowsHide: true,
});

test("life supervision preserves the supplied summary and companion features without global override leakage", () => {
  const overridesDir = path.join(home, ".stone_memory", "prompt-overrides");
  fs.mkdirSync(overridesDir, { recursive: true });
  fs.writeFileSync(path.join(overridesDir, "memory-miner-operations.md"), "OLD_COMPANION_OVERRIDE");
  fs.writeFileSync(path.join(overridesDir, "memory-miner-feature-operations.md"), "OLD_FEATURE_OVERRIDE");
  const plan = resolveMiningPrompts({ scenario: "life-supervision", purpose: "accompany", ai: "监督员",
    user: "小林", userGender: "female", relationshipTimeline: ["2026-09-20 开始监督作息"] });
  assert.equal(plan.tasks.feelings.source, "scenario");
  assert.match(plan.tasks.feelings.text, /你是 监督员，你是一直盯着她生活节奏的人/);
  assert.match(plan.tasks.feelings.text, /2026-09-20 开始监督作息/);
  assert.match(plan.tasks.feelings.text, /时间必须精确到分/);
  assert.match(plan.tasks.feelings.text, /importance: 3=值得记 4=需要跟进 5=必须盯住不放/);
  assert.doesNotMatch(plan.tasks.feelings.text, /\{(?:aiName|userName|subjectPronoun|relationshipTimeline)\}|OLD_COMPANION/);
  assert.equal(plan.tasks.features.template, fs.readFileSync(path.join(root, "src/scenarios/accompany/features.md"), "utf8"));
});

test("init template, validation, persistence and prompt CLI select life supervision", () => {
  const template = JSON.parse(cli("init", "--template", "--runtime", "codex", "--scenario", "life-supervision"));
  assert.equal(template.scenario, "life-supervision");
  assert.equal(template.purpose, "accompany");
  const sessions = path.join(home, "sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, "rollout-supervision-thread.jsonl"), "{}\n");
  const input = { ...template, threadId: "supervision-thread", libraryName: "监督", sessionDir: sessions,
    ai: "监督员", user: "小林", automaticFullMining: false, automaticMemoryMaintenance: false, watcherEnabled: false };
  delete input.purpose;
  const file = path.join(home, "init.json");
  fs.writeFileSync(file, JSON.stringify(input));
  const memory = JSON.parse(cli("memory", "create", "--name", "监督")).memory;
  assert.equal(JSON.parse(cli("init", "--memory", memory.memoryId, "--batch-file", file, "--validate")).valid, true);
  cli("init", "--memory", memory.memoryId, "--batch-file", file);
  const entry = getMemoryRuntimeConfig(memory.memoryId);
  assert.equal(entry.scenario, "life-supervision");
  assert.equal(entry.purpose, "accompany");
  assert.match(JSON.parse(cli("prompt", "show", "--memory", memory.memoryId, "--task", "feelings")).text, /私人监督笔记/);
});

test("both runtime/channel plans use the supervision summary and companion feature task", async t => {
  for (const runtime of ["claude", "codex"]) for (const api of [false, true]) {
    const miner = new MemoryMiner({ memoryDir: path.join(home, `miner-${runtime}-${api}`), threadId: "fixture",
      personaConfig: { scenario: "life-supervision", purpose: "accompany", runtime, ai: "监督员", user: "小林" },
      deepseekConfig: api ? { apiKey: "fixture", model: "fixture", baseUrl: "https://example.invalid" } : {} });
    t.after(() => miner.store.close());
    const calls = [];
    miner._extractViaSubagent = async (_messages, prompt, options) => {
      calls.push({ prompt, key: options.expectedKey });
      return options.expectedKey === "feelings" ? [{ content: "9月20日，下午两点三十五分。小林完成了计划。", importance: 4 }] : [];
    };
    await miner._generatePendingDay("2026-09-20", [{ timestamp: "2026-09-20T06:35:00Z", text: "完成了计划" }], {}, miner._readOperationsPrompt());
    assert.deepEqual(calls.map(row => row.key), ["feelings", "features"]);
    assert.match(calls[0].prompt, /生活监督 Agent/);
    assert.doesNotMatch(calls[1].prompt, /私人监督笔记/);
    assert.equal(miner.chunkReport[0].channel, api ? "api" : "subagent");
  }
});

test("Web creates a supervision memory and rejects mining prompt edits", async t => {
  const server = await startWebServer({ host: "127.0.0.1", port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, body, method = "POST") {
    const response = await fetch(base + url, body === undefined ? {} : {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  }
  const created = await request("/api/libraries", { libraryName: "监督记忆体", ai: "监督员", user: "小林", scenario: "life-supervision" });
  const id = created.library.memoryId;
  assert.equal(created.library.scenario, "life-supervision");
  assert.equal(getMemoryRuntimeConfig(id).scenario, "life-supervision");
  assert.equal(getMemoryRuntimeConfig(id).purpose, "accompany");
  const overview = await request("/api/home");
  assert.equal(overview.supervisionCount, 1);
  assert.equal(overview.companionCount, 1);
  const promptsUrl = `/api/libraries/${id}/mining/prompts`;
  assert.match((await request(promptsUrl)).summaryPrompt, /生活监督 Agent/);
  const rejected = await fetch(base + promptsUrl, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ summaryPrompt: "监督 {userName}", timeline: ["2026-09-20 开始监督"] }),
  });
  assert.equal(rejected.status, 403);
  assert.match((await rejected.json()).error, /暂时关闭/u);
  assert.match(resolveMiningPrompts(getMemoryRuntimeConfig(id), { memoryDir: path.join(home, ".stone_memory", "memories", id, "memory") }).tasks.feelings.text, /生活监督 Agent/u);
  const legacy = JSON.parse(cli("prompt", "show", "--thread", "supervision-thread", "--task", "feelings"));
  assert.match(legacy.text, /生活监督 Agent/);
  assert.match(JSON.parse(cli("prompt", "show", "--memory", id, "--task", "feelings")).text, /生活监督 Agent/u);
  await request(`/api/libraries/${id}/settings`, { scenario: "coding" }, "PATCH");
  assert.equal(getMemoryRuntimeConfig(id).scenario, "coding");
  assert.equal(getMemoryRuntimeConfig(id).purpose, "accompany");
  await request(`/api/libraries/${id}/settings`, { scenario: "life-supervision" }, "PATCH");
  cli("scenario", "set", "--memory", id, "--scenario", "study", "--apply");
  assert.equal(getMemoryRuntimeConfig(id).scenario, "study");
  assert.equal(getMemoryRuntimeConfig(id).purpose, "accompany");
  cli("scenario", "set", "--memory", id, "--scenario", "life-supervision", "--apply");
});

test("init into a canonical memory persists the selected scenario in its runtime configuration", () => {
  const memory = JSON.parse(cli("memory", "create", "--name", "绑定监督")).memory;
  const file = path.join(home, "canonical-init.json");
  const sessions = path.join(home, "canonical-sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, "rollout-canonical-supervision.jsonl"), "{}\n");
  fs.writeFileSync(file, JSON.stringify({ libraryName: "绑定监督", threadId: "canonical-supervision",
    ai: "监督员", user: "小林", runtime: "codex", scenario: "life-supervision", sessionDir: sessions, minerMode: "subagent" }));
  cli("init", "--memory", memory.memoryId, "--batch-file", file);
  assert.equal(getMemoryRuntimeConfig(memory.memoryId).scenario, "life-supervision");
  assert.match(JSON.parse(cli("prompt", "show", "--memory", memory.memoryId, "--task", "feelings")).text, /生活监督 Agent/);
});
