const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { listScenarios, getScenario, packageFile } = require("../src/services/scenario-registry");
const { resolveMiningPrompts, renderPrompt, promptOverridePath } = require("../src/services/prompt-resolver");
const { buildInitTemplate, INIT_SCHEMA } = require("../src/services/init-contract");
const { MemoryMiner } = require("../src/services/memory-miner");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-scenario-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

test("registered scenarios drive init; existing prompts retain their single-day semantics", t => {
  assert.deepEqual(listScenarios().slice(0, 3).map(row => [row.id, row.label]), [
    ["life-supervision", "生活监督"], ["accompany", "情感陪伴"], ["coding", "编程日志"],
  ]);
  const overridesDir = fixture(t);
  assert.deepEqual(INIT_SCHEMA.properties.scenario.enum, listScenarios().map(row => row.id));
  for (const scenario of listScenarios()) {
    const template = buildInitTemplate("codex", scenario.id);
    assert.equal(template.scenario, scenario.id);
    assert.equal(template.purpose, scenario.storagePurpose);
    const plan = resolveMiningPrompts({ purpose: scenario.id, ai: "Example", user: "Reader" }, { overridesDir });
    assert.ok(plan.tasks.feelings.text.includes("Example"));
    assert.ok(plan.tasks.features.text.includes("Reader"));
    assert.equal(plan.tasks.features.template, fs.readFileSync(path.resolve(__dirname, "../operations/memory-miner-feature-operations.md"), "utf8"));
  }
  assert.throws(() => buildInitTemplate("codex", "missing"), /未知场景/);
});

test("a new manifest and prompt files work without another purpose branch", t => {
  const root = fixture(t), dir = path.join(root, "example-scenario");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    id: "example-scenario", label: "Example", version: 1, storagePurpose: "coding",
    tasks: ["feelings", "features"], prompts: { feelings: "summary.md", features: "features.md" },
  }));
  fs.writeFileSync(path.join(dir, "summary.md"), "Summary for {userName}");
  fs.writeFileSync(path.join(dir, "features.md"), "Features for {userName}");
  const plan = resolveMiningPrompts({ scenario: "example-scenario", user: "Reader" }, { registryRoot: root, overridesDir: root });
  assert.equal(plan.tasks.feelings.text, "Summary for Reader");
  assert.equal(getScenario("example-scenario", root).storagePurpose, "coding");
  assert.throws(() => packageFile(dir, "../example-scenario/../../outside"));
  fs.writeFileSync(path.join(dir, "summary.md"), "{unknownVariable}");
  assert.throws(() => resolveMiningPrompts({ scenario: "example-scenario" }, { registryRoot: root }), /未知提示词变量/);
});

test("legacy global overrides remain readable, local overrides isolate memories and scenarios", t => {
  const root = fixture(t), overridesDir = path.join(root, "legacy"), memoryDir = path.join(root, "one");
  fs.mkdirSync(overridesDir);
  fs.writeFileSync(path.join(overridesDir, "memory-miner-operations.md"), "Global {userName}");
  const local = promptOverridePath(memoryDir, "accompany", "feelings");
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, "Local {userName}");
  const config = { purpose: "accompany", user: "{aiName}", ai: "Must not expand twice" };
  const first = resolveMiningPrompts(config, { memoryDir, overridesDir });
  assert.equal(first.tasks.feelings.text, "Local {aiName}");
  assert.equal(first.tasks.feelings.source, "memory");
  const other = resolveMiningPrompts(config, { memoryDir: path.join(root, "two"), overridesDir });
  assert.equal(other.tasks.feelings.source, "legacy-global");
  const switched = resolveMiningPrompts({ ...config, scenario: "coding" }, { memoryDir, overridesDir });
  assert.equal(switched.tasks.feelings.source, "scenario");
  assert.doesNotMatch(switched.tasks.feelings.text, /Local|Global/);
  assert.throws(() => renderPrompt("   "), /不能为空/);
  assert.throws(() => promptOverridePath(memoryDir, "../escape", "feelings"), /ID 无效/);
  assert.throws(() => promptOverridePath(memoryDir, "coding", "../escape"), /未知挖掘任务/);
});

