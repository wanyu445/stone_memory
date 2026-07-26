const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeJsonAtomic } = require("../lib/file-lock");

const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const DEFAULT_STATE_PATH = path.join(os.homedir(), ".stone_memory", "adapters", "claude.json");
const DEFAULT_ADAPTER_SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "stmem-claude-adapter.js");

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
    statusLineCommand: `${prefix} --status-line`,
    stopHookCommand: `${prefix} --stop`,
    gateHookCommand: `${prefix} --gate`,
  };
}

function installClaudeAdapters({
  settingsPath = DEFAULT_SETTINGS_PATH,
  statePath = DEFAULT_STATE_PATH,
  nodePath = process.execPath,
  adapterScriptPath = DEFAULT_ADAPTER_SCRIPT,
} = {}) {
  const settings = readJson(settingsPath);
  const previousState = readJson(statePath);
  const commands = adapterCommands(nodePath, adapterScriptPath);
  const knownStatusCommands = new Set([
    commands.statusLineCommand,
    previousState.statusLineCommand,
    ...(previousState.statusLineCommands || []),
  ].filter(Boolean));
  const currentStatusCommand = settings.statusLine?.command;
  const alreadyWrapped = knownStatusCommands.has(currentStatusCommand);
  if (alreadyWrapped
    && !Object.prototype.hasOwnProperty.call(previousState, "originalStatusLine")) {
    throw new Error("检测到 Stone status line wrapper，但迁移状态缺失；拒绝覆盖");
  }
  if (!alreadyWrapped
    && /stmem-claude-adapter\.js.*--status-line/.test(currentStatusCommand || "")) {
    throw new Error("检测到旧 Stone status line wrapper，但迁移状态缺失；拒绝覆盖以免递归调用");
  }
  const originalStatusLine = alreadyWrapped
    ? (previousState.originalStatusLine ?? null)
    : (settings.statusLine ? structuredClone(settings.statusLine) : null);

  settings.statusLine = {
    ...(settings.statusLine || {}),
    type: "command",
    command: commands.statusLineCommand,
  };
  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const knownStopCommands = new Set([
    commands.stopHookCommand,
    previousState.stopHookCommand,
    ...(previousState.stopHookCommands || []),
  ].filter(Boolean));
  const stopGroups = (Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [])
    .map(group => ({
      ...group,
      hooks: Array.isArray(group?.hooks)
        ? group.hooks.filter(hook => !(
          hook?.type === "command" && knownStopCommands.has(hook.command)
        ))
        : [],
    }))
    .filter(group => group.hooks.length > 0);
  stopGroups.push({
    hooks: [{
      type: "command",
      command: commands.stopHookCommand,
      timeout: 35 * 60,
      statusMessage: "Stone Memory 正在安全 rebuild 并恢复运行时…",
    }],
  });
  settings.hooks.Stop = stopGroups;
  const knownGateCommands = new Set([
    commands.gateHookCommand,
    previousState.gateHookCommand,
    ...(previousState.gateHookCommands || []),
  ].filter(Boolean));
  const gateGroups = (
    Array.isArray(settings.hooks.UserPromptSubmit)
      ? settings.hooks.UserPromptSubmit
      : []
  )
    .map(group => ({
      ...group,
      hooks: Array.isArray(group?.hooks)
        ? group.hooks.filter(hook => !(
          hook?.type === "command" && knownGateCommands.has(hook.command)
        ))
        : [],
    }))
    .filter(group => group.hooks.length > 0);
  gateGroups.push({
    hooks: [{
      type: "command",
      command: commands.gateHookCommand,
      timeout: 10,
      statusMessage: "Stone Memory 正在确认下一轮是否可以开始…",
    }],
  });
  settings.hooks.UserPromptSubmit = gateGroups;
  const nextState = {
    originalStatusLine,
    ...commands,
    statusLineCommands: [...knownStatusCommands],
    stopHookCommands: [...knownStopCommands],
    gateHookCommands: [...knownGateCommands],
    installedAt: new Date().toISOString(),
  };
  writeJsonAtomic(statePath, nextState);
  try {
    writeJsonAtomic(settingsPath, settings);
  } catch (error) {
    try {
      if (Object.keys(previousState).length) writeJsonAtomic(statePath, previousState);
      else fs.unlinkSync(statePath);
    } catch {}
    throw error;
  }
  try { fs.chmodSync(settingsPath, 0o600); } catch {}
  try { fs.chmodSync(statePath, 0o600); } catch {}
  return { settingsPath, statePath, ...commands };
}

function uninstallClaudeAdapters({
  settingsPath = DEFAULT_SETTINGS_PATH,
  statePath = DEFAULT_STATE_PATH,
  nodePath = process.execPath,
  adapterScriptPath = DEFAULT_ADAPTER_SCRIPT,
} = {}) {
  const settings = readJson(settingsPath);
  const saved = readJson(statePath);
  const commands = {
    ...adapterCommands(nodePath, adapterScriptPath),
    ...saved,
  };
  const statusLineCommands = new Set([
    commands.statusLineCommand,
    ...(saved.statusLineCommands || []),
  ].filter(Boolean));
  const stopHookCommands = new Set([
    commands.stopHookCommand,
    ...(saved.stopHookCommands || []),
  ].filter(Boolean));
  const gateHookCommands = new Set([
    commands.gateHookCommand,
    ...(saved.gateHookCommands || []),
  ].filter(Boolean));
  if (statusLineCommands.has(settings.statusLine?.command)) {
    if (saved.originalStatusLine) settings.statusLine = saved.originalStatusLine;
    else delete settings.statusLine;
  }
  if (Array.isArray(settings.hooks?.Stop)) {
    settings.hooks.Stop = settings.hooks.Stop
      .map(group => ({
        ...group,
        hooks: Array.isArray(group?.hooks)
          ? group.hooks.filter(hook => !(
            hook?.type === "command"
            && stopHookCommands.has(hook.command)
          ))
          : [],
      }))
      .filter(group => group.hooks.length > 0);
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  }
  if (Array.isArray(settings.hooks?.UserPromptSubmit)) {
    settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit
      .map(group => ({
        ...group,
        hooks: Array.isArray(group?.hooks)
          ? group.hooks.filter(hook => !(
            hook?.type === "command"
            && gateHookCommands.has(hook.command)
          ))
          : [],
      }))
      .filter(group => group.hooks.length > 0);
    if (settings.hooks.UserPromptSubmit.length === 0) {
      delete settings.hooks.UserPromptSubmit;
    }
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeJsonAtomic(settingsPath, settings);
  try { fs.unlinkSync(statePath); } catch {}
  return { settingsPath, statePath, removed: true };
}

function readClaudeAdapterState(statePath = DEFAULT_STATE_PATH) {
  return readJson(statePath);
}

module.exports = {
  DEFAULT_ADAPTER_SCRIPT,
  DEFAULT_SETTINGS_PATH,
  DEFAULT_STATE_PATH,
  installClaudeAdapters,
  readClaudeAdapterState,
  uninstallClaudeAdapters,
};
