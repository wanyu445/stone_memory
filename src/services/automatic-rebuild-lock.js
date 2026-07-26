const path = require("path");
const { getThreadDir } = require("../config");
const {
  withFileLock,
  withFileLockSync,
} = require("../lib/file-lock");

function lockPath(threadId, name) {
  return path.join(getThreadDir(threadId), "logs", name);
}

function withAutomaticRebuildLock(threadId, operation) {
  return withFileLock(lockPath(threadId, "automatic-rebuild.lock"), operation, {
    timeoutMs: 35 * 60_000,
    staleMs: 2 * 60 * 60_000,
  });
}

function withAutomaticRebuildPolicyLock(threadId, operation) {
  return withFileLock(
    lockPath(threadId, "automatic-rebuild-policy.lock"),
    operation,
    {
      timeoutMs: 5000,
      staleMs: 30_000,
    },
  );
}

function withAutomaticRebuildPolicyLockSync(threadId, operation, {
  timeoutMs = 5000,
} = {}) {
  return withFileLockSync(
    lockPath(threadId, "automatic-rebuild-policy.lock"),
    operation,
    {
      timeoutMs,
      staleMs: 30_000,
    },
  );
}

module.exports = {
  withAutomaticRebuildLock,
  withAutomaticRebuildPolicyLock,
  withAutomaticRebuildPolicyLockSync,
};
