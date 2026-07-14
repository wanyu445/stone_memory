#!/usr/bin/env node
const path = require("path");
const { getThreadDir, listThreadIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");

const args = process.argv.slice(2);
const action = args[0] || "status";
const threadIdx = args.indexOf("--thread");
const tid = threadIdx >= 0 ? args[threadIdx + 1] : listThreadIds()[0];
if (!tid) throw new Error("未指定线程，请使用 --thread <id>");
const memoryDir = path.join(getThreadDir(tid), "memory");
const store = new MemoryStore({ memoryDir, threadId: tid });

try {
  if (action === "migrate") {
    const result = store.migrateLegacy();
    console.log(JSON.stringify({ threadId: tid, ...result }, null, 2));
  } else if (action === "status") {
    console.log(JSON.stringify({
      threadId: tid,
      feelings: store.listFeelings().length,
      features: store.listFeatures().length,
      integrity: store.db.pragma("integrity_check", { simple: true }),
    }, null, 2));
  } else {
    throw new Error("用法: stmem db [status|migrate] [--thread <id>]");
  }
} finally {
  store.close();
}
