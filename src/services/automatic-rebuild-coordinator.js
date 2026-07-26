const path = require("path");
const { spawn } = require("child_process");
const { loadConfig, getThreadDir } = require("../config");
const { withFileLock } = require("../lib/file-lock");
const { readRebuildState } = require("./rebuild-log");
const {
  resolveAutomaticRebuildConfig,
  resolveTriggerThreshold,
} = require("./automatic-rebuild-config");
const {
  markCompleted,
  markFailed,
  observeUsage,
  readAutomaticRebuildState,
  setPhase,
} = require("./automatic-rebuild-state");
const {
  createRuntimeLifecycleController,
} = require("./runtime-lifecycle");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const REBUILD_SCRIPT = path.join(PROJECT_ROOT, "scripts", "stmem-rebuild.js");
const SUPPORTED_RUNTIMES = new Set(["claude", "codex"]);

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

function runRebuildProcess(threadId, args, { timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;
    const child = spawn(process.execPath, [
      REBUILD_SCRIPT,
      "rebuild",
      "--thread",
      threadId,
      ...args,
    ], {
      cwd: PROJECT_ROOT,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 1000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.once("error", error => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", status => {
      clearTimeout(timer);
      if (killTimer && !timedOut) clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`rebuild command timed out after ${timeoutMs}ms`));
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
  markCompleted,
  markFailed,
  observeUsage,
  read: readAutomaticRebuildState,
  setPhase,
};

function defaultThreadLock(threadId, operation) {
  const lockDir = path.join(getThreadDir(threadId), "logs", "automatic-rebuild.lock");
  return withFileLock(lockDir, operation, {
    timeoutMs: 35 * 60_000,
    staleMs: 2 * 60 * 60_000,
  });
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
    const contextUsage = readContextUsage(threadId);
    const resolved = resolveTriggerThreshold(threadConfig, contextUsage);
    if (!resolved.config.enabled) return { executed: false, reason: "disabled" };
    if (!resolved.config.ready) {
      return {
        executed: false,
        reason: "lifecycle_not_ready",
        errors: resolved.config.errors,
      };
    }

    return withThreadLock(threadId, async () => {
      if (!state.read(threadId).rebuildPending) {
        return { executed: false, reason: "not_pending" };
      }
      if (platform === "win32") {
        throw new Error(
          "Windows 暂不支持安全的自动 rebuild；无法保证超时后整棵 rebuild 进程树已停止",
        );
      }
      const lifecycle = lifecycleFactory(resolved.config.lifecycle, { threadId });
      const record = { runtime, rebuildOutput: "", integrity: null };
      let stopAttempted = false;
      let startedHealthy = false;
      let primaryError = null;
      let recoveryError = null;

      try {
        state.setPhase(threadId, "stopping");
        logger("stopping runtime");
        stopAttempted = true;
        await lifecycle.stop();

        state.setPhase(threadId, "rebuilding");
        logger("running existing rebuild pipeline");
        const rebuild = await rebuildRunner.apply(threadId);
        record.rebuildOutput = rebuild.stdout || "";

        state.setPhase(threadId, "checking");
        logger("checking rebuilt thread integrity");
        record.integrity = await rebuildRunner.check(threadId);
        if (record.integrity?.healthy !== true) {
          throw new Error(`rebuild --check 必须返回 healthy:true：${JSON.stringify(record.integrity)}`);
        }

        state.setPhase(threadId, "starting");
        logger("starting runtime");
        await lifecycle.start();
        startedHealthy = true;
      } catch (error) {
        primaryError = error;
      }

      if (primaryError && stopAttempted && !startedHealthy) {
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
          record.recoveryError = error.message;
        }
      }

      if (primaryError) {
        state.markFailed(threadId, primaryError, record);
        if (recoveryError) {
          primaryError.message = `${primaryError.message}; runtime recovery failed: ${recoveryError.message}`;
        }
        primaryError.automaticRebuild = record;
        throw primaryError;
      }

      state.markCompleted(threadId, record);
      return { executed: true, ...record };
    });
  }

  function isTurnBlocked(threadId) {
    const threadConfig = loadThreadConfig(threadId);
    if (!SUPPORTED_RUNTIMES.has(threadConfig.runtime || "claude")) return false;
    const config = resolveAutomaticRebuildConfig(threadConfig);
    if (!config.enabled || !config.ready) return false;
    const current = state.read(threadId);
    return Boolean(current.rebuildPending);
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
