const fs = require("fs");
const path = require("path");
const { processIdentity } = require("../lib/process-identity");

const UNSAFE_SHELL_CHARACTERS = new Set(["|", "&", ";", "<", ">", "(", ")", "`", "\n", "\r"]);

function commandError() {
  return new Error(
    "managed 模式无法安全识别复杂 shell 命令；请使用直接启动命令，或切换 supervisor",
  );
}

function tokenizeDirectCommand(command) {
  const input = String(command || "").trim();
  if (!input) throw commandError();
  const tokens = [];
  let token = "";
  let tokenStarted = false;
  let quote = null;
  let escaped = false;

  function pushToken() {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  }

  for (const character of input) {
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else {
        token += character;
        tokenStarted = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      pushToken();
      continue;
    }
    if (UNSAFE_SHELL_CHARACTERS.has(character) || character === "$") {
      throw commandError();
    }
    token += character;
    tokenStarted = true;
  }
  if (escaped || quote) throw commandError();
  pushToken();
  if (!tokens.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) throw commandError();
  return tokens;
}

function realpathIfPossible(value) {
  try { return fs.realpathSync(value); }
  catch { return path.resolve(value); }
}

function resolveExecutable(command, cwd, env) {
  const candidates = command.includes("/") || command.includes("\\")
    ? [path.resolve(cwd, command)]
    : String(env.PATH || "").split(path.delimiter)
      .filter(Boolean)
      .map(directory => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return realpathIfPossible(candidate);
    } catch {}
  }
  throw new Error(
    "managed 模式无法解析直接启动命令的可执行文件；请填写可执行文件路径，或切换 supervisor",
  );
}

function parseManagedStartCommand(command, { cwd, env = process.env }) {
  const argv = tokenizeDirectCommand(command);
  const normalizedCwd = realpathIfPossible(path.resolve(cwd));
  return {
    command: resolveExecutable(argv[0], normalizedCwd, env),
    args: argv.slice(1),
    cwd: normalizedCwd,
  };
}

function linuxProcessGroup(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const processGroupId = Number(fields[2]);
  return Number.isInteger(processGroupId) && processGroupId > 0 ? processGroupId : null;
}

function sameArguments(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function findLinuxMatches(spec) {
  if (!fs.existsSync(`/proc/${process.pid}/cmdline`)) {
    throw new Error("managed 模式无法读取 /proc 进程身份；请切换 supervisor");
  }
  const matches = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const executable = fs.realpathSync(`/proc/${pid}/exe`);
      if (executable !== spec.command) continue;
      const cwd = fs.realpathSync(`/proc/${pid}/cwd`);
      if (cwd !== spec.cwd) continue;
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`)
        .toString("utf8").split("\0").filter(Boolean);
      if (!sameArguments(argv.slice(1), spec.args)) continue;
      matches.push({
        pid,
        processGroupId: linuxProcessGroup(pid),
        processIdentity: processIdentity(pid),
        executable,
        cwd,
      });
    } catch {}
  }
  return matches;
}

function findMatchingManagedRuntimes(spec, { platform = process.platform } = {}) {
  if (platform === "linux") return findLinuxMatches(spec);
  throw new Error(
    `${platform} 暂不支持可核验的 managed runtime 实例检测；请切换 supervisor`,
  );
}

module.exports = {
  findMatchingManagedRuntimes,
  parseManagedStartCommand,
  tokenizeDirectCommand,
};
