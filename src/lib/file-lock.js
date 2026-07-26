const fs = require("fs");
const path = require("path");
const { processAlive, processIdentity } = require("./process-identity");

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const INCOMPLETE_OWNER_GRACE_MS = 250;

function writeOwner(ownerPath) {
  fs.writeFileSync(ownerPath, JSON.stringify({
    pid: process.pid,
    processIdentity: processIdentity(process.pid),
    createdAt: new Date().toISOString(),
  }));
}

function reapStaleLock(lockDir, staleMs) {
  try {
    const stat = fs.statSync(lockDir);
    const age = Date.now() - stat.mtimeMs;
    let owner = {};
    const ownerPath = stat.isDirectory() ? path.join(lockDir, "owner.json") : lockDir;
    try { owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); } catch {}
    const ownerPid = Number(owner.pid);
    if (processAlive(ownerPid)) {
      const currentIdentity = processIdentity(ownerPid);
      if (!owner.processIdentity || !currentIdentity
        || currentIdentity === owner.processIdentity) return false;
    } else if (!owner.pid && age <= INCOMPLETE_OWNER_GRACE_MS) {
      return false;
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function tryAcquire(lockDir, staleMs) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const candidate = `${lockDir}.candidate-${process.pid}-${Date.now()}-${Math.random()
    .toString(16).slice(2)}`;
  try {
    writeOwner(candidate);
    fs.linkSync(candidate, lockDir);
    fs.unlinkSync(candidate);
    return true;
  } catch (error) {
    fs.rmSync(candidate, { force: true });
    const lockExists = fs.existsSync(lockDir);
    if (!lockExists && error.code !== "EEXIST") throw error;
    if (!lockExists) return tryAcquire(lockDir, staleMs);
    return reapStaleLock(lockDir, staleMs) ? tryAcquire(lockDir, staleMs) : false;
  }
}

function release(lockDir) {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

function withFileLockSync(lockDir, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const started = Date.now();
  while (true) {
    if (tryAcquire(lockDir, staleMs)) break;
    if (Date.now() - started >= timeoutMs) throw new Error(`file lock timeout: ${lockDir}`);
    Atomics.wait(sleeper, 0, 0, 10);
  }
  try { return fn(); }
  finally { release(lockDir); }
}

async function withFileLock(lockDir, fn, {
  timeoutMs = 5000,
  staleMs = 30_000,
  retryMs = 10,
} = {}) {
  const started = Date.now();
  while (!tryAcquire(lockDir, staleMs)) {
    if (Date.now() - started >= timeoutMs) throw new Error(`file lock timeout: ${lockDir}`);
    await new Promise(resolve => setTimeout(resolve, retryMs));
  }
  try { return await fn(); }
  finally { release(lockDir); }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
  fs.renameSync(tmp, filePath);
}

module.exports = { processAlive, withFileLock, withFileLockSync, writeJsonAtomic };
