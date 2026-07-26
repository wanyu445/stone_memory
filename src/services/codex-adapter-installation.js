const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeJsonAtomic } = require("../lib/file-lock");

const DEFAULT_HOOKS_PATH = path.join(os.homedir(), ".codex", "hooks.json");
const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  ".stone_memory",
  "adapters",
  "codex.json",
);
const DEFAULT_ADAPTER_SCRIPT = path.resolve(
  __dirname,
  "..",
  "..",
  "scripts",
  "stmem-codex-adapter.js",
);

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

function adapterCommands(nodePath, adapterScriptPath) {
  const prefix = `${JSON.stringify(nodePath)} ${JSON.stringify(adapterScriptPath)}`;
  return {
    stopHookCommand: `${prefix} --stop`,
    gateHookCommand: `${prefix} --gate`,
  };
}

function withoutCommands(groups, commands) {
  return (Array.isArray(groups) ? groups : [])
    .map(group => ({
      ...group,
      hooks: Array.isArray(group?.hooks)
        ? group.hooks.filter(hook => !(
          hook?.type === "command" && commands.has(hook.command)
        ))
        : [],
    }))
    .filter(group => group.hooks.length > 0);
}

function containsStoneAdapter(groups) {
  return (Array.isArray(groups) ? groups : []).some(group => (
    (Array.isArray(group?.hooks) ? group.hooks : []).some(hook => (
      hook?.type === "command"
      && /stmem-codex-adapter\.js.*--(?:stop|gate)/.test(hook.command || "")
    ))
  ));
}

function installCodexAdapters({
  hooksPath = DEFAULT_HOOKS_PATH,
  statePath = DEFAULT_STATE_PATH,
  nodePath = process.execPath,
  adapterScriptPath = DEFAULT_ADAPTER_SCRIPT,
} = {}) {
  const document = readJson(hooksPath);
  const previousState = readJson(statePath);
  const commands = adapterCommands(nodePath, adapterScriptPath);
  document.hooks = document.hooks && typeof document.hooks === "object"
    ? document.hooks
    : {};
  if (!Object.keys(previousState).length
    && (containsStoneAdapter(document.hooks.Stop)
      || containsStoneAdapter(document.hooks.UserPromptSubmit))) {
    throw new Error("检测到 Stone Codex hook，但迁移状态缺失；拒绝覆盖");
  }
  const stopCommands = new Set([
    commands.stopHookCommand,
    previousState.stopHookCommand,
    ...(previousState.stopHookCommands || []),
  ].filter(Boolean));
  const gateCommands = new Set([
    commands.gateHookCommand,
    previousState.gateHookCommand,
    ...(previousState.gateHookCommands || []),
  ].filter(Boolean));
  document.hooks.Stop = withoutCommands(document.hooks.Stop, stopCommands);
  document.hooks.Stop.push({
    hooks: [{
      type: "command",
      command: commands.stopHookCommand,
      timeout: 35 * 60,
      statusMessage: "Stone Memory 正在安全 rebuild 并恢复运行时…",
    }],
  });
  document.hooks.UserPromptSubmit = withoutCommands(
    document.hooks.UserPromptSubmit,
    gateCommands,
  );
  document.hooks.UserPromptSubmit.push({
    hooks: [{
      type: "command",
      command: commands.gateHookCommand,
      timeout: 10,
      statusMessage: "Stone Memory 正在确认下一轮是否可以开始…",
    }],
  });
  const nextState = {
    ...commands,
    stopHookCommands: [...stopCommands],
    gateHookCommands: [...gateCommands],
    installedAt: new Date().toISOString(),
  };
  writeJsonAtomic(statePath, nextState);
  try {
    writeJsonAtomic(hooksPath, document);
  } catch (error) {
    try {
      if (Object.keys(previousState).length) writeJsonAtomic(statePath, previousState);
      else fs.unlinkSync(statePath);
    } catch {}
    throw error;
  }
  try { fs.chmodSync(hooksPath, 0o600); } catch {}
  try { fs.chmodSync(statePath, 0o600); } catch {}
  return { hooksPath, statePath, ...commands };
}

function uninstallCodexAdapters({
  hooksPath = DEFAULT_HOOKS_PATH,
  statePath = DEFAULT_STATE_PATH,
  nodePath = process.execPath,
  adapterScriptPath = DEFAULT_ADAPTER_SCRIPT,
} = {}) {
  const document = readJson(hooksPath);
  const saved = readJson(statePath);
  const commands = { ...adapterCommands(nodePath, adapterScriptPath), ...saved };
  const stopCommands = new Set([
    commands.stopHookCommand,
    ...(saved.stopHookCommands || []),
  ].filter(Boolean));
  const gateCommands = new Set([
    commands.gateHookCommand,
    ...(saved.gateHookCommands || []),
  ].filter(Boolean));
  if (document.hooks && typeof document.hooks === "object") {
    document.hooks.Stop = withoutCommands(document.hooks.Stop, stopCommands);
    document.hooks.UserPromptSubmit = withoutCommands(
      document.hooks.UserPromptSubmit,
      gateCommands,
    );
    if (document.hooks.Stop.length === 0) delete document.hooks.Stop;
    if (document.hooks.UserPromptSubmit.length === 0) {
      delete document.hooks.UserPromptSubmit;
    }
    if (Object.keys(document.hooks).length === 0) delete document.hooks;
  }
  writeJsonAtomic(hooksPath, document);
  try { fs.unlinkSync(statePath); } catch {}
  return { hooksPath, statePath, removed: true };
}

module.exports = {
  DEFAULT_ADAPTER_SCRIPT,
  DEFAULT_HOOKS_PATH,
  DEFAULT_STATE_PATH,
  installCodexAdapters,
  uninstallCodexAdapters,
};
