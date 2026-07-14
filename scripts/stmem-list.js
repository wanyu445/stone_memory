#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");

const STONE = path.join(os.homedir(), ".stone_memory");
const runtimesDir = path.join(STONE, "runtimes");

console.log("线程列表:\n");
let count = 0;
for (const runtime of ["claude", "codex"]) {
  const rtDir = path.join(routineDir, runtime);
  if (!fs.existsSync(rtDir)) continue;
  for (const purpose of fs.readdirSync(rtDir)) {
    const pDir = path.join(rtDir, purpose);
    if (!fs.statSync(pDir).isDirectory()) continue;
    for (const tid of fs.readdirSync(pDir)) {
      const tDir = path.join(pDir, tid);
      if (!fs.statSync(tDir).isDirectory()) continue;
      count++;
      const hasFull = fs.existsSync(path.join(tDir, "full.jsonl"));
      const hasThread = fs.existsSync(path.join(tDir, `${tid}.jsonl`));
      console.log(`  [${runtime}] ${purpose} — ${tid}`);
      console.log(`    full: ${hasFull ? "[x]" : "[ ]"}  thread: ${hasThread ? "[x]" : "[ ]"}`);
    }
  }
}
if (count === 0) console.log("  还没有注册线程。运行 stmem init 开始。");
