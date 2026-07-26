const path = require("path");
const { spawn } = require("child_process");
const { loadConfig } = require("../config");
const { terminateProcessGroup } = require("../lib/process-group");
const { sanitizeDiagnostic } = require("../lib/sanitize-diagnostic");
const { readRebuildState } = require("./rebuild-log");
const {
  resolveAutomaticRebuildConfig,
  resolveTriggerThreshold,
} = require("./automatic-rebuild-config");
const {
  markCompleted,
  markFailed,
  admitAutomaticRebuildResumeTurn,
  consumeAutomaticRebuildResumeTurn,
  releaseAutomaticRebuildResumeTurn,
  observeUsage,
  noteAutomaticRebuildConfigEnabled,
  readAutomaticRebuildState,
  setPhase,
} = require("./automatic-rebuild-state");
const {
  createRuntimeLifecycleController,
} = require("./runtime-lifecycle");
const { withAutomaticRebuildLock } = require("./automatic-rebuild-lock");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const REBUILD_SCRIPT = path.join(PROJECT_ROOT, "scripts", "stmem-rebuild.js");
const SUPPORTED_RUNTIMES = new Set(["claude", "codex"]);

function isDisabledPolicyState(status) {
  const value = String(status || "");
  return value === "disable_requested" || value.startsWith("disabled_");
}

function parseIntegrityOutput(output) {
  let result;
  try {
    result = JSON.parse(String(output || "").trim());
  } catch {
    throw new Error("rebuild --check 没有返回有效 JSON");
  }
  if (result?.healthy !== true) {
    throw new Error(`rebuild --check 必须返回 healthy:true：${JSON.stringify(result)}`);
  }
  return result;
}

function runRebuildProcess(threadId, args, {
  timeoutMs = 30 * 60_000,
  scriptPath = REBUILD_SCRIPT,
  env = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutTermination = null;
    const child = spawn(process.execPath, [
      scriptPath,
      "rebuild",
      "--thread",
      threadId,
      ...args,
    ], {
      cwd: PROJECT_ROOT,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutTermination = process.platform === "win32"
        ? Promise.resolve().then(() => child.kill("SIGKILL"))
        : terminateProcessGroup(child.pid);
    }, timeoutMs);
    timer.unref?.();
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", async status => {
      clearTimeout(timer);
      if (timedOut) {
        let terminationError = null;
        try { await timeoutTermination; } catch (error) { terminationError = error; }
        const suffix = terminationError ? `; ${terminationError.message}` : "";
        const error = new Error(`rebuild command timed out after ${timeoutMs}ms${suffix}`);
        error.code = "REBUILD_COMMAND_TIMEOUT";
        if (terminationError?.unsafeToRestart) error.unsafeToRestart = true;
        reject(error);
        return;
      }
      if (status !== 0) {
        reject(new Error(String(stderr || stdout || `rebuild exited ${status}`).trim()));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), status });
    });
  });
}

const defaultRebuildRunner = {
  apply(threadId) {
    return runRebuildProcess(threadId, ["--apply", "--trigger", "automatic"]);
  },
  async check(threadId) {
    const result = await runRebuildProcess(threadId, ["--check"]);
    return parseIntegrityOutput(result.stdout);
  },
};

const defaultState = {
  admitResumeTurn: admitAutomaticRebuildResumeTurn,
  consumeResumeTurn: consumeAutomaticRebuildResumeTurn,
  releaseResumeTurn: releaseAutomaticRebuildResumeTurn,
  noteConfigEnabled: noteAutomaticRebuildConfigEnabled,
  markCompleted,
  markFailed,
  observeUsage,
  read: readAutomaticRebuildState,
  setPhase,
};

function defaultThreadLock(threadId, operation) {
  return withAutomaticRebuildLock(threadId, operation);
}

