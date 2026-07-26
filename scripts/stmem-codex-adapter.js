#!/usr/bin/env node
const fs = require("fs");
const {
  handleCodexNotification,
} = require("../src/services/automatic-rebuild-adapters");

function parseNotification(argv = process.argv.slice(2), readStdin = () => fs.readFileSync(0, "utf8")) {
  const argument = argv.find(value => String(value).trim().startsWith("{"));
  return JSON.parse(argument || readStdin() || "{}");
}

async function main() {
  const notification = parseNotification();
  const result = await handleCodexNotification(notification);
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { parseNotification };
