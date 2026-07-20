const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveAutoCompactConfig } = require("../src/services/auto-compact-config");

test("automatic compact is disabled unless explicitly enabled", () => {
  assert.deepEqual(resolveAutoCompactConfig({}), { enabled: false });
  assert.deepEqual(resolveAutoCompactConfig({ autoCompact: { maxChars: 70000 } }), { enabled: false });
});

test("automatic compact accepts explicit trigger and stop watermarks", () => {
  assert.deepEqual(resolveAutoCompactConfig({ autoCompact: {
    enabled: true, maxChars: 70000, stopChars: 60000,
  } }), { enabled: true, maxChars: 70000, stopChars: 60000 });
});

test("automatic compact rejects unsafe watermark configurations", () => {
  assert.match(resolveAutoCompactConfig({ autoCompact: { enabled: true } }).error, /maxChars/);
  assert.match(resolveAutoCompactConfig({ autoCompact: {
    enabled: true, maxChars: 60000, stopChars: 70000,
  } }).error, /不能高于/);
});
