const fs = require("fs");
const path = require("path");
const { getThreadDir } = require("../config");
const { withFileLockSync, writeJsonAtomic } = require("../lib/file-lock");

function stateFile(threadId) {
  return path.join(getThreadDir(threadId), "logs", "rebuild-state.json");
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function createRebuildStateStore({
  resolveStateFile = stateFile,
  now = () => new Date().toISOString(),
} = {}) {
  function read(threadId) {
    const file = resolveStateFile(threadId);
    return withFileLockSync(`${file}.lock`, () => readJson(file), {
      timeoutMs: 5000,
      staleMs: 30_000,
    });
  }

  function update(threadId, updater) {
    const file = resolveStateFile(threadId);
    return withFileLockSync(`${file}.lock`, () => {
      const current = readJson(file);
      const updated = updater({ ...current });
      const next = updated && typeof updated === "object" ? updated : current;
      next.updatedAt = now();
      writeJsonAtomic(file, next);
      return next;
    }, { timeoutMs: 5000, staleMs: 30_000 });
  }

  function appendRebuildLog(threadId, record) {
    const row = { completedAt: now(), threadId, ...record };
    update(threadId, state => {
      if (row.status === "completed") {
        state.lastCompleted = row;
        delete state.pendingReplace;
      } else if (row.status === "pending_replace") {
        state.pendingReplace = row;
      }
      return state;
    });
    return row;
  }

  function updateContextUsage(threadId, usage) {
    let saved;
    update(threadId, state => {
      const ignoreBefore = Date.parse(state.automaticRebuild?.ignoreUsageBefore || "");
      const observedAt = Date.parse(usage?.observedAt || "");
      if (Number.isFinite(ignoreBefore)
        && (!Number.isFinite(observedAt) || observedAt <= ignoreBefore)) {
        saved = state.contextUsage || null;
        return state;
      }
      saved = { ...(state.contextUsage || {}), ...usage, updatedAt: now() };
      state.contextUsage = saved;
      return state;
    });
    return saved;
  }

  function updateDetectedContextWindow(threadId, detected) {
    let saved;
    update(threadId, state => {
      const current = state.contextUsage || {};
      saved = {
        ...current,
        detectedMaxTokens: detected.detectedMaxTokens,
        detectedAt: detected.detectedAt || now(),
        detectedSource: detected.detectedSource,
        updatedAt: now(),
      };
      state.contextUsage = saved;
      return state;
    });
    return saved;
  }

  return {
    appendRebuildLog,
    read,
    update,
    updateContextUsage,
    updateDetectedContextWindow,
  };
}

const defaultStore = createRebuildStateStore();

function readRebuildState(threadId) {
  return defaultStore.read(threadId);
}

function updateRebuildState(threadId, updater) {
  return defaultStore.update(threadId, updater);
}

function appendRebuildLog(threadId, record) {
  return defaultStore.appendRebuildLog(threadId, record);
}

function updateContextUsage(threadId, usage) {
  return defaultStore.updateContextUsage(threadId, usage);
}

function updateDetectedContextWindow(threadId, detected) {
  return defaultStore.updateDetectedContextWindow(threadId, detected);
}

function latestSuccessfulRebuild(threadId) {
  const current = readRebuildState(threadId);
  if (current.lastCompleted?.status === "completed") return current.lastCompleted;
  const file = path.join(getThreadDir(threadId), "logs", "rebuild.jsonl");
  let latest = null;
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.status === "completed") latest = row;
    }
  } catch {}
  return latest;
}

module.exports = {
  appendRebuildLog,
  createRebuildStateStore,
  latestSuccessfulRebuild,
  readRebuildState,
  stateFile,
  updateContextUsage,
  updateDetectedContextWindow,
  updateRebuildState,
};
