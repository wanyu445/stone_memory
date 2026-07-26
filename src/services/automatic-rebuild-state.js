const {
  readRebuildState,
  updateRebuildState,
} = require("./rebuild-log");

const defaultStore = {
  read: readRebuildState,
  update: updateRebuildState,
};

function timestamp(value) {
  const number = Date.parse(value || "");
  return Number.isFinite(number) ? number : null;
}

function createAutomaticRebuildState({
  store = defaultStore,
  now = () => new Date().toISOString(),
} = {}) {
  function read(threadId) {
    return store.read(threadId).automaticRebuild || {};
  }

  function update(threadId, updater) {
    const root = store.update(threadId, state => {
      const current = state.automaticRebuild || {};
      const next = updater({ ...current }, state) || current;
      state.automaticRebuild = { ...next, updatedAt: now() };
      return state;
    });
    return root.automaticRebuild;
  }

  function observeUsage(threadId, usage, thresholdTokens) {
    const usedTokens = Number(usage?.usedTokens);
    if (!Number.isFinite(usedTokens) || usedTokens < 0) return read(threadId);
    return update(threadId, current => {
      const observedTime = timestamp(usage.observedAt);
      const ignoreBefore = timestamp(current.ignoreUsageBefore);
      if (ignoreBefore != null
        && (observedTime == null || observedTime <= ignoreBefore)) {
        return { ...current, ignoredUsageAt: now() };
      }
      const observedAt = usage.observedAt || now();
      const highWaterTokens = Math.max(Number(current.highWaterTokens) || 0, usedTokens);
      const crossed = Number.isFinite(thresholdTokens)
        && thresholdTokens > 0
        && highWaterTokens >= thresholdTokens;
      const rebuildPending = Boolean(current.rebuildPending || crossed);
      return {
        ...current,
        status: rebuildPending ? "rebuild_pending" : "watching",
        rebuildPending,
        highWaterTokens,
        thresholdTokens: Number.isFinite(thresholdTokens) ? thresholdTokens : null,
        lastObservedTokens: usedTokens,
        lastObservedAt: observedAt,
        pendingSince: current.pendingSince || (crossed ? now() : null),
      };
    });
  }

  function setPhase(threadId, status, extra = {}) {
    return update(threadId, current => ({ ...current, status, ...extra }));
  }

  function markCompleted(threadId, record = {}) {
    return update(threadId, (current, root) => {
      const completedAt = now();
      const usage = root.contextUsage || {};
      root.contextUsage = usage.detectedMaxTokens ? {
        detectedMaxTokens: usage.detectedMaxTokens,
        detectedAt: usage.detectedAt,
        detectedSource: usage.detectedSource,
        baselineAt: completedAt,
        updatedAt: completedAt,
      } : null;
      return {
        ...current,
        status: "watching",
        rebuildPending: false,
        highWaterTokens: 0,
        pendingSince: null,
        ignoreUsageBefore: completedAt,
        lastCompletedAt: completedAt,
        lastResult: record,
        lastError: null,
      };
    });
  }

  function markFailed(threadId, error, record = {}) {
    return update(threadId, current => ({
      ...current,
      status: "failed",
      rebuildPending: true,
      lastFailedAt: now(),
      lastError: String(error?.message || error),
      lastResult: record,
    }));
  }

  function setManagedRuntime(threadId, runtime) {
    return update(threadId, current => ({
      ...current,
      managedRuntime: runtime || null,
    }));
  }

  return {
    markCompleted,
    markFailed,
    observeUsage,
    read,
    setManagedRuntime,
    setPhase,
    update,
  };
}

const automatic = createAutomaticRebuildState();

module.exports = {
  createAutomaticRebuildState,
  markCompleted: automatic.markCompleted,
  markFailed: automatic.markFailed,
  observeUsage: automatic.observeUsage,
  readAutomaticRebuildState: automatic.read,
  setManagedRuntime: automatic.setManagedRuntime,
  setPhase: automatic.setPhase,
  updateAutomaticRebuildState: automatic.update,
};
