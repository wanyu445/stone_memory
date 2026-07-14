#!/usr/bin/env node
// 兼容入口：历史回填与正常多日挖掘使用同一条 SQLite 管线。
const args = process.argv.slice(2);
if (!args.includes("--all")) args.push("--all");
process.argv = [process.argv[0], process.argv[1], "mine", ...args];
require("./stmem-mine");
