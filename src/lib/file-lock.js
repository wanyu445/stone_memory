const fs = require("fs");
const path = require("path");

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function withFileLockSync(lockDir, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const started = Date.now();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() - started >= timeoutMs) throw new Error(`file lock timeout: ${lockDir}`);
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try { return fn(); }
  finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
  fs.renameSync(tmp, filePath);
}

module.exports = { withFileLockSync, writeJsonAtomic };