test("CLI switches scenarios without moving history and prompt validation does not write", t => {
  const root = fixture(t), stone = path.join(root, ".stone_memory");
  fs.mkdirSync(stone);
  const entry = { runtime: "codex", purpose: "coding", ai: "AI", user: "User", label: "test" };
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({ one: entry, two: entry }));
  const memory = path.join(stone, "runtimes", "codex", "coding", "one", "memory");
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, "history.txt"), "unchanged");
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [path.resolve(__dirname, "../bin/stmem"), ...args], {
    env: { ...process.env, HOME: root, USERPROFILE: root }, encoding: "utf8", windowsHide: true,
  }));
  const before = fs.readFileSync(path.join(stone, "stmem.json"), "utf8");
  assert.equal(cli("scenario", "set", "--thread", "one", "--scenario", "study").applied, false);
  assert.equal(fs.readFileSync(path.join(stone, "stmem.json"), "utf8"), before);
  const applied = cli("scenario", "set", "--thread", "one", "--scenario", "study", "--apply");
  assert.equal(applied.historicalMemoriesChanged, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stone, "stmem.json"))).one.purpose, "coding");
  assert.equal(fs.readFileSync(path.join(memory, "history.txt"), "utf8"), "unchanged");
  const file = path.join(root, "prompt.md"); fs.writeFileSync(file, "Changed {userName}");
  cli("prompt", "set", "--thread", "one", "--task", "feelings", "--file", file, "--validate");
  assert.equal(fs.existsSync(path.join(memory, "prompt-overrides")), false);
  cli("prompt", "set", "--thread", "one", "--task", "feelings", "--file", file, "--apply");
  assert.equal(cli("prompt", "show", "--thread", "one", "--task", "feelings").text, "Changed User");
  assert.doesNotMatch(cli("prompt", "show", "--thread", "two", "--task", "feelings").text, /Changed/);
});

test("init requires a canonical memory and validates scenario-only input", t => {
  const root = fixture(t), sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, "rollout-thread-example.jsonl"), "{}\n");
  const file = path.join(root, "input.json");
  const input = { libraryName: "Example", threadId: "thread-example", ai: "AI", user: "User",
    runtime: "codex", scenario: "coding", sessionDir: sessions, minerMode: "subagent" };
  const run = (...args) => execFileSync(process.execPath, [path.resolve(__dirname, "../bin/stmem"), ...args], {
    env: { ...process.env, HOME: root, USERPROFILE: root }, encoding: "utf8", windowsHide: true,
  });
  fs.writeFileSync(file, JSON.stringify(input));
  const configFile = path.join(root, ".stone_memory", "stmem.json");
  assert.throws(() => run("init", "--batch-file", file, "--validate"), /旧布局创建入口已关闭/);
  assert.equal(fs.existsSync(configFile), false);
  const memory = JSON.parse(run("memory", "create", "--name", "Example")).memory;
  const beforeValidation = fs.readFileSync(configFile, "utf8");
  assert.equal(JSON.parse(run("init", "--memory", memory.memoryId, "--batch-file", file, "--validate")).valid, true);
  assert.equal(fs.readFileSync(configFile, "utf8"), beforeValidation);
  run("init", "--memory", memory.memoryId, "--batch-file", file);
  assert.equal(JSON.parse(fs.readFileSync(configFile))[input.threadId].purpose, "coding");
  run("scenario", "set", "--memory", memory.memoryId, "--scenario", "study", "--apply");
  assert.equal(JSON.parse(run("scenario", "set", "--memory", memory.memoryId, "--scenario", "study")).scenario, "study");
  const before = fs.readFileSync(configFile, "utf8");
  fs.writeFileSync(file, JSON.stringify({ ...input, scenario: "does-not-exist" }));
  assert.throws(() => run("init", "--memory", memory.memoryId, "--batch-file", file, "--validate"));
  assert.equal(fs.readFileSync(configFile, "utf8"), before);
});

