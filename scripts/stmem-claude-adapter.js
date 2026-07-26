#!/usr/bin/env node
const fs = require("fs");
const { spawnSync } = require("child_process");
const {
  handleClaudeStop,
  handleClaudeTurnGate,
  reportClaudeContextWindow,
} = require("../src/services/automatic-rebuild-adapters");
const {
  readClaudeAdapterState,
} = require("../src/services/claude-adapter-installation");

function readInput() {
  const raw = fs.readFileSync(0, "utf8");
  return { raw, payload: JSON.parse(raw || "{}") };
}

function runStatusLine() {
  const { raw, payload } = readInput();
  try { reportClaudeContextWindow(payload); } catch {}
  const original = readClaudeAdapterState().originalStatusLine;
  if (!original?.command) return;
  const result = spawnSync(original.command, {
    shell: true,
    input: raw,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
}

async function runStopHook() {
  const { payload } = readInput();
  try {
    await handleClaudeStop(payload);
    process.stdout.write(JSON.stringify({ suppressOutput: true }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      suppressOutput: true,
      systemMessage: `Stone Memory 自动 rebuild 失败，已保留 pending：${error.message}`,
    }));
  }
}

function runTurnGate() {
  const { payload } = readInput();
  const result = handleClaudeTurnGate(payload);
  if (!result.blocked) return;
  process.stderr.write(
    "Stone Memory 自动 rebuild 尚未安全完成，已阻止下一轮；请修复生命周期错误并重试。\n",
  );
  process.exitCode = 2;
}

async function main() {
  if (process.argv.includes("--status-line")) {
    runStatusLine();
    return;
  }
  if (process.argv.includes("--stop")) {
    await runStopHook();
    return;
  }
  if (process.argv.includes("--gate")) {
    runTurnGate();
    return;
  }
  throw new Error("请指定 --status-line、--stop 或 --gate");
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
