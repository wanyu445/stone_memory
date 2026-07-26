#!/usr/bin/env node
const fs = require("fs");
const {
  handleCodexStop,
  handleCodexTurnGate,
  handleCodexNotification,
} = require("../src/services/automatic-rebuild-adapters");

function parseNotification(argv = process.argv.slice(2), readStdin = () => fs.readFileSync(0, "utf8")) {
  const argument = argv.find(value => String(value).trim().startsWith("{"));
  return JSON.parse(argument || readStdin() || "{}");
}

async function runStopHook() {
  const payload = parseNotification([]);
  try {
    await handleCodexStop(payload);
    process.stdout.write(JSON.stringify({ suppressOutput: true }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      suppressOutput: true,
      systemMessage: `Stone Memory 自动 rebuild 失败，已保留 pending：${error.message}`,
    }));
  }
}

function runTurnGate() {
  const result = handleCodexTurnGate(parseNotification([]));
  if (!result.blocked) return;
  process.stderr.write(
    "Stone Memory 自动 rebuild 尚未安全完成，已阻止下一轮；请修复生命周期错误并重试。\n",
  );
  process.exitCode = 2;
}

async function main() {
  if (process.argv.includes("--stop")) {
    await runStopHook();
    return;
  }
  if (process.argv.includes("--gate")) {
    runTurnGate();
    return;
  }
  const notification = parseNotification();
  const result = await handleCodexNotification(notification);
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { parseNotification, runStopHook, runTurnGate };
