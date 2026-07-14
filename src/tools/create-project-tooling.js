const { runSubagent } = require("../services/subagent");

// 在你的 services 对象中加入:
//   subagent: { run: (prompt, opts) => runSubagent(prompt, opts || {}) },
// 以及你的其他 services (diary, reminder, sticker 等)
// 不要把整个文件替换——只加这一行
