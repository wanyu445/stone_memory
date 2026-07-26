const path = require("node:path");
const os = require("node:os");

const { createThread } = require("../src/services/thread-setup");

try {
  createThread({
    libraryName: "Invalid Thread",
    threadId: "../../lock-escape",
    ai: "Stone",
    user: "User",
    runtime: "codex",
    purpose: "accompany",
    sessionDir: path.join(os.homedir(), "sessions"),
    minerMode: "subagent",
    automaticRebuild: { enabled: false },
  }, {
    allowExisting: true,
    requireSession: false,
  });
  process.stdout.write(JSON.stringify({ error: null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }));
}
