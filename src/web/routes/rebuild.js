const fs = require("fs");
const path = require("path");
const os = require("os");
const { publicThreadSettings } = require("../library-queries");
const { buildRebuildPreview } = require("../../services/rebuild-workbench");
const { json, readJson } = require("../http-io");
const { paginate } = require("../view-models");
const { parseRebuildDryRun } = require("../../services/rebuild-dry-run");
const { runStmem } = require("../cli-client");
const { normalizeRebuildRequest, rebuildRequestCliArgs } = require("../../services/rebuild-request");
const { getThreadDir } = require("../../config");
const { loadInjectableFeelings, loadRetainConfig, selectRebuildFeelings } = require("../../services/thread-rebuilder");
const { listRules } = require("../../services/rule-store");
const { NOT_HANDLED } = require("../route-result");

function configuredBinding(threadId, bindingId) {
  const id = String(bindingId || "").trim();
  return id ? require("../../services/memory-binding-config").getConfiguredBinding(threadId, id) : null;
}

function readableRebuildPreview(threadId, request, stats) {
  const binding = configuredBinding(threadId, request.bindingId);
  const isWatermark = stats.retentionMode === "watermark" && !stats.watermarkFallback;
  const cutoffOverride = isWatermark ? String(stats.watermarkCutoff || "").slice(0, 10) : stats.cutoff;
  const source = buildRebuildPreview(threadId, {
    windowDays: request.context.windowDays,
    toolPairs: request.context.toolPairs,
    binding,
    cutoffOverride,
  });
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const allFeelings = loadInjectableFeelings(memoryDir, threadId, { quiet: true });
  const retainConfig = loadRetainConfig(path.join(memoryDir, "retain-config.json"));
  const retain = retainConfig.retain || {};
  const protectedIds = new Set([...Object.keys(retain), ...Object.keys(retainConfig.eventAnchors || {})]);
  const preWindow = isWatermark && stats.watermarkFeelingId
    ? allFeelings.filter(feeling => feeling.id !== stats.watermarkFeelingId)
    : allFeelings.filter(feeling => feeling.date < (stats.cutoff || source.cutoff));
  const selection = selectRebuildFeelings(preWindow, {
    summaryLimit: request.summary.mode === "limited" ? request.summary.limit : 0,
    minImportance: request.summary.mode === "limited" ? request.summary.minImportance : 0,
    protectedIds,
  });
  const summaryRows = selection.selected.filter(feeling => !retain[feeling.id]);
  const excludedMessages = new Set(request.trim.excludedMessages);
  const excludedTools = new Set(request.trim.excludedTools);
  const exactWatermark = isWatermark ? new Date(stats.watermarkCutoff || "").getTime() : NaN;
  const messages = source.items.filter(item =>
    !excludedMessages.has(item.id) && (!Number.isFinite(exactWatermark) || new Date(item.timestamp).getTime() >= exactWatermark));
  const tools = source.tools.filter(item => !excludedTools.has(item.id));
  const rules = listRules(threadId).filter(rule => rule.injected && rule.content.trim());
  return {
    currentThreadBytes: source.currentThreadBytes,
    rangeStart: isWatermark ? stats.watermarkCutoff : stats.cutoff,
    rangeEnd: source.referenceDate,
    rules: rules.slice(0, 5).map(rule => ({ name: rule.name, excerpt: rule.content.trim().slice(0, 360) })),
    ruleCount: rules.length,
    summaries: summaryRows.slice(-5).reverse().map(feeling => ({ date: feeling.date, excerpt: feeling.content.slice(0, 420) })),
    summaryCount: summaryRows.length,
    messages: messages.slice(0, 3).map(item => ({ timestamp: item.timestamp, role: item.role, excerpt: item.context.slice(0, 260) })),
    tools: tools.slice(0, 2).map(item => ({ timestamp: item.timestamp, name: item.name, excerpt: item.context.slice(0, 220) })),
  };
}

