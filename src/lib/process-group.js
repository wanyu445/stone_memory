function processGroupAlive(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, {
  timeoutMs,
  intervalMs = 25,
} = {}) {
  const started = Date.now();
  while (processGroupAlive(processGroupId)) {
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return true;
}

async function terminateProcessGroup(processGroupId, {
  graceMs = 1000,
  confirmTimeoutMs = 5000,
  intervalMs = 25,
} = {}) {
  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(processGroupId, {
    timeoutMs: graceMs,
    intervalMs,
  })) return;
  signalProcessGroup(processGroupId, "SIGKILL");
  if (!await waitForProcessGroupExit(processGroupId, {
    timeoutMs: confirmTimeoutMs,
    intervalMs,
  })) {
    const error = new Error(`process group ${processGroupId} did not exit after SIGKILL`);
    error.code = "PROCESS_GROUP_EXIT_UNCONFIRMED";
    error.unsafeToRestart = true;
    throw error;
  }
}

module.exports = {
  processGroupAlive,
  signalProcessGroup,
  terminateProcessGroup,
  waitForProcessGroupExit,
};
