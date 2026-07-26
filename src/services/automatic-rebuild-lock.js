const path = require("path");
const { getThreadDir } = require("../config");
const { withFileLock } = require("../lib/file-lock");

function withAutomaticRebuildLock(threadId, operation) {
  const lockPath = path.join(getThreadDir(threadId), "logs", "automatic-rebuild.lock");
  return withFileLock(lockPath, operation, {
    timeoutMs: 35 * 60_000,
    staleMs: 2 * 60 * 60_000,
  });
}

module.exports = { withAutomaticRebuildLock };