async function handleRebuild(req, res, url) {
  const rebuildMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/rebuild\/(preview|dry-run|queue|apply|check|repair)$/);
  if (rebuildMatch) {
    const threadId = decodeURIComponent(rebuildMatch[1]), action = rebuildMatch[2];
    // The service may have access to a shared sessions root, but the web API
    // may only operate on threads explicitly registered in stmem config.
    const threadSettings = publicThreadSettings(threadId);
    if (req.method === "GET" && action === "preview") {
      const windowDays = Math.max(1, Number(url.searchParams.get("windowDays")) || 1);
      const toolValue = url.searchParams.get("toolPairs");
      const toolPairs = Math.max(0, toolValue === null ? 15 : Number(toolValue));
      const binding = configuredBinding(threadId, url.searchParams.get("binding"));
      const preview = buildRebuildPreview(threadId, { windowDays, toolPairs, binding });
      return json(res, 200, { ...preview, items: paginate(preview.items, url.searchParams.get("page")), tools: paginate(preview.tools, url.searchParams.get("toolPage")) });
    }
    if(req.method==="GET"&&action==="dry-run"){
      const windowDays=Math.max(1,Number(url.searchParams.get("windowDays"))||1),toolValue=url.searchParams.get("toolPairs"),toolPairs=Math.max(0,toolValue===null?15:Number(toolValue)),watermark=url.searchParams.get("watermark")==="true",summaryLimit=Math.max(0,Number(url.searchParams.get("summaryLimit"))||0),minImportance=Math.max(0,Math.min(5,Number(url.searchParams.get("minImportance"))||0));
      const rebuildArgs=["rebuild","--thread",threadId,"--window",String(windowDays),"--tool-pairs",String(toolPairs)];
      const bindingValue=(url.searchParams.get("binding")||"").trim();
      if(bindingValue)rebuildArgs.push("--binding",bindingValue);
      if(watermark)rebuildArgs.push("--watermark");
      rebuildArgs.push("--summary-limit",String(summaryLimit),"--min-importance",String(minImportance));
      return json(res,200,parseRebuildDryRun(runStmem(rebuildArgs)));
    }
    if(req.method==="POST"&&action==="dry-run"){
      const body=await readJson(req),request=normalizeRebuildRequest({...body,trigger:"web"},{windowDays:1,toolPairs:15,trigger:"web"});
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-rebuild-preview-")),planFile=path.join(dir,"plan.json");
      fs.writeFileSync(planFile,JSON.stringify(request.trim),{encoding:"utf8",mode:0o600});
      const rebuildArgs=["rebuild","--thread",threadId,...rebuildRequestCliArgs(request),"--plan",planFile];
      try{
        const preview=parseRebuildDryRun(runStmem(rebuildArgs));
        return json(res,200,{...preview,readable:readableRebuildPreview(threadId,request,preview)});
      }
      finally{fs.rmSync(dir,{recursive:true,force:true});}
    }
    if (req.method === "GET" && action === "check") {
      const args = ["rebuild", "--thread", threadId, "--check"];
      const bindingValue = (url.searchParams.get("binding") || "").trim();
      if (bindingValue) args.push("--binding", bindingValue);
      return json(res, 200, JSON.parse(runStmem(args)));
    }
    if (req.method === "POST" && action === "repair") {
      const body = await readJson(req);
      const args = ["rebuild", "--thread", threadId, "--repair"];
      if (body.bindingId) args.push("--binding", String(body.bindingId));
      return json(res, 200, JSON.parse(runStmem(args)));
    }
    if (req.method === "POST" && action === "queue") {
      const body = await readJson(req);
      const binding = configuredBinding(threadId, body.bindingId);
      if ((binding?.provider || threadSettings.runtime) === "codex") return json(res, 409, { error: "Codex 不支持延时重建队列，请使用 apply 并在成功后立即重启 Codex/app-server" });
      const request = normalizeRebuildRequest({ ...body, trigger: "web" }, { windowDays: 1, toolPairs: 15, trigger: "web" });
      const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-queue-plan-"));
      const planFile = path.join(planDir, "plan.json");
      fs.writeFileSync(planFile, JSON.stringify(request.trim), { encoding: "utf8", mode: 0o600 });
      const rebuildArgs = ["rebuild", "--thread", threadId, ...rebuildRequestCliArgs(request), "--plan", planFile, "--queue"];
      try {
        const queued = JSON.parse(runStmem(rebuildArgs));
        return json(res, 202, { success: true, queued: true, ...queued });
      } finally { fs.rmSync(planDir, { recursive: true, force: true }); }
    }
    if (req.method === "POST" && action === "apply") {
      const body = await readJson(req);
      const binding = configuredBinding(threadId, body.bindingId);
      if ((binding?.provider || threadSettings.runtime) !== "codex") return json(res, 409, { error: "Claude Code 必须使用重建队列，以避免 UUID 链断裂" });
      const request = normalizeRebuildRequest({ ...body, trigger: "web" }, { windowDays: 1, toolPairs: 15, trigger: "web" });
      const planFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-plan-")), "plan.json");
      fs.writeFileSync(planFile, JSON.stringify(request.trim), "utf8");
      try {
        const rebuildArgs=["rebuild", "--thread", threadId, ...rebuildRequestCliArgs(request), "--plan", planFile, "--apply"];
        const output = runStmem(rebuildArgs);
        const integrityArgs = ["rebuild", "--thread", threadId, "--check"];
        if (request.bindingId) integrityArgs.push("--binding", request.bindingId);
        const integrity = JSON.parse(runStmem(integrityArgs));
        return json(res, 200, { success: true, output, integrity });
      } finally { fs.rmSync(path.dirname(planFile), { recursive: true, force: true }); }
    }
  }
  return NOT_HANDLED;
}

module.exports = { handleRebuild };
