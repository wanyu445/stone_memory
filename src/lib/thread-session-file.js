const fs = require("fs");
const path = require("path");

function findThreadSessionFile(root, threadId) {
  if (!root || !fs.existsSync(root)) return null;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findThreadSessionFile(file, threadId);
      if (found) return found;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)
      && !entry.name.includes(".rebuilt") && !entry.name.includes("compressed")) return file;
  }
  return null;
}

module.exports = { findThreadSessionFile };