function createAutomaticRebuildCoordinator({
  loadThreadConfig = threadId => loadConfig()[threadId] || {},
  state = defaultState,
  lifecycleFactory = (config, options) => createRuntimeLifecycleController(config, options),
  rebuildRunner = defaultRebuildRunner,
  withThreadLock = defaultThreadLock,
  readContextUsage = threadId => readRebuildState(threadId).contextUsage || {},
  platform = process.platform,
} = {}) {
  function observeThreadUsage(threadId, usage, providedConfig = null) {
    const threadConfig = providedConfig || loadThreadConfig(threadId);
    const storedUsage = readContextUsage(threadId);
    const providedMax = Number(usage?.detectedMaxTokens);
    const effectiveUsage = {
      ...storedUsage,
      ...usage,
      detectedMaxTokens: Number.isFinite(providedMax) && providedMax > 0
        ? providedMax
        : storedUsage.detectedMaxTokens,
    };
    const resolved = resolveTriggerThreshold(threadConfig, effectiveUsage);
    if (!SUPPORTED_RUNTIMES.has(threadConfig.runtime || "claude")) {
      return { enabled: false, reason: "unsupported_runtime", ...resolved };
    }
    if (!resolved.config.enabled) {
      return { enabled: false, state: state.read(threadId), ...resolved };
    }
    return {
      enabled: true,
      state: state.observeUsage(threadId, effectiveUsage, resolved.thresholdTokens),
      ...resolved,
    };
  }

  async function executePendingRebuild(threadId, {
    turnSettled = false,
    logger = () => {},
  } = {}) {
    if (!turnSettled) return { executed: false, reason: "turn_not_settled" };
    const threadConfig = loadThreadConfig(threadId);
    const runtime = threadConfig.runtime || "claude";
    if (!SUPPORTED_RUNTIMES.has(runtime)) {
      return { executed: false, reason: "unsupported_runtime" };
    }
    const initialConfig = resolveAutomaticRebuildConfig(threadConfig);
    if (!initialConfig.enabled) return { executed: false, reason: "disabled" };
    const contextUsage = readContextUsage(threadId);
    const resolved = resolveTriggerThreshold(threadConfig, contextUsage);
    if (!resolved.config.ready) {
      return {
        executed: false,
        reason: "lifecycle_not_ready",
        errors: resolved.config.errors,
      };
    }
    let settledState = state.read(threadId);
    if (isDisabledPolicyState(settledState.status)) {
      settledState = state.noteConfigEnabled(threadId, true, {
        lifecycleMode: initialConfig.lifecycle.mode,
      });
      return {
        executed: false,
        reason: "policy_state_reconciled_waiting_next_settled",
      };
    }
    const settledDisableGeneration = Number(settledState.disableGeneration) || 0;
    if (settledState.resumeTurnAdmission === "available") {
      return { executed: false, reason: "resume_turn_not_admitted" };
    }

    return withThreadLock(threadId, async () => {
      const lockedThreadConfig = loadThreadConfig(threadId);
      const lockedRuntime = lockedThreadConfig.runtime || "claude";
      if (!SUPPORTED_RUNTIMES.has(lockedRuntime)) {
        return { executed: false, reason: "unsupported_runtime" };
      }
      const lockedResolved = resolveTriggerThreshold(
        lockedThreadConfig,
        readContextUsage(threadId),
      );
      if (!lockedResolved.config.enabled) {
        state.setPhase(threadId, "disabled_cancelled_before_stop", {
          disableRequestedAt: new Date().toISOString(),
          lifecycleMode: lockedResolved.config.lifecycle.mode,
          runtimeRunning: null,
          stopAttempted: false,
        });
        return { executed: false, reason: "disabled_before_stop" };
      }
      if (!lockedResolved.config.ready) {
        return {
          executed: false,
          reason: "lifecycle_not_ready",
          errors: lockedResolved.config.errors,
        };
      }
      const lockedState = state.read(threadId);
      if (!lockedState.rebuildPending) {
        return { executed: false, reason: "not_pending" };
      }
      const startedDisableGeneration = Number(lockedState.disableGeneration) || 0;
      let resumedTurnConsumed = false;
      if (startedDisableGeneration !== settledDisableGeneration) {
        return {
          executed: false,
          reason: "policy_changed_waiting_next_settled",
        };
      }
      if (lockedState.resumeTurnAdmission === "available") {
        return { executed: false, reason: "resume_turn_not_admitted" };
      }
      if (lockedState.resumeTurnAdmission === "settling") {
        return { executed: false, reason: "resume_turn_already_consumed" };
      }
      if (platform === "win32") {
        throw new Error(
          "Windows 暂不支持安全的自动 rebuild；无法保证超时后整棵 rebuild 进程树已停止",
        );
      }
      const lifecycle = lifecycleFactory(lockedResolved.config.lifecycle, {
        threadId,
        lifecycleLockHeld: true,
      });
      const record = { runtime: lockedRuntime, rebuildOutput: "", integrity: null };
      let stopAttempted = false;
      let startedHealthy = false;
      let primaryError = null;
      let recoveryError = null;
      const currentAutomaticConfig = () => resolveAutomaticRebuildConfig(
        loadThreadConfig(threadId),
      );
      const automaticEnabled = () => currentAutomaticConfig().enabled
        && (Number(state.read(threadId).disableGeneration) || 0)
          === startedDisableGeneration;
      const enabledAfterPolicyChange = () => currentAutomaticConfig().enabled;
      const finishInterruptedPhase = (disabledStatus, extra) => {
        const enabled = enabledAfterPolicyChange();
        state.setPhase(threadId, enabled ? "rebuild_pending" : disabledStatus, {
          ...extra,
          policyInterrupted: true,
        });
        return enabled;
      };

      async function settleAfterDisable(disabledAt) {
        record.disabledAt = disabledAt;
        const lifecycleMode = lockedResolved.config.lifecycle.mode;
        if (lifecycleMode === "managed") {
          const reenabled = finishInterruptedPhase("disabled_handoff_required", {
            disableRequestedAt: new Date().toISOString(),
            disabledAt,
            lifecycleMode,
            runtimeRunning: false,
            stopAttempted,
            startAttempted: false,
            healthConfirmed: false,
          });
          return {
            executed: false,
            reason: reenabled
              ? "policy_changed_waiting_next_settled"
              : "disabled_managed_handoff",
            ...record,
          };
        }
        state.setPhase(threadId, "disabled_supervisor_rollback", {
          disableRequestedAt: new Date().toISOString(),
          disabledAt,
          lifecycleMode,
          runtimeRunning: false,
          stopAttempted,
          startAttempted: false,
          healthConfirmed: false,
        });
        try {
          await lifecycle.start();
          record.recoveryStarted = true;
          const reenabled = finishInterruptedPhase("disabled_supervisor_restored", {
            disabledAt,
            lifecycleMode,
            runtimeRunning: true,
            stopAttempted,
            startAttempted: true,
            healthConfirmed: true,
          });
          return {
            executed: false,
            reason: reenabled
              ? "policy_changed_waiting_next_settled"
              : "disabled_supervisor_restored",
            ...record,
          };
        } catch (error) {
          record.recoveryStarted = false;
          record.recoveryError = sanitizeDiagnostic(error.message);
          state.setPhase(threadId, "disabled_supervisor_rollback_failed", {
            disabledAt,
            lifecycleMode,
            runtimeRunning: false,
            stopAttempted,
            startAttempted: true,
            healthConfirmed: false,
            recoveryError: sanitizeDiagnostic(error.message),
          });
          const recoveryFailure = new Error(
            `automatic rebuild disabled; runtime recovery failed: ${sanitizeDiagnostic(error.message)}`,
          );
          recoveryFailure.disabledRecoveryFailure = true;
          recoveryFailure.automaticRebuild = record;
          throw recoveryFailure;
        }
      }

      if (lockedState.resumeTurnAdmission === "admitted") {
        resumedTurnConsumed = state.consumeResumeTurn(threadId).consumed;
        if (!resumedTurnConsumed) {
          return { executed: false, reason: "resume_turn_already_consumed" };
        }
      }
      let resumedTurnCompleted = false;
      let resumedTurnExitError = null;
      try {
      try {
        if (!automaticEnabled()) {
          state.setPhase(threadId, "disabled_cancelled_before_stop", {
            lifecycleMode: lockedResolved.config.lifecycle.mode,
            runtimeRunning: null,
            stopAttempted: false,
          });
          return { executed: false, reason: "disabled_before_stop" };
        }
        state.setPhase(threadId, "stopping", { stopAttempted: false });
        logger("stopping runtime");
        if (!automaticEnabled()) {
          state.setPhase(threadId, "disabled_cancelled_before_stop", {
            lifecycleMode: lockedResolved.config.lifecycle.mode,
            runtimeRunning: null,
            stopAttempted: false,
          });
          return { executed: false, reason: "disabled_before_stop" };
        }
        state.setPhase(threadId, "stopping", { stopAttempted: true });
        if (!automaticEnabled()) {
          state.setPhase(threadId, "disabled_cancelled_before_stop", {
            lifecycleMode: lockedResolved.config.lifecycle.mode,
            runtimeRunning: null,
            stopAttempted: false,
          });
          return { executed: false, reason: "disabled_before_stop" };
        }
        stopAttempted = true;
        await lifecycle.stop();
        if (!automaticEnabled()) return await settleAfterDisable("after_stop");

        state.setPhase(threadId, "rebuilding");
        logger("running existing rebuild pipeline");
        if (!automaticEnabled()) return await settleAfterDisable("before_rebuild");
        const rebuild = await rebuildRunner.apply(threadId);
        record.rebuildOutput = rebuild.stdout || "";
        if (!automaticEnabled()) return await settleAfterDisable("after_rebuild");

        state.setPhase(threadId, "checking");
        logger("checking rebuilt thread integrity");
        if (!automaticEnabled()) return await settleAfterDisable("before_check");
        record.integrity = await rebuildRunner.check(threadId);
        if (record.integrity?.healthy !== true) {
          throw new Error(`rebuild --check 必须返回 healthy:true：${JSON.stringify(record.integrity)}`);
        }
        if (!automaticEnabled()) return await settleAfterDisable("after_check");

        state.setPhase(threadId, "starting");
        logger("starting runtime");
        if (!automaticEnabled()) return await settleAfterDisable("before_start");
        await lifecycle.start();
        startedHealthy = true;
        if (!automaticEnabled()) {
          record.disabledAt = "during_start";
          const managed = lockedResolved.config.lifecycle.mode === "managed";
          state.setPhase(threadId, managed
            ? "disabled_idle_runtime_running"
            : "disabled_supervisor_restored", {
            disabledAt: record.disabledAt,
            lifecycleMode: lockedResolved.config.lifecycle.mode,
            runtimeRunning: true,
            stopAttempted,
            startAttempted: true,
            healthConfirmed: true,
          });
          return {
            executed: false,
            reason: managed
              ? "disabled_managed_runtime_running"
              : "disabled_supervisor_restored",
            ...record,
          };
        }
      } catch (error) {
        primaryError = error;
      }

      if (primaryError?.disabledRecoveryFailure) throw primaryError;

      const policyInterruptedDuringFailure = primaryError ? !automaticEnabled() : false;
      const managedHandoff = policyInterruptedDuringFailure
        && lockedResolved.config.lifecycle.mode === "managed";
      if (primaryError && stopAttempted && !startedHealthy
        && !primaryError.unsafeToRestart && !managedHandoff) {
        const recoveryWarnings = [];
        try {
          state.setPhase(threadId, "recovering");
        } catch (error) {
          recoveryWarnings.push(`state: ${error.message}`);
        }
        try {
          logger("recovering runtime after automatic rebuild failure");
        } catch (error) {
          recoveryWarnings.push(`logger: ${error.message}`);
        }
        if (recoveryWarnings.length) record.recoveryWarnings = recoveryWarnings;
        try {
          await lifecycle.start();
          record.recoveryStarted = true;
        } catch (error) {
          recoveryError = error;
          record.recoveryStarted = false;
          record.recoveryError = sanitizeDiagnostic(error.message);
        }
      }

      if (primaryError) {
        state.markFailed(threadId, primaryError, record);
        if (policyInterruptedDuringFailure) {
          const restored = record.recoveryStarted === true;
          const lifecycleMode = lockedResolved.config.lifecycle.mode;
          const disabledStatus = lifecycleMode === "managed"
            ? "disabled_handoff_required"
            : restored
              ? "disabled_supervisor_restored"
              : "disabled_supervisor_rollback_failed";
          const status = enabledAfterPolicyChange()
            ? "rebuild_pending"
            : disabledStatus;
          state.setPhase(
            threadId,
            status,
            {
              disabledAt: "during_failure",
              lifecycleMode,
              runtimeRunning: lifecycleMode === "managed" ? null : restored,
              stopAttempted,
              startAttempted: record.recoveryStarted !== undefined,
              healthConfirmed: restored,
              recoveryError: record.recoveryError || (
                primaryError.unsafeToRestart
                  ? "进程组退出状态无法确认，拒绝冒险重启"
                  : null
              ),
            },
          );
        }
        if (recoveryError) {
          primaryError.message = sanitizeDiagnostic(
            `${primaryError.message}; runtime recovery failed: ${recoveryError.message}`,
          );
        }
        primaryError.automaticRebuild = record;
        throw primaryError;
      }

      state.markCompleted(threadId, record);
      resumedTurnCompleted = true;
      return { executed: true, ...record };
      } catch (error) {
        resumedTurnExitError = error;
        throw error;
      } finally {
        if (resumedTurnConsumed && !resumedTurnCompleted) {
          try {
            state.releaseResumeTurn(threadId);
          } catch (releaseError) {
            if (!resumedTurnExitError) throw releaseError;
            resumedTurnExitError.resumeReleaseError = releaseError;
            resumedTurnExitError.message += `; resume admission release failed: ${releaseError.message}`;
          }
        }
      }
    });
  }

  function isTurnBlocked(threadId, { admitResume = true } = {}) {
    const threadConfig = loadThreadConfig(threadId);
    if (!SUPPORTED_RUNTIMES.has(threadConfig.runtime || "claude")) return false;
    const config = resolveAutomaticRebuildConfig(threadConfig);
    if (!config.enabled || !config.ready) return false;
    let current = state.read(threadId);
    if (isDisabledPolicyState(current.status)) {
      if (!admitResume) return false;
      current = state.noteConfigEnabled(threadId, true, {
        lifecycleMode: config.lifecycle.mode,
      });
    }
    if (!current.rebuildPending) return false;
    if (current.resumeTurnAdmission === "available") {
      if (!admitResume) return false;
      return !state.admitResumeTurn(threadId).admitted;
    }
    return true;
  }

  return { executePendingRebuild, isTurnBlocked, observeThreadUsage };
}

const coordinator = createAutomaticRebuildCoordinator();

module.exports = {
  createAutomaticRebuildCoordinator,
  executePendingRebuild: coordinator.executePendingRebuild,
  isTurnBlocked: coordinator.isTurnBlocked,
  observeThreadUsage: coordinator.observeThreadUsage,
  parseIntegrityOutput,
  runRebuildProcess,
};
