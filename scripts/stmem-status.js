#!/usr/bin/env node
const { loadConfig, getCfg, listThreadIds, getThreadDir } = require("../src/config");
const path = require("path");
const { MemoryStore } = require("../src/storage/memory-store");

const threads = listThreadIds();
console.log(`Stone Memory — ${threads.length} 线程\n`);

if (threads.length === 0) {
  console.log("  未配置线程，请先运行 stmem init --thread <id>");
  process.exit(0);
}

for (const tid of threads) {
  const dir = getThreadDir(tid);
  const store = new MemoryStore({ memoryDir: path.join(dir, "memory"), threadId: tid });
  const archiveDays = store.listMessageDates().length;
  const feelingCount = store.listFeelings().length;
  const featureCount = store.listFeatures().length;
  store.close();

  const label = getCfg("label", tid, tid);
  console.log(`  ${label}`);
  console.log(`    绑定线程: ${tid}`);
  console.log(`    AI: ${getCfg("ai", tid)}  用户: ${getCfg("user", tid)} (${getCfg("userGender", tid, "female")})`);
  console.log(`    runtime: ${getCfg("runtime", tid)} | purpose: ${getCfg("purpose", tid)}`);
  console.log(`    sessionDir: ${getCfg("sessionDir", tid)}`);
  console.log(`    window: ${getCfg("windowDays", tid)}天 | toolPairs: ${getCfg("keepToolPairs", tid)}`);
  console.log(`    archive: ${archiveDays}天 | feelings: ${feelingCount} | features: ${featureCount}`);
  console.log("");
}
