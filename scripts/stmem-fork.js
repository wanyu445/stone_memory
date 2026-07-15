#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryStore } = require("../src/storage/memory-store");

const stone = path.join(os.homedir(), ".stone_memory");
const configFile = path.join(stone, "stmem.json");
const args = process.argv.slice(3);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const parentId = value("--parent");
const childId = value("--thread");

if (!parentId || !childId) {
  console.error("用法: stmem fork --parent <父线程id> --thread <子线程id> [--no-memory-return]");
  process.exit(1);
}

let config;
try { config = JSON.parse(fs.readFileSync(configFile, "utf8")); }
catch { config = {}; }
const parent = config[parentId];
const child = config[childId];
if (!parent) throw new Error(`父线程未配置: ${parentId}`);
if (!child) throw new Error(`子线程未配置: ${childId}（请先 stmem init）`);

const runtime = child.runtime || "claude";
const purpose = child.purpose || "accompany";
const memoryDir = path.join(stone, "runtimes", runtime, purpose, childId, "memory");
const parentMemoryDir = path.join(stone, "runtimes", parent.runtime || "claude", parent.purpose || "accompany", parentId, "memory");
const parentStore = new MemoryStore({ memoryDir: parentMemoryDir, threadId: parentId });
parentStore.close();
const store = new MemoryStore({ memoryDir, threadId: childId });
try {
  store.setFork({ parentThreadId: parentId, memoriesFlowToParent: !args.includes("--no-memory-return") });
} finally {
  store.close();
}

child.parentThreadId = parentId;
child.memoriesFlowToParent = !args.includes("--no-memory-return");
fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");
console.log(`✅ ${childId} 已关联到父线程 ${parentId}`);
console.log(`   父级 feelings/features: 每次 rebuild 动态可见`);
console.log(`   子线程记忆回流: ${child.memoriesFlowToParent ? "开启" : "关闭"}`);
console.log(`   近期 full: 仍只读取子线程自身`);
