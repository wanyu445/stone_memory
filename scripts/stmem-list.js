#!/usr/bin/env node
const { getCfg, listMemoryIds } = require("../src/config");

const threads = listMemoryIds();
console.log("记忆体列表:\n");
for (const threadId of threads) {
  console.log(`  ${getCfg("label", threadId, threadId)}`);
  console.log(`    记忆体 ID: ${threadId}`);
  console.log(`    ${getCfg("runtime", threadId, "claude")} · ${getCfg("purpose", threadId, "accompany")}\n`);
}
if (!threads.length) console.log("  还没有记忆体。运行 stmem memory create 开始。");
