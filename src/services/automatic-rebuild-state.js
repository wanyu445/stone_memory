const {
  readRebuildState,
  updateRebuildState,
} = require("./rebuild-log");
const { sanitizeDiagnostic } = require("../lib/sanitize-diagnostic");

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
        resumeTurnAdmission: null,
        resumeTurnAdmittedAt: null,
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
      lastError: sanitizeDiagnostic(error?.message || error),
      lastResult: record,
    }));
  }

  function setManagedRuntime(threadId, runtime) {
    return update(threadId, current => ({
      ...current,
      managedRuntime: runtime || null,
    }));
  }

  function admitResumeTurn(threadId) {
    let admitted = false;
    const state = update(threadId, current => {
      if (!current.rebuildPending || current.resumeTurnAdmission !== "available") {
        return current;
      }
      admitted = true;
      return {
        ...current,
        resumeTurnAdmission: "admitted",
        resumeTurnAdmittedAt: now(),
      };
    });
    return { admitted, state };
  }

  function consumeResumeTurn(threadId) {
    let consumed = false;
    const state = update(threadId, current => {
      if (!current.rebuildPending || current.resumeTurnAdmission !== "admitted") {
        return current;
      }
      consumed = true;
      return {
        ...current,
        resumeTurnAdmission: "settling",
      };
    });
    return { consumed, state };
  }

  function releaseResumeTurn(threadId) {
    return update(threadId, current => (
      current.rebuildPending && current.resumeTurnAdmission === "settling"
        ? {
          ...current,
          resumeTurnAdmission: "available",
          resumeTurnAdmittedAt: null,
        }
        : current
    ));
  }

  function noteConfigEnabled(threadId, enabled, {
    lifecycleMode = null,
    runtimeInspection = null,
  } = {}) {
    return update(threadId, current => {
      const next = { ...current };
      if (lifecycleMode) next.lifecycleMode = lifecycleMode;
      if (enabled) {
        next.status = current.rebuildPending ? "rebuild_pending" : "watching";
        next.resumeTurnAdmission = current.rebuildPending ? "available" : null;
        next.resumeTurnAdmittedAt = null;
        delete next.disableRequestedAt;
        delete next.runtimeInspectionReason;
        return next;
      }
      next.disableGeneration = (Number(current.disableGeneration) || 0) + 1;
      next.resumeTurnAdmission = null;
      next.resumeTurnAdmittedAt = null;
      delete next.runtimeInspectionReason;
      const status = String(current.status || "");
      if (status.startsWith("disabled_") || status === "disable_requested") {
        next.disableRequestedAt = current.disableRequestedAt || now();
        return next;
      }
      if (["rebuilding", "checking"].includes(status)) {
        next.status = "disabled_waiting_safe_rebuild_exit";
        next.runtimeRunning = false;
        next.stopAttempted = true;
      } else if (status === "stopping" && current.stopAttempted !== true) {
        next.status = "disabled_cancelled_before_stop";
        next.runtimeRunning = null;
        next.stopAttempted = false;
      } else if (["starting", "recovering", "stopping"].includes(status)) {
        next.status = "disable_requested";
        next.runtimeRunning = null;
        next.stopAttempted = true;
      } else {
        const runtimeRunning = typeof runtimeInspection?.running === "boolean"
          ? runtimeInspection.running
          : runtimeInspection?.running === null
            ? null
            : typeof current.runtimeRunning === "boolean"
              ? current.runtimeRunning
              : current.managedRuntime?.stoppedAt
                ? false
                : null;
        next.status = runtimeRunning === true
          ? "disabled_idle_runtime_running"
          : runtimeRunning === false
            ? "disabled_idle_runtime_stopped"
            : "disabled_idle_runtime_status_unknown";
        next.runtimeRunning = runtimeRunning;
        if (runtimeInspection?.reason) {
          next.runtimeInspectionReason = runtimeInspection.reason;
        }
        next.stopAttempted = false;
      }
      next.disableRequestedAt = now();
      return next;
    });
  }

  return {
    admitResumeTurn,
    consumeResumeTurn,
    releaseResumeTurn,
    markCompleted,
    markFailed,
    noteConfigEnabled,
    observeUsage,
    read,
    setManagedRuntime,
    setPhase,
    update,
  };
}

const automatic = createAutomaticRebuildState();

module.exports = {
  admitAutomaticRebuildResumeTurn: automatic.admitResumeTurn,
  consumeAutomaticRebuildResumeTurn: automatic.consumeResumeTurn,
  releaseAutomaticRebuildResumeTurn: automatic.releaseResumeTurn,
  createAutomaticRebuildState,
  markCompleted: automatic.markCompleted,
  markFailed: automatic.markFailed,
  noteAutomaticRebuildConfigEnabled: automatic.noteConfigEnabled,
  observeUsage: automatic.observeUsage,
  readAutomaticRebuildState: automatic.read,
  setManagedRuntime: automatic.setManagedRuntime,
  setPhase: automatic.setPhase,
  updateAutomaticRebuildState: automatic.update,
};
