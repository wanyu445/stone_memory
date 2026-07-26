const fs = require("fs");
const { execFileSync } = require("child_process");

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] ? `linux-starttime:${fields[19]}` : null;
    }
    if (process.platform === "win32") {
      const command = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToString('o')`;
      const created = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", command,
      ], { encoding: "utf8", windowsHide: true }).trim();
      return created ? `windows-created:${created}` : null;
    }
    const started = execFileSync("ps", [
      "-o", "lstart=", "-p", String(pid),
    ], { encoding: "utf8" }).trim();
    return started ? `posix-started:${started}` : null;
  } catch {
    return null;
  }
}

module.exports = { processAlive, processIdentity };
