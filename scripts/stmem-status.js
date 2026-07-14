#!/usr/bin/env node
const { loadConfig, getCfg, listThreadIds, getThreadDir } = require("../src/config");
const fs = require("fs");

const threads = listThreadIds();
console.log(`Stone Memory — ${threads.length} 线程\n`);

if (threads.length === 0) {
  console.log("  未配置线程，请先运行 stmem init --thread <id>");
  process.exit(0);
}

for (const tid of threads) {
  const dir = getThreadDir(tid);
  let archiveDays = 0, feelingCount = 0, featureCount = 0;
  try { archiveDays = fs.readdirSync(dir + "/memory/archive").filter(f => f.endsWith(".jsonl")).length; } catch {}
  try {
    const ff = dir + "/memory/mined/feelings/days.jsonl";
    if (fs.existsSync(ff)) feelingCount = fs.readFileSync(ff, "utf8").split("\n").filter(l => {
      try { return JSON.parse(l).type === "feeling"; } catch { return false; }
    }).length;
  } catch {}
  try {
    const fdir = dir + "/memory/mined/features";
    for (const cat of ["eat","body","sleep","work","relation","habit","location","preference","misc"]) {
      const cf = fdir + "/" + cat + ".jsonl";
      if (fs.existsSync(cf)) featureCount += fs.readFileSync(cf, "utf8").split("\n").filter(Boolean).length;
    }
  } catch {}

  console.log(`  ${tid}`);
  const label = getCfg("label", tid, tid);
  console.log(`  线程: ${tid}${label !== tid ? ` (${label})` : ""}`);
  console.log(`    AI: ${getCfg("ai", tid)}  用户: ${getCfg("user", tid)} (${getCfg("userGender", tid, "female")})`);
  console.log(`    runtime: ${getCfg("runtime", tid)} | purpose: ${getCfg("purpose", tid)}`);
  console.log(`    sessionDir: ${getCfg("sessionDir", tid)}`);
  console.log(`    window: ${getCfg("windowDays", tid)}天 | toolPairs: ${getCfg("keepToolPairs", tid)}`);
  console.log(`    archive: ${archiveDays}天 | feelings: ${feelingCount} | features: ${featureCount}`);
  console.log("");
}
