#!/usr/bin/env node
/**
 * stmem rebuild — 按 runtime 分流到对应 rebuild 脚本
 */
const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");

function main() {
  const args = process.argv.slice(3);
  const apply = args.includes("--apply");
  const threadId = args.find((a, i) => a === "--thread" && i + 1 < args.length)
    ? args[args.indexOf("--thread") + 1] : null;
  const windowIdx = args.indexOf("--window");
  const toolPairsIdx = args.indexOf("--tool-pairs");

  const { getCfg } = require("../src/config");
  if (!threadId) {
    console.log("请指定 --thread <id>");
    process.exit(1);
  }

  const runtime = getCfg("runtime", threadId, "claude");
  const window = windowIdx >= 0 ? args[windowIdx + 1] : getCfg("windowDays", threadId, 3);
  const toolPairs = toolPairsIdx >= 0 ? args[toolPairsIdx + 1] : "";

  const script = path.join(__dirname, runtime === "codex" ? "rebuild-codex-thread.js" : "rebuild-thread.js");
  const spawnArgs = [script, "--thread", threadId];
  if (apply) spawnArgs.push("--apply");
  if (window) { spawnArgs.push("--window"); spawnArgs.push(String(window)); }
  if (toolPairs) { spawnArgs.push("--tool-pairs"); spawnArgs.push(String(toolPairs)); }

  console.log(`[stmem] ${runtime} rebuild ${threadId}, window=${window}${toolPairs ? `, pairs=${toolPairs}` : ""}...`);
  const result = spawnSync(process.execPath, spawnArgs, { stdio: "inherit", cwd: path.dirname(__dirname) });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  process.exit(result.status);
}

main();
