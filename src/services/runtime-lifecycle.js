const { spawn } = require("child_process");
const {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_HEALTH_INTERVAL_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
} = require("./automatic-rebuild-config");
const {
  readAutomaticRebuildState,
  setManagedRuntime,
} = require("./automatic-rebuild-state");
const { processAlive, processIdentity } = require("../lib/process-identity");
const {
  findMatchingManagedRuntimes,
  parseManagedStartCommand,
} = require("./managed-runtime-inspector");
const { withAutomaticRebuildLock } = require("./automatic-rebuild-lock");
const { terminateProcessGroup } = require("../lib/process-group");
const { sanitizeDiagnostic } = require("../lib/sanitize-diagnostic");

function terminateProcess(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function runCommand(command, {
  cwd = null,
  env = process.env,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
} = {}) {
  if (!command) return Promise.reject(new Error("runtime lifecycle command is required"));
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutTermination = null;
    const child = spawn(command, {
      cwd: cwd || process.cwd(),
      env,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutTermination = process.platform === "win32"
        ? Promise.resolve().then(() => terminateProcess(child.pid, "SIGKILL"))
        : terminateProcessGroup(child.pid);
    }, timeoutMs);
    timer.unref?.();
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", async (status, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        let terminationError = null;
        try { await timeoutTermination; } catch (error) { terminationError = error; }
        const suffix = terminationError ? `; ${terminationError.message}` : "";
        const error = new Error(
          `runtime lifecycle command timed out after ${timeoutMs}ms${suffix}`,
        );
        error.code = "LIFECYCLE_COMMAND_TIMEOUT";
        if (terminationError?.unsafeToRestart) error.unsafeToRestart = true;
        reject(error);
        return;
      }
      resolve({
        status: Number.isInteger(status) ? status : 1,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function assertCommandSucceeded(command, result) {
  if (result.status === 0) return result;
  const detail = sanitizeDiagnostic(result.stderr || result.stdout || "");
  const suffix = detail ? `: ${detail}` : "";
  throw new Error(`runtime lifecycle command failed (exit ${result.status})${suffix}`);
}

async function waitForHealth(probe, expectedHealthy, {
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  intervalMs = DEFAULT_HEALTH_INTERVAL_MS,
} = {}) {
  const started = Date.now();
  while (true) {
    const healthy = await probe();
    if (healthy === expectedHealthy) return { healthy };
    if (Date.now() - started >= timeoutMs) {
      const expectation = expectedHealthy ? "healthy" : "stopped";
      throw new Error(`runtime did not become ${expectation} within ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

async function waitForStableHealth(probe, {
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  intervalMs = DEFAULT_HEALTH_INTERVAL_MS,
  stabilityMs = Math.min(1000, timeoutMs),
} = {}) {
  const started = Date.now();
  while (Date.now() - started < stabilityMs) {
    if (!await probe()) {
      throw new Error(`runtime did not remain healthy for ${stabilityMs}ms after start`);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, stabilityMs)));
  }
  if (!await probe()) {
    throw new Error(`runtime did not remain healthy for ${stabilityMs}ms after start`);
  }
  return { healthy: true };
}

function processGroupAlive(runtime) {
  if (!runtime?.pid) return false;
  if (process.platform === "win32") return processAlive(Number(runtime.pid));
  try {
    process.kill(-Number(runtime.processGroupId || runtime.pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function managedProcessStatus(runtime) {
  if (!processGroupAlive(runtime)) return "stopped";
  if (!processAlive(Number(runtime.pid))) return "unknown";
  const currentIdentity = processIdentity(Number(runtime.pid));
  if (!runtime.processIdentity || !currentIdentity
    || currentIdentity !== runtime.processIdentity) return "unknown";
  return "owned";
}

function managedProcessAlive(runtime) {
  return managedProcessStatus(runtime) === "owned";
}

function startManagedProcess(command, options) {
  return new Promise((resolve, reject) => {
    const launchSpec = options.launchSpec
      || parseManagedStartCommand(command, { cwd: options.cwd, env: options.env });
    const child = spawn(launchSpec.command, launchSpec.args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      const identity = processIdentity(child.pid);
      if (!identity) {
        try { terminateProcess(child.pid, "SIGTERM"); } catch {}
        reject(new Error("无法记录 Stone 托管 runtime 的进程启动身份"));
        return;
      }
      child.unref();
      resolve({
        pid: child.pid,
        processGroupId: process.platform === "win32" ? null : child.pid,
        processIdentity: identity,
        startedAt: new Date().toISOString(),
        cwd: options.cwd,
      });
    });
  });
}

async function stopManagedProcess(runtime, { timeoutMs, intervalMs }) {
  const initialStatus = managedProcessStatus(runtime);
  if (initialStatus === "stopped") return;
  if (initialStatus !== "owned") {
    throw new Error("无法确认已记录 PID/process group 的归属，拒绝停止未知进程");
  }
  terminateProcess(Number(runtime.processGroupId || runtime.pid), "SIGTERM");
  const started = Date.now();
  while (processGroupAlive(runtime) && Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  if (processGroupAlive(runtime)) {
    terminateProcess(Number(runtime.processGroupId || runtime.pid), "SIGKILL");
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, intervalMs)));
  }
  if (processGroupAlive(runtime)) throw new Error("Stone 托管的 runtime 无法停止");
}

const defaultManagedProcess = {
  findMatches: findMatchingManagedRuntimes,
  isAlive: managedProcessAlive,
  status: managedProcessStatus,
  start: startManagedProcess,
  stop: stopManagedProcess,
};

const defaultState = {
  read: readAutomaticRebuildState,
  setManagedRuntime,
};

function createRuntimeLifecycleController(config, {
  threadId = null,
  commandRunner = runCommand,
  managedProcess = defaultManagedProcess,
  state = defaultState,
  env = process.env,
  withLifecycleLock = withAutomaticRebuildLock,
  lifecycleLockHeld = false,
} = {}) {
  const options = {
    cwd: config.cwd || null,
    env,
    timeoutMs: config.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
  };
  const healthOptions = {
    timeoutMs: config.healthTimeoutMs || DEFAULT_HEALTH_TIMEOUT_MS,
    intervalMs: config.healthIntervalMs || DEFAULT_HEALTH_INTERVAL_MS,
  };

  async function commandHealth() {
    const result = await commandRunner(config.healthCheckCommand, options);
    return result.status === 0;
  }

  if (config.mode === "managed") {
    if (!threadId) throw new Error("managed lifecycle requires a threadId");
    const launchSpec = parseManagedStartCommand(config.startCommand, {
      cwd: config.cwd,
      env,
    });
    if (process.platform === "win32" && managedProcess === defaultManagedProcess) {
      throw new Error("Windows 暂不支持 Stone 托管模式；请改用 supervisor 配置可靠的 stop/start/health check");
    }
    const processStatus = runtime => (
      typeof managedProcess.status === "function"
        ? managedProcess.status(runtime)
        : managedProcess.isAlive(runtime) ? "owned" : "stopped"
    );
    const canInspectMatches = typeof managedProcess.findMatches === "function";
    const findMatches = async () => (
      canInspectMatches
        ? await managedProcess.findMatches(launchSpec)
        : []
    );
    const conflictError = matches => {
      const summary = matches.map(match => (
        `PID ${Number(match.pid)} (${match.executable || "unknown executable"}, `
        + `cwd=${match.cwd || "unknown"})`
      )).join("；");
      return new Error(
        `Stone 拒绝启动：检测到已有外部 runtime（${summary}）。`
        + "Stone 不会自动杀死未知进程；请先停止原实例，或切换 supervisor",
      );
    };
    const duplicateError = matches => {
      const summary = matches.map(match => (
        `PID ${Number(match.pid)} (${match.executable || "unknown executable"}, `
        + `cwd=${match.cwd || "unknown"})`
      )).join("；");
      return new Error(
        `Stone 拒绝继续：检测到额外或重复 runtime（${summary}）。`
        + "Stone 不会自动杀死未知进程；请停止额外实例，或切换 supervisor",
      );
    };
    const managedHealthyProbe = async runtime => {
      const status = processStatus(runtime);
      if (status === "unknown") {
        throw new Error("无法确认已记录 PID/process group 的归属，拒绝把 runtime 判定为健康");
      }
      if (status !== "owned") {
        throw new Error("Stone-owned runtime 已停止，拒绝使用其他 health endpoint 冒充");
      }
      const activeMatches = await findMatches();
      if (canInspectMatches
        && !activeMatches.some(match => Number(match.pid) === Number(runtime.pid))) {
        throw new Error("已记录 runtime 与当前启动命令身份不匹配，拒绝把 runtime 判定为健康");
      }
      if (activeMatches.some(match => Number(match.pid) !== Number(runtime.pid))) {
        throw duplicateError(activeMatches);
      }
      return config.healthCheckCommand ? commandHealth() : true;
    };
    const withinLifecycleLock = operation => (
      lifecycleLockHeld ? operation() : withLifecycleLock(threadId, operation)
    );
    const controller = {
      mode: "managed",
      async stop() {
        const runtime = state.read(threadId).managedRuntime;
        if (!runtime) throw new Error("没有由 Stone 启动的 runtime，拒绝停止未知进程");
        const status = processStatus(runtime);
        if (status === "unknown") {
          throw new Error("无法确认已记录 PID/process group 的归属，拒绝停止未知进程");
        }
        const matches = await findMatches();
        if (status === "owned" && canInspectMatches
          && !matches.some(match => Number(match.pid) === Number(runtime.pid))) {
          throw new Error("已记录 runtime 与当前启动命令身份不匹配，拒绝停止未知进程");
        }
        if (matches.some(match => Number(match.pid) !== Number(runtime.pid))) {
          throw duplicateError(matches);
        }
        if (status === "owned") {
          await managedProcess.stop(runtime, {
            timeoutMs: options.timeoutMs,
            intervalMs: healthOptions.intervalMs,
          });
        }
        const probe = config.healthCheckCommand
          ? commandHealth
          : async () => managedProcess.isAlive(runtime);
        await waitForHealth(probe, false, healthOptions);
        state.setManagedRuntime(threadId, {
          ...runtime,
          stoppedAt: new Date().toISOString(),
        });
        return { stopped: true, runtime };
      },
      async start() {
        const current = state.read(threadId).managedRuntime;
        const currentStatus = current ? processStatus(current) : "stopped";
        if (currentStatus === "unknown") {
          throw new Error("无法确认已记录 PID/process group 的归属，拒绝启动重复 runtime");
        }
        const matches = await findMatches();
        if (current && currentStatus === "owned") {
          if (canInspectMatches
            && !matches.some(match => Number(match.pid) === Number(current.pid))) {
            throw new Error("已记录 runtime 与当前启动命令身份不匹配，拒绝启动重复 runtime");
          }
          if (matches.some(match => Number(match.pid) !== Number(current.pid))) {
            throw duplicateError(matches);
          }
          await waitForHealth(
            () => managedHealthyProbe(current),
            true,
            healthOptions,
          );
          return { started: false, runtime: current };
        }
        if (matches.length) throw conflictError(matches);
        const runtime = await managedProcess.start(config.startCommand, {
          ...options,
          launchSpec,
        });
        let ownershipPersisted = false;
        try {
          state.setManagedRuntime(threadId, runtime);
          ownershipPersisted = true;
          const probe = () => managedHealthyProbe(runtime);
          if (config.healthCheckCommand) await waitForHealth(probe, true, healthOptions);
          else await waitForStableHealth(probe, healthOptions);
          return { started: true, runtime };
        } catch (error) {
          let cleanupError = null;
          try {
            if (processStatus(runtime) === "owned") {
              await managedProcess.stop(runtime, {
                timeoutMs: options.timeoutMs,
                intervalMs: healthOptions.intervalMs,
              });
            }
            await waitForHealth(
              async () => managedProcess.isAlive(runtime),
              false,
              healthOptions,
            );
            if (ownershipPersisted) state.setManagedRuntime(threadId, null);
          } catch (failure) {
            cleanupError = failure;
          }
          if (cleanupError) {
            error.message = `${error.message}; newly spawned runtime cleanup failed: `
              + cleanupError.message;
          }
          throw error;
        }
      },
      async health() {
        const current = state.read(threadId).managedRuntime;
        if (!current) return { healthy: false, reason: "not_started" };
        const status = processStatus(current);
        if (status === "unknown") return { healthy: false, reason: "ownership_unknown" };
        if (status === "stopped") return { healthy: false, reason: "stopped" };
        const probe = config.healthCheckCommand
          ? commandHealth
          : async () => managedProcess.isAlive(current);
        return { healthy: await probe() };
      },
    };
    return {
      ...controller,
      stop: () => withinLifecycleLock(() => controller.stop()),
      start: () => withinLifecycleLock(() => controller.start()),
    };
  }

  return {
    mode: "supervisor",
    async stop() {
      assertCommandSucceeded(config.stopCommand, await commandRunner(config.stopCommand, options));
      await waitForHealth(commandHealth, false, healthOptions);
      return { stopped: true };
    },
    async start() {
      assertCommandSucceeded(config.startCommand, await commandRunner(config.startCommand, options));
      await waitForHealth(commandHealth, true, healthOptions);
      return { started: true };
    },
    async health() {
      return { healthy: await commandHealth() };
    },
  };
}

module.exports = {
  createRuntimeLifecycleController,
  processIdentity,
  runCommand,
  waitForHealth,
  waitForStableHealth,
};
