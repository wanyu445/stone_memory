#!/usr/bin/env node
const fs = require("fs");
const { resolveMemoryArg } = require("../src/lib/memory-cli");
const { editFeeling, batchEditFeelings, setAnchor, setAnchors } = require("../src/services/memory-editor");
const { createMemory, publicMemorySettings, updateMemorySettings, deleteDraftMemory, repairMemoryScaffold } = require("../src/services/memory-setup");

function value(args, key) {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : null;
}

function usage() {
  return `用法：
  stmem memory create [--name <名称>]
  stmem memory settings --memory <id>
  stmem memory settings --memory <id> --batch-file <json> --validate|--apply
  stmem memory migrate-layout --memory <旧版ID> [--batch-file <json>] [--apply]
  stmem memory repair --memory <id> [--apply]
  stmem memory delete --memory <id> [--apply]
  stmem memory update|batch-update|anchor --thread <兼容记忆体ID> --batch-file <json>`;
}

function runMemoryCommand(args = process.argv.slice(3)) {
  const action = args[0];
  if (["help", "--help", "-h"].includes(action)) return console.log(usage());
  if (action === "create") {
    const memory = createMemory({ label: value(args, "--name") || "新建记忆体" });
    console.log(JSON.stringify({ success: true, memory }, null, 2));
    return memory;
  }
  if (action === "settings") {
    const memoryId = value(args, "--memory") || value(args, "--thread");
    if (!memoryId) throw new Error("请指定 --memory <id>");
    const batch = value(args, "--batch-file");
    if (!batch) {
      const settings = publicMemorySettings(memoryId);
      console.log(JSON.stringify({ memoryId, settings }, null, 2));
      return settings;
    }
    if (args.includes("--apply") === args.includes("--validate")) throw new Error("设置写入必须且只能选择 --validate 或 --apply");
    const patch = JSON.parse(fs.readFileSync(batch, "utf8"));
    const result = updateMemorySettings(memoryId, patch, { apply: args.includes("--apply") });
    console.log(JSON.stringify({ memoryId, ...result }, null, 2));
    return result;
  }
  if (action === "migrate-layout") {
    const migrationArgs = args.slice(1);
    if (!migrationArgs.includes("--memory") && !migrationArgs.includes("--thread")) throw new Error("请指定 --memory <旧版ID>");
    const normalized = migrationArgs.map(arg => arg === "--thread" ? "--memory" : arg);
    return require("./migrate-legacy-memory-layout").main([...normalized, "--formal-cli"]);
  }
  if (action === "delete") {
    const memoryId = value(args, "--memory") || value(args, "--thread");
    if (!memoryId) throw new Error("请指定 --memory <id>");
    const result = deleteDraftMemory(memoryId, { apply: args.includes("--apply") });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (action === "repair") {
    const memoryId = value(args, "--memory") || value(args, "--thread");
    if (!memoryId) throw new Error("请指定 --memory <id>");
    const result = repairMemoryScaffold(memoryId, { apply: args.includes("--apply") });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const threadId = resolveMemoryArg(args, { allowDefault: false });
  const batch = value(args, "--batch-file");
  if (!batch) throw new Error("请指定 --memory 和 --batch-file");
  const input = JSON.parse(fs.readFileSync(batch, "utf8"));
  let result;
  if (action === "update") result = editFeeling(threadId, input);
  else if (action === "batch-update") result = batchEditFeelings(threadId, input.items);
  else if (action === "anchor" && Array.isArray(input.items)) result = setAnchors(threadId, input.items);
  else if (action === "anchor") result = setAnchor(threadId, input.id, input.type, input.enabled, input);
  else throw new Error(usage());
  console.log(JSON.stringify(result));
  return result;
}

try { runMemoryCommand(); }
catch (error) { console.error(`[memory] error: ${error.message}`); process.exitCode = 1; }

module.exports = { runMemoryCommand };
