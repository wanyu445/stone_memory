const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { diagnoseThread } = require("../src/services/system-doctor");

test("doctor fails closed for an unknown thread without recommending source changes", () => {
  const result = diagnoseThread("definitely-not-configured", { projectDir: fs.mkdtempSync(path.join(os.tmpdir(), "stmem-doctor-")) });
  assert.equal(result.ok, false);
  assert.equal(result.code, "THREAD_NOT_CONFIGURED");
  assert.equal(result.sourceModificationRequired, false);
  assert.match(result.nextCommand, /^stmem memory create/);
  assert.ok(result.forbiddenActions.some(item => item.includes("不要修改源码")));
});
