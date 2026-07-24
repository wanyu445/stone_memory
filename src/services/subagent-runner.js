/**
 * 统一 subagent 调用入口 — 从 stmem.json 的 runtimes 配置拼命令，不硬编码任何 CLI。
 *
 * stmem.json 配置示例:
 *   "runtimes": {
 *     "claude": {
 *       "command": "claude -p --bare",
 *       "flags": {
 *         "systemPrompt": "--system-prompt-file",
 *         "mcpConfig": "--mcp-config",
 *         "model": "--model"
 *       }
 *     },
 *     "codex": { "command": "codex exec" }
 *   }
 *
 * 用法:
 *   const { runSubagent } = require("./subagent-runner");
 *   const result = await runSubagent(prompt, { threadId, opsFile, mcpConfig, model, timeout });
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { loadConfig, getCfg, getThreadDir } = require("../config");
const { commandInvocation, appendOption } = require("../lib/command-invocation");

const BUILTIN_RUNTIMES = {
  claude: {
    command: "claude -p --bare",
    flags: {
      systemPrompt: "--system-prompt-file",
      mcpConfig: "--mcp-config",
      model: "--model",
    },
  },
  codex: {
    command: "codex exec",
    flags: {
      model: "-m",
    },
    // Codex 没有 --system-prompt-file，ops 内容由 runSubagent 内联到 prompt
  },
};

function getRuntimeConfig(runtimeName) {
  const cfg = loadConfig();
  const runtimes = cfg.runtimes || {};
  return runtimes[runtimeName] || BUILTIN_RUNTIMES[runtimeName] || null;
}

/** 为指定线程解析占位符 → 实际路径 */
function resolvePlaceholders(threadId) {
  const dir = getThreadDir(threadId);
  const memDir = path.join(dir, "memory");
  return {
    "{{retainConfig}}":    path.join(memDir, "retain-config.json"),
    "{{archiveDir}}":      path.join(memDir, "archive"),
    "{{searchLog}}":       path.join(memDir, "search-log.jsonl"),
    "{{auditReport}}":     path.join(memDir, "audit-report.md"),
    "{{auditState}}":      path.join(memDir, "audit-state.json"),
    "{{auditMarks}}":      path.join(memDir, "audit-marks.json"),
    "{{anchorReminders}}": path.join(memDir, "anchor-reminders.jsonl"),
    "{{topicsDir}}":       path.join(memDir, "topics"),
    "{{memoryDir}}":       memDir,
    "{{threadDir}}":       dir,
  };
}

function buildCommand(runtimeName, prompt, opts = {}) {
  const rt = getRuntimeConfig(runtimeName);
  if (!rt) throw new Error(`Unknown runtime: ${runtimeName}. Add it to stmem.json → runtimes.`);

  const { opsFile, mcpConfig, model } = opts;
  const flags = rt.flags || {};

  let cmd = rt.command;

  if (opsFile && flags.systemPrompt && fs.existsSync(opsFile)) {
    cmd += ` ${flags.systemPrompt} "${opsFile}"`;
  }
  if (mcpConfig && flags.mcpConfig) {
    cmd += ` ${flags.mcpConfig} "${mcpConfig}"`;
  }
  if (model && flags.model) {
    cmd += ` ${flags.model} ${model}`;
  }

  cmd += ` ${JSON.stringify(String(prompt || ""))}`;
  return cmd;
}

function buildStdinCmd(runtimeName, opts = {}) {
  const rt = getRuntimeConfig(runtimeName);
  if (!rt) throw new Error(`Unknown runtime: ${runtimeName}. Add it to stmem.json → runtimes.`);
  const flags = rt.flags || {};
  let cmd = rt.command.replace(/\s*-p/, "");
  if (opts.opsFile && flags.systemPrompt && fs.existsSync(opts.opsFile)) {
    cmd += ` ${flags.systemPrompt} "${opts.opsFile}"`;
  }
  if (opts.mcpConfig && flags.mcpConfig) {
    cmd += ` ${flags.mcpConfig} "${opts.mcpConfig}"`;
  }
  if (opts.model && flags.model) {
    cmd += ` ${flags.model} ${opts.model}`;
  }
  return cmd;
}

function buildStdinInvocation(runtimeName, opts = {}) {
  const rt = getRuntimeConfig(runtimeName);
  if (!rt) throw new Error(`Unknown runtime: ${runtimeName}. Add it to stmem.json → runtimes.`);
  const flags = rt.flags || {};
  const invocation = commandInvocation(rt.command, { remove: ["-p"] });
  if (opts.opsFile && flags.systemPrompt && fs.existsSync(opts.opsFile)) {
    appendOption(invocation.args, flags.systemPrompt, opts.opsFile);
  }
  if (opts.mcpConfig && flags.mcpConfig) {
    appendOption(invocation.args, flags.mcpConfig, opts.mcpConfig);
  }
  if (opts.model && flags.model) {
    appendOption(invocation.args, flags.model, opts.model);
  }
  return invocation;
}

/**
 * @param {string} prompt
 * @param {object} opts
 * @param {string} [opts.threadId]
 * @param {string} [opts.opsFile]         — ops 文档路径，内部自动替换 {{placeholders}}
 * @param {string} [opts.mcpConfig]
 * @param {string} [opts.model]
 * @param {number} [opts.timeout=600000]
 */
function runSubagent(prompt, opts = {}) {
  const { threadId, mcpConfig, model, timeout = 600_000 } = opts;
  let { opsFile } = opts;
  const runtimeName = getCfg("runtime", threadId, "claude");

  // 替换 ops 文件中的 {{placeholders}} → 线程实际路径
  if (opsFile && threadId && fs.existsSync(opsFile)) {
    const raw = fs.readFileSync(opsFile, "utf8");
    const subs = resolvePlaceholders(threadId);
    let content = raw;
    for (const [ph, real] of Object.entries(subs)) {
      content = content.split(ph).join(real);
    }
    const tmpDir = path.join(getThreadDir(threadId), "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, path.basename(opsFile));
    fs.writeFileSync(tmpFile, content, "utf8");
    opsFile = tmpFile;
  }

  const rt = getRuntimeConfig(runtimeName);
  const flags = rt?.flags || {};

  // 运行时没有 systemPrompt flag（如 Codex）→ ops 内容内联到 prompt
  let finalPrompt = prompt;
  if (opsFile && !flags.systemPrompt && fs.existsSync(opsFile)) {
    const opsContent = fs.readFileSync(opsFile, "utf8");
    finalPrompt = `${opsContent}\n\n---\n\n${prompt}`;
  }

  const invocation = buildStdinInvocation(runtimeName, { ...opts, opsFile, mcpConfig, model });
  const out = execFileSync(invocation.file, invocation.args, {
    input: finalPrompt,
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  if (!out || !out.trim()) {
    const err = new Error("subagent returned empty output");
    err.code = "OUTPUT_EMPTY";
    throw err;
  }
  return out.trim();
}

module.exports = { runSubagent, buildCommand, buildStdinInvocation, getRuntimeConfig, resolvePlaceholders };
