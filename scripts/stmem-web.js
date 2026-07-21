#!/usr/bin/env node
const { startWebServer } = require("../src/web/server");

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const port = Number(value("--port")) || 4173;
const host = value("--host") || "127.0.0.1";

startWebServer({ host, port }).then(server => {
  const address = server.address();
  console.log(`Stone Memory 前端已启动：http://${address.address}:${address.port}`);
  console.log("按 Ctrl+C 停止。");
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
