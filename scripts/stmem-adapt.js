#!/usr/bin/env node
// 旧命令兼容层：adapt 不再维护独立的数据模型，统一转交 import。
const args = process.argv.slice(2);
if (args[0] === "adapt") args.shift();
const translated = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--from") { i++; continue; }
  if (args[i] === "--db" || args[i] === "--file") translated.push("--source", args[++i]);
  else translated.push(args[i]);
}
console.warn("[adapt] 此命令已合并到 stmem import；本次将使用统一导入流程。默认只预览，加 --apply 才写入。");
process.argv = [process.argv[0], process.argv[1], "import", ...translated];
require("./stmem-import");
