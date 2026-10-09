const { fs, path, os, execFileSync, buildMcpRebuildRequest, buildMcpRebuildPreviewArgs, buildMcpRebuildExecuteArgs, PROJECT_ROOT, rebuildPreviews, loadConfig } = require("./shared");
const { resolveMcpRebuildTarget } = require("../../services/mcp-rebuild-target");

function previewKey(resolved) {
  return `${resolved.threadId}\0${resolved.bindingId || ""}`;
}

function resolveRebuildCommand(args, builder) {
  const cfg = loadConfig();
  if (!cfg) throw new Error("未配置 stmem.json");
  const resolved = resolveMcpRebuildTarget(args, cfg);
  if (!resolved) throw new Error("无法确定线程 ID");
  const cli = path.join(PROJECT_ROOT, "bin", "stmem");
  if (!fs.existsSync(cli)) throw new Error("找不到 stmem CLI");
  const tc = cfg[resolved.threadId] || {};
  const useDefaults = tc.mcpRebuildDefaultsEnabled === true;
  const effectiveArgs = args.summary ? { ...args } : {
      ...args,
      summaryLimit: args.summaryLimit ?? (useDefaults ? Math.max(0, Number(tc.mcpSummaryLimit) || 0) : 0),
      minImportance: args.minImportance ?? (useDefaults ? Math.max(0, Math.min(5, Number(tc.mcpMinImportance) || 0)) : 0),
    };
  const request = buildMcpRebuildRequest(resolved, effectiveArgs);
  const rebuildArgs = builder(cli, resolved, effectiveArgs);
  return { rebuildArgs, resolved, request };
}

function temporaryRebuildPlan(request) {
  if (!request?.trim?.excludedMessages?.length && !request?.trim?.excludedTools?.length) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-rebuild-plan-"));
  const file = path.join(dir, "plan.json");
  fs.writeFileSync(file, JSON.stringify(request.trim), { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

function toolRebuildPreview(args) {
  const { rebuildArgs, resolved, request } = resolveRebuildCommand(args, buildMcpRebuildPreviewArgs);
  const plan = temporaryRebuildPlan(request);
  if (plan) rebuildArgs.push("--plan", plan.file);
  try {
    const output = execFileSync(process.execPath, rebuildArgs, {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      cwd: PROJECT_ROOT,
    });
    rebuildPreviews.set(previewKey(resolved), request);
    const nextStep = resolved.runtime === "codex"
      ? "确认结果无误后，可调用 stmem_memory_rebuild 立即 apply；完成后必须立刻完全重启 Codex/app-server。"
      : "确认结果无误后，可调用 stmem_memory_rebuild 将这组原样参数写入 Claude Code 安全队列。";
    return `${output.trim()}\n\n这是只读 dry-run。${nextStep}`;
  } catch (err) {
    throw new Error(`重建预览失败: ${String(err.stderr || err.message).trim()}`);
  } finally {
    if (plan) fs.rmSync(plan.dir, { recursive: true, force: true });
  }
}

function toolRebuild(args) {
  const cfg = loadConfig();
  if (!cfg) throw new Error("未配置 stmem.json");
  const resolved = resolveMcpRebuildTarget(args, cfg);
  if (!resolved?.threadId) throw new Error("无法确定线程 ID");
  const key = previewKey(resolved);
  const request = rebuildPreviews.get(key);
  if (!request) {
    throw new Error("当前 MCP 会话中没有该线程的已确认预览；请先调用 stmem_memory_rebuild_preview");
  }
  const plan = temporaryRebuildPlan(request);
  try {
    const cli = path.join(PROJECT_ROOT, "bin", "stmem");
    const rebuildArgs = buildMcpRebuildExecuteArgs(cli, resolved, {
      summaryLimit: request.summary.limit,
      minImportance: request.summary.minImportance,
      window: request.context.windowDays,
      toolPairs: request.context.toolPairs,
      watermark: request.context.mode === "watermark",
    });
    if (plan) rebuildArgs.splice(-1, 0, "--plan", plan.file);
    execFileSync(process.execPath, rebuildArgs, {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      cwd: PROJECT_ROOT,
    });
    rebuildPreviews.delete(key);
    return resolved.runtime === "codex"
      ? `线程 ${resolved.threadId} 已完成 rebuild apply。请不要继续发送消息，立即完全重启 Codex/app-server；重启前继续对话可能写入旧文件描述符并丢失。`
      : `已将线程 ${resolved.threadId} 的 rebuild 写入安全队列。不会在当前活动会话中改写线程；下一次 Claude Code 主 MCP 重新载入时将通过 stmem CLI 自动应用。`;
  } catch (err) {
    throw new Error(`重建执行失败: ${String(err.stderr || err.message).trim()}`);
  } finally {
    if (plan) fs.rmSync(plan.dir, { recursive: true, force: true });
  }
}


module.exports = { resolveRebuildCommand, temporaryRebuildPlan, toolRebuildPreview, toolRebuild };
