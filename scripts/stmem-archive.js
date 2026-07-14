#!/usr/bin/env node
const { execSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const STONE = path.join(os.homedir(), ".stone_memory");
const cfg = JSON.parse(fs.readFileSync(path.join(STONE, "stmem.json"), "utf8"));

const args = process.argv.slice(3);
const srcIdx = args.indexOf("--source");
const srcFolder = srcIdx >= 0 ? args[srcIdx + 1] : "";

if (!srcFolder) {
  console.log("用法: stmem archive --source <folder>");
  process.exit(1);
}

const threadId = cfg.threadId;
const runtime = cfg.runtime || "claude";
const purpose = cfg.purpose || "accompany";
const archiveDir = path.join(STONE, "runtimes", runtime, purpose, threadId, "memory", "archive");
fs.mkdirSync(archiveDir, { recursive: true });

// 调现有 archive-generator.js
const generator = path.join(__dirname, "archive-generator.js");
const cmd = `${process.execPath} ${generator} --output "${archiveDir}" --claude "${srcFolder}"`;
console.log(`[stmem] archive ${srcFolder} → ${archiveDir}`);
try {
  const out = execSync(cmd, { encoding: "utf8" });
  console.log(out);
} catch (e) {
  console.log("archive-generator 未找到或执行失败——请确保 archive-generator.js 在 scripts/ 目录下");
  console.log(e.stderr || e.message);
}

// 复制原线程为 full.jsonl
const threadFile = path.join(srcFolder, `${threadId}.jsonl`);
if (fs.existsSync(threadFile)) {
  const fullPath = path.join(STONE, "runtimes", runtime, purpose, threadId, "full.jsonl");
  fs.copyFileSync(threadFile, fullPath);
  console.log(`full.jsonl 已保存`);
}
