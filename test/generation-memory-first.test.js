const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getMemoryRuntimeConfig, CONFIG_PATH } = require("../src/config");
const { codexProviderFromConfig } = require("../src/services/subagent-runner");
const { resolveConfiguredGenerationMode } = require("../src/services/configured-generation-service");

test("canonical generation config supersedes stale legacy provider settings", t => {
  const id = `test-generation-${require("node:crypto").randomUUID()}`;
  const dir = path.join(path.dirname(CONFIG_PATH), "memories", id);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A registered memory without a legacy entry is a canonical draft.
  fs.writeFileSync(path.join(dir, "memory.json"), JSON.stringify({ miner: { mode: "api", apiProfile: "new-provider" } }));
  const config = { memories: { [id]: { memoryId: id } }, apiKeys: {
    "new-provider": { key: "fixture-key", model: "fixture-model", baseUrl: "https://fixture.invalid/v1", wireApi: "responses" },
  } };
  assert.equal(getMemoryRuntimeConfig(id, config).apiProvider, "new-provider");
  assert.equal(resolveConfiguredGenerationMode(id, { loadConfigImpl: () => config }), "api");
  const provider = codexProviderFromConfig(config, id);
  assert.equal(provider.provider, "new-provider");
  assert.equal(provider.model, "fixture-model");
});
