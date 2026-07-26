#!/usr/bin/env node
const { loadConfig } = require("../src/config");
const {
  executePendingRebuild,
  isTurnBlocked,
} = require("../src/services/automatic-rebuild-coordinator");
const {
  resolveAutomaticRebuildConfig,
} = require("../src/services/automatic-rebuild-config");
const {
  readAutomaticRebuildState,
} = require("../src/services/automatic-rebuild-state");
const {
  createRuntimeLifecycleController,
} = require("../src/services/runtime-lifecycle");
const {
  installClaudeAdapters,
  uninstallClaudeAdapters,
} = require("../src/services/claude-adapter-installation");

function threadIdFrom(args) {
  const index = args.indexOf("--thread");
  return index >= 0 ? args[index + 1] : process.env.STMEM_THREAD_ID;
}

async function main() {
  const args = process.argv.slice(3);
  if (args.includes("--install-claude")) {
    console.log(JSON.stringify(installClaudeAdapters(), null, 2));
    return;
  }
  if (args.includes("--uninstall-claude")) {
    console.log(JSON.stringify(uninstallClaudeAdapters(), null, 2));
    return;
  }
  const threadId = threadIdFrom(args);
  if (!threadId) throw new Error("请指定 --thread <id>");
  if (args.includes("--turn-settled")) {
    const result = await executePendingRebuild(threadId, {
      turnSettled: true,
      logger: message => console.error(`[automatic-rebuild] ${message}`),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.includes("--gate")) {
    const blocked = isTurnBlocked(threadId);
    console.log(JSON.stringify({ threadId, blocked }, null, 2));
    if (blocked) process.exitCode = 75;
    return;
  }
  const threadConfig = loadConfig()[threadId] || {};
  const config = resolveAutomaticRebuildConfig(threadConfig);
  if (args.includes("--start") || args.includes("--stop") || args.includes("--health")) {
    if (!config.ready) throw new Error(config.errors.join("; ") || "automatic rebuild is disabled");
    const lifecycle = createRuntimeLifecycleController(config.lifecycle, { threadId });
    const action = args.includes("--start") ? "start" : args.includes("--stop") ? "stop" : "health";
    console.log(JSON.stringify(await lifecycle[action](), null, 2));
    return;
  }
  console.log(JSON.stringify({
    threadId,
    config,
    state: readAutomaticRebuildState(threadId),
    turnBlocked: isTurnBlocked(threadId),
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