test("merged preview and targeted mining resolve the same scene-specific task prompts", async t => {
  let miner;
  t.after(() => miner?.store.close());
  const memoryDir = fixture(t);
  miner = new MemoryMiner({ memoryDir, threadId: "merged-fixture", personaConfig: { purpose: "accompany", scenario: "study" }, deepseekConfig: {} });
  for (const [task, text] of [["feelings", "SUMMARY_MARKER"], ["features", "FEATURE_MARKER"]]) {
    const file = promptOverridePath(memoryDir, "study", task);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  miner.store.insertMessages([
    { timestamp: "2026-06-12T00:00:00Z", sourceDate: "2026-06-12", role: "user", text: "one" },
    { timestamp: "2026-06-13T00:00:00Z", sourceDate: "2026-06-13", role: "user", text: "two" },
  ]);
  const calls = [];
  miner._extractViaSubagent = async (_messages, prompt, options) => {
    calls.push({ prompt, ...options });
    return options.expectedKey === "features" ? [] : [{ content: "6月12日，早上八点。测试事件。", importance: 3 }];
  };
  await miner.previewMerged(["2026-06-12", "2026-06-13"]);
  assert.match(calls.find(row => row.expectedKey === "feelings").prompt, /SUMMARY_MARKER/);
  const features = calls.find(row => row.expectedKey === "features");
  assert.match(features.prompt, /FEATURE_MARKER/);
  assert.doesNotMatch(features.prompt, /SUMMARY_MARKER/);
  await miner.mineTargeted("2026-06-12", miner.store.listMessages({ date: "2026-06-12" }));
  assert.match(calls.at(-1).prompt, /SUMMARY_MARKER/);
});

test("all engines use registered tasks and changed instructions invalidate chunk caches", async t => {
  const miners = [];
  t.after(() => miners.forEach(miner => miner.store.close()));
  const root = fixture(t);
  for (const runtime of ["claude", "codex"]) {
    for (const api of [false, true]) {
      const memoryDir = path.join(root, `${runtime}-${api}`);
      const miner = new MemoryMiner({ memoryDir, threadId: `${runtime}-${api}`, personaConfig: { purpose: "coding", scenario: "study", runtime },
        deepseekConfig: api ? { apiKey: "fake", model: "fake", baseUrl: "https://example.invalid" } : {} });
      miners.push(miner);
      const prompts = [];
      miner._extractViaSubagent = async (messages, prompt, options) => {
        prompts.push({ prompt, options });
        return options.expectedKey === "feelings" ? [{ content: "6月12日，早上八点。事件。", importance: 3 }] : [];
      };
      const date = "2026-06-12", messages = [{ timestamp: `${date}T00:00:00Z`, text: "Example" }];
      await miner._generatePendingDay(date, messages, {}, miner._readOperationsPrompt());
      assert.equal(prompts.length, 2);
      assert.match(prompts[0].prompt, /学习伙伴/);
      assert.equal(miner.chunkReport[0].channel, api ? "api" : "subagent");
      miner.pendingFeelings = []; miner.pendingFeatures = [];
      await miner._generatePendingDay(date, messages, {}, miner._readOperationsPrompt());
      assert.equal(prompts.length, 2, "unchanged instructions reuse both cached tasks");
      const file = promptOverridePath(memoryDir, "study", "feelings");
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "New instructions");
      miner.pendingFeelings = []; miner.pendingFeatures = [];
      await miner._generatePendingDay(date, messages, {}, miner._readOperationsPrompt());
      assert.equal(prompts.length, 4, "changed plan cannot reuse old chunks");
      assert.match(prompts[2].prompt, /New instructions/);
    }
  }
});
