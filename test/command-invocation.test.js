const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCommandLine, commandInvocation, appendOption } = require("../src/lib/command-invocation");
const { resolveMcpThread } = require("../src/services/mcp-thread-resolution");

test("runtime commands become executable and argument arrays without shell expansion", () => {
  assert.deepEqual(parseCommandLine('codex exec --profile "memory worker"'), [
    "codex", "exec", "--profile", "memory worker",
  ]);
  assert.deepEqual(parseCommandLine('"C:\\Program Files\\Codex\\codex.exe" exec'), [
    "C:\\Program Files\\Codex\\codex.exe", "exec",
  ]);
  const invocation = commandInvocation("claude -p --bare", { remove: ["-p"] });
  appendOption(invocation.args, "--model", "model; touch /tmp/unsafe");
  assert.deepEqual(invocation, {
    file: "claude",
    args: ["--bare", "--model", "model; touch /tmp/unsafe"],
  });
});

test("runtime command parser rejects malformed quoting", () => {
  assert.throws(() => parseCommandLine('codex exec "unfinished'), /unclosed quote/);
});

test("MCP thread resolution requires explicit binding when multiple memories exist", () => {
  const cfg = { qiheng: {}, chengxu: {} };
  assert.equal(resolveMcpThread({ thread: "qiheng" }, cfg, ["qiheng", "chengxu"], {}), "qiheng");
  assert.equal(resolveMcpThread({}, cfg, ["qiheng", "chengxu"], { STMEM_THREAD_ID: "chengxu" }), "chengxu");
  assert.throws(() => resolveMcpThread({}, cfg, ["qiheng", "chengxu"], {}), /显式指定 thread/);
  assert.equal(resolveMcpThread({}, { qiheng: {} }, ["qiheng"], {}), "qiheng");
  assert.throws(() => resolveMcpThread({ thread: "missing" }, cfg, ["qiheng", "chengxu"], {}), /未配置线程/);
});
