const fs = require("fs");
const { spawn } = require("child_process");

const mode = process.argv[2];
const pidFile = process.env.STMEM_TIMEOUT_PID_FILE || process.argv[3];

if (mode === "child" || process.env.STMEM_TIMEOUT_FIXTURE_CHILD === "1") {
  process.on("SIGTERM", () => {});
  setTimeout(() => process.exit(0), 5000).unref();
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [__filename, "child", pidFile], {
    env: { ...process.env, STMEM_TIMEOUT_FIXTURE_CHILD: "1" },
    stdio: "ignore",
  });
  child.once("spawn", () => {
    fs.writeFileSync(pidFile, String(child.pid));
  });
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
