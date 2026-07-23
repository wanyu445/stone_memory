#!/usr/bin/env node
const { getCfg, listThreadIds } = require("../src/config");

const threads = listThreadIds();
console.log("记忆体列表:\n");
for (const threadId of threads) {
  console.log(`  ${getCfg("label", threadId, threadId)}`);
  console.log(`    绑定线程: ${threadId}`);
  console.log(`    ${getCfg("runtime", threadId, "claude")} · ${getCfg("purpose", threadId, "accompany")}\n`);
}
if (!threads.length) console.log("  还没有记忆体。运行 stmem init 开始。");
