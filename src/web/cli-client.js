const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, spawn } = require("child_process");
const { STMEM_BIN, PROJECT_ROOT } = require("./paths");

function safeStmemFailure(stderr, command, status) {
  const lines = String(stderr || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const marked = lines.reverse().find(line =>
    /^\[(?:memory-miner|memory-compressor)\]\s+(?:subagent\s+)?error:/i.test(line)
    || /^\[(?:tool-policy|module|import)\]\s+error:/i.test(line));
  if (marked) {
    return marked.replace(/^\[(?:memory-miner|memory-compressor)\]\s+/i, "")
      .replace(/^\[(?:tool-policy|module|import)\]\s+/i, "").slice(0, 800);
  }
  // 不把任意 stderr（可能包含私密对话或模型原文）直接回显给前端；
  // 只提取脚本明确标记的错误或常见系统错误。
  const detailLines = lines.filter(line =>
    /^\[(?:rebuild|codex-rebuild)\]/i.test(line)
    || /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError)\b/.test(line)
    || /(ENOENT|EACCES|EPERM|EADDRINUSE|无法|not found|cannot|failed)/i.test(line));
  const detail = detailLines.slice(-3).join(" | ").slice(0, 800);
  if (detail) return `stmem ${command || "命令"}失败（退出码 ${status}）：${detail}`;
  const suffix = Number.isInteger(status) ? `（退出码 ${status}）` : "";
  return `stmem ${command || "命令"}失败${suffix}`;
}

function runStmem(args, { timeout = 10 * 60 * 1000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const result = spawnSync(process.execPath, [STMEM_BIN, ...args], {
    cwd: PROJECT_ROOT, encoding: "utf8", timeout, maxBuffer,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(safeStmemFailure(result.stderr, args[0], result.status));
  return (result.stdout || "").trim();
}

function runStmemBatch(args, payload) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-batch-"));
  const file = path.join(directory, "input.json");
  fs.writeFileSync(file, JSON.stringify(payload || {}), { encoding: "utf8", mode: 0o600 });
  try { return JSON.parse(runStmem([...args, "--batch-file", file])); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function runStmemAsync(args, { maxOutput = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child=spawn(process.execPath,[STMEM_BIN,...args],{cwd:PROJECT_ROOT,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout=(stdout+chunk).slice(-maxOutput);});
    child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-Math.min(maxOutput,8000));});
    child.once("error",reject);
    child.once("close",code=>code===0?resolve(stdout.trim()):reject(new Error(safeStmemFailure(stderr,args[0],code))));
  });
}

function parseStmemJson(output) {
  try { return JSON.parse(output); }
  catch { throw new Error(`Stone Memory 返回了无法识别的结果：${String(output).slice(0, 300)}`); }
}

function writePrivateBatch(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-review-"));
  const file = path.join(dir, "batch.json");
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { safeStmemFailure, runStmem, runStmemBatch, runStmemAsync, parseStmemJson, writePrivateBatch };
