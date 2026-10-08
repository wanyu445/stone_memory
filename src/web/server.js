const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { URL } = require("url");
const { loadConfig, listThreadIds, listMemoryIds, getThreadDir, getMemoryContext, getMemoryRuntimeConfig } = require("../config");
const { readImportSource } = require("../services/import-source");
const { MemoryStore } = require("../storage/memory-store");
const { buildRebuildPreview } = require("../services/rebuild-workbench");
const { findThreadSessionFile } = require("../lib/thread-session-file");
const { listRules } = require("../services/rule-store");
const { latestSuccessfulRebuild, readRebuildState } = require("../services/rebuild-log");
const { sessionFile } = require("../services/rebuild-workbench");
const { parseFeelingTime, feelingToUtc, automaticRetainWindow } = require("../services/thread-rebuilder");
const { parseRebuildDryRun } = require("../services/rebuild-dry-run");
const { MiningReviewStore } = require("../services/mining-review");
const { editFusionCandidate } = require("../services/review-fusion");
const { isArchiveConversation } = require("../services/thread-ingest");
const { DreamReader } = require("../services/dream-reader");
const { NotebookService } = require("../services/notebook-service");
const { planDreamDistribution } = require("../services/dream-policy");
const { DreamPreferences } = require("../services/dream-preferences");
const { watcherActions, watcherEnabled } = require("../services/watcher-runtime");
const { normalizeMiningApiProfile } = require("../services/mining-api-profile");
const { normalizeModelName } = require("../lib/model-name");
const { configuredRuntimeIds, MiningReviewBatchStore } = require("../services/mining-review-batch");
const { normalizeRebuildRequest, rebuildRequestCliArgs } = require("../services/rebuild-request");
const { loadModules, resolveInside } = require("../services/developer-module-contract");
const { compactTermTimelineReport } = require("../services/term-timeline-report");
const { listMemories, getMemory } = require("../services/memory-setup");
const { readBindingConfig, getConfiguredBinding } = require("../services/memory-binding-config");
const { memoryExportPayload, sendMemoryExport } = require("./routes/memory");

const { scenarioId, normalizeScenarioConfig } = require("../services/scenario-registry");
const { resolveMiningPrompts } = require("../services/prompt-resolver");
const { listDeveloperAdapters } = require("./static-files");
const { WebAuthError, isLoopbackHost, isRemoteRequest, configuredAuth, isPublicWebApiRoute, createWebAuth } = require("../security/web-auth");
const { webSecurityStatus, ensureLegacyWebAuth, createWebSessionStore } = require("../services/web-security");

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_UPLOAD = 512 * 1024 * 1024;
const MAX_NOTEBOOK_ASSET_UPLOAD = 20 * 1024 * 1024;
const previews = new Map();
const miningJobs = new Map();
const compressionJobs = new Set();
const reviewJobs = new Map();
const dreamJobs = new Map();
const scratchJobs = new Map();
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const STMEM_BIN = path.join(PROJECT_ROOT, "bin", "stmem");

function redactWebSecrets(value) {
  let output = String(value || "");
  const configuredKeys = Object.values(loadConfig().apiKeys || {})
    .map(item => String(item?.key || ""))
    .filter(key => key.length >= 8);
  for (const key of configuredKeys) output = output.split(key).join("[REDACTED]");
  return output
    .replace(/\\b(stmem_[A-Za-z0-9_-]+)\\b/g, "[REDACTED]")
    .replace(/(["']?(?:authorization|api[_ -]?key)["']?\\s*[:=]\\s*["']?)(?:bearer\\s+)?[^"'\\s,;}\\]]+/gi, "$1[REDACTED]");
}

function safeStmemFailure(stderr, command, status) {
  const lines = redactWebSecrets(stderr).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const marked = lines.reverse().find(line =>
    /^\[(?:memory-miner|memory-compressor)\]\s+(?:subagent\s+)?error:/i.test(line)
    || /^\[(?:tool-policy|module|init|memory|api-profile)\]\s+error:/i.test(line)
    || /^\[binding\]\s+/i.test(line));
  if (marked) {
    return marked.replace(/^\[(?:memory-miner|memory-compressor)\]\s+/i, "")
      .replace(/^\[(?:tool-policy|module|init|memory|api-profile)\]\s+/i, "")
      .replace(/^\[binding\]\s+/i, "").slice(0, 800);
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

function startScratchJob({ threadId, payload }) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const job = { id, threadId, status: "running", createdAt, completedAt: null, result: null, error: null };
  const batch = writePrivateBatch(payload);
  scratchJobs.set(id, job);
  runStmemAsync(["scratch", "generate", "--thread", threadId, "--batch-file", batch.file], {
    maxOutput: 512 * 1024,
  })
    .then(output => {
      job.status = "completed";
      job.result = JSON.parse(output);
      job.completedAt = new Date().toISOString();
    })
    .catch(error => {
      job.status = "failed";
      job.error = String(error.message || error).slice(0, 1000);
      job.completedAt = new Date().toISOString();
    })
    .finally(batch.cleanup);
  return job;
}

function miningDatesFromStore(store,threadId) {
  return store.db.prepare(`SELECT m.source_date date,COUNT(*) messageCount,
    COALESCE(s.status,'pending') status,
    (SELECT COUNT(*) FROM feelings f WHERE f.thread_id=m.thread_id AND f.source_date=m.source_date) feelingCount,
    (SELECT COUNT(*) FROM features x WHERE x.thread_id=m.thread_id AND x.source_date=m.source_date) featureCount,
    s.updated_at updatedAt,s.error_message errorMessage,s.chunk_report chunkReport
    FROM messages m LEFT JOIN mining_day_state s ON s.thread_id=m.thread_id AND s.source_date=m.source_date
    WHERE m.thread_id=? GROUP BY m.source_date ORDER BY m.source_date DESC`).all(threadId)
    .map(row=>({...row,chunkReport:safeJsonArray(row.chunkReport)}));
}

function safeJsonArray(value) {
  try { const parsed=JSON.parse(value||"[]"); return Array.isArray(parsed)?parsed:[]; }
  catch { return []; }
}

function miningDates(threadId) {
  const store=new MemoryStore({memoryDir:path.join(getThreadDir(threadId),"memory"),threadId});
  try{return miningDatesFromStore(store,threadId);}
  finally{store.close();}
}

function miningCommandArgs(threadId, date, mode, force = false, apiProfile = "optimized") {
  const profileArgs = mode === "api" && normalizeMiningApiProfile(apiProfile) === "optimized" ? ["--api-profile", "optimized"] : [];
  return ["mine","--thread",threadId,"--date",date,mode==="api"?"--api":"--subagent",...profileArgs,...(force?["--force"]:[])];
}

function miningCheckCommandArgs(threadId, date, mode, apiProfile = "optimized") {
  const profileArgs = mode === "api" && normalizeMiningApiProfile(apiProfile) === "optimized" ? ["--api-profile", "optimized"] : [];
  return ["mine","--thread",threadId,"--date",date,"--check","--json",mode==="api"?"--api":"--subagent",...profileArgs];
}

function targetedMiningCommandArgs(threadId, mode, batchFile, apiProfile = "optimized") {
  const profileArgs = mode === "api" && normalizeMiningApiProfile(apiProfile) === "optimized" ? ["--api-profile", "optimized"] : [];
  return ["mine","--thread",threadId,"--targeted","--batch-file",batchFile,mode==="api"?"--api":"--subagent",...profileArgs];
}

const REVIEW_RULE_IDS = {
  sourceAware: "source-aware",
  relationshipPlatform: "platform-neutral",
  emotional: "personal-emotion",
  conflict: "conflict-context",
  countLimit: "count-limit",
  strictBoundaries: "strict-importance",
};

function reviewProviders(threadId) {
  const config = loadConfig();
  getMemoryContext(threadId);
  return Object.entries(config.apiKeys || {}).flatMap(([id, credential]) =>
    credential?.key && (credential?.baseUrl || id === "deepseek")
      ? [{ id, label: id, defaultModel: String(credential.model || "") }]
      : []
  );
}

function reviewProfileFromInput(threadId, input = {}) {
  const channel = String(input.channel || "");
  const model = String(input.model || "").trim();
  normalizeModelName(model, { required: true, label: "模型名" });
  if (channel === "subagent") {
    const runtime = String(input.runtime || "");
    const config = loadConfig();
    if (!configuredRuntimeIds(config, threadId).has(runtime)) throw new Error("请选择设置中已经配置的本机 CLI");
    const reasoning = input.reasoning ? String(input.reasoning) : null;
    if (reasoning && runtime !== "codex") throw new Error("只有 Codex 支持 reasoning effort");
    if (reasoning && !["minimal", "low", "medium", "high", "xhigh"].includes(reasoning)) {
      throw new Error("Codex reasoning effort 无效");
    }
    return {
      id: `subagent:${runtime}:${model}:${reasoning || "default"}`,
      label: String(input.label || `${runtime === "codex" ? "Codex" : "Claude Code"} · ${model}`),
      channel, runtime, model, reasoning,
    };
  }
  if (channel === "api") {
    const provider = String(input.provider || "");
    const config = loadConfig();
    const credential = config.apiKeys?.[provider];
    if (!credential?.key || (!credential?.baseUrl && provider !== "deepseek")) {
      throw new Error(`API Provider ${provider || "未选择"} 尚未在设置中配置完整`);
    }
    return {
      id: `api:${provider}:${model}:${normalizeMiningApiProfile(input.apiProfile)}`,
      label: String(input.label || `${provider} · ${model} · ${normalizeMiningApiProfile(input.apiProfile) === "optimized" ? "优化版" : "原始版"}`),
      channel, provider, model, apiProfile: normalizeMiningApiProfile(input.apiProfile),
    };
  }
  throw new Error("请选择 Subagent 或 API 通道");
}

function reviewBatchPayload(threadId, input = {}) {
  const dates = [...new Set((Array.isArray(input.dates) ? input.dates : []).map(String))].sort();
  if (!dates.length || dates.length > 366 || dates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    throw new Error("请选择 1～366 个有效日期");
  }
  const ruleIds = Object.entries(REVIEW_RULE_IDS)
    .filter(([key]) => input.rules?.[key] === true)
    .map(([, id]) => id);
  return {
    dates,
    profile: reviewProfileFromInput(threadId, input.profile),
    groupDays: Number(input.groupDays),
    chunkKb: input.chunkKb === "auto" ? "auto" : Number(input.chunkKb),
    parallel: Number(input.parallel),
    ruleIds,
    additionalInstruction: String(input.additionalInstruction || "").trim().slice(0, 4000),
  };
}

function reviewBatchCommandArgs(action, threadId, value) {
  const args = ["mine-review", action, "--thread", threadId];
  if (action === "batch-create") args.push("--batch-file", value);
  else if (value) args.push("--batch", value);
  return args;
}

function runReviewBatchInBackground(threadId, batchId, action = "batch-run") {
  runStmemAsync(reviewBatchCommandArgs(action, threadId, batchId), { maxOutput: 2 * 1024 * 1024 })
    .catch(() => {});
}

function reviewCandidateForWeb(candidate) {
  const ruleIds = new Set(candidate.ruleIds || []);
  const rules = Object.fromEntries(Object.entries(REVIEW_RULE_IDS).map(([key, id]) => [key, ruleIds.has(id)]));
  const hybrid = candidate.profile?.id === "hybrid";
  const fusion = candidate.profile?.id === "fusion";
  return {
    ...candidate,
    model: hybrid ? "hybrid" : fusion ? "fusion" : candidate.profile?.id || "unknown",
    modelLabel: hybrid ? "混合精选" : fusion ? candidate.profile?.label || "同事件融合" : candidate.profile?.label || candidate.profile?.model || "候选",
    preset: ruleIds.size ? "custom" : "author",
    rules,
  };
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

async function executeReviewPreview(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  const batch = writePrivateBatch({ profile: job.profile, ruleIds: job.ruleIds });
  try {
    const output = await runStmemAsync([
      "mine-review", "preview", "--thread", job.threadId, "--date", job.date,
      "--batch-file", batch.file,
    ], { maxOutput: 2 * 1024 * 1024 });
    job.candidate = reviewCandidateForWeb(parseStmemJson(output));
    job.candidateId = job.candidate.id;
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.error = String(error.message || error).slice(0, 2000);
  } finally {
    batch.cleanup();
    job.completedAt = new Date().toISOString();
  }
}

async function executeFusionPreview(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  const batch = writePrivateBatch({
    sourceCandidateId: job.sourceCandidateId,
    profile: job.profile,
  });
  try {
    const output = await runStmemAsync([
      "mine-review", "fuse", "--thread", job.threadId, "--batch-file", batch.file,
    ], { timeout: 25 * 60 * 1000, maxOutput: 2 * 1024 * 1024 });
    job.candidate = reviewCandidateForWeb(parseStmemJson(output));
    job.candidateId = job.candidate.id;
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.error = String(error.message || error).slice(0, 2000);
  } finally {
    batch.cleanup();
    job.completedAt = new Date().toISOString();
  }
}

function timelineCommandArgs(threadId, terms, { from = "", to = "" } = {}) {
  const cleaned = [...new Set((terms || []).map(term => String(term).trim()).filter(Boolean))];
  if (cleaned.length < 1 || cleaned.length > 3) throw new Error("时间轴每次请选择 1～3 个关键词");
  if (cleaned.some(term => term.length > 64)) throw new Error("时间轴关键词过长");
  const validDate = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!validDate(from) || !validDate(to)) throw new Error("时间范围格式无效");
  if (from && to && from > to) throw new Error("开始日期不能晚于结束日期");
  const args = ["term-timeline", "--thread", threadId, "--terms", cleaned.join(","), "--json", "--compact-json"];
  if (from) args.push("--from", from);
  if (to) args.push("--to", to);
  return args;
}

function compressionCommandArgs(threadId, { kind = "compact", apply = false, mode = "subagent", from = "", to = "", afterDays = 90 } = {}) {
  if (!["compact", "hidden"].includes(kind)) throw new Error("未知压缩类型");
  const args = [kind, "--thread", threadId, "--json"];
  if (kind === "compact") {
    if ((from && !to) || (!from && to)) throw new Error("精确压缩窗口需要同时提供开始和结束日期");
    if (from) args.push("--from", from, "--to", to);
    if (apply) args.push(mode === "api" ? "--api" : "--subagent", "--apply");
  } else {
    const days = Math.max(1, Math.min(3650, Number(afterDays) || 90));
    args.push("--after-days", String(days));
    if (apply) args.push("--apply");
  }
  return args;
}

function compactTimelineReport(data) {
  return compactTermTimelineReport(data);
}

async function executeMiningJob(job) {
  job.status="running";job.startedAt=new Date().toISOString();
  if(job.dates.length>1){
    const batch=writePrivateBatch({dates:job.dates,forceDates:job.forceDates,mode:job.mode,apiProfile:job.apiProfile});
    try{
      const args=["mine","--thread",job.threadId,job.mode==="api"?"--api":"--subagent","--batch-file",batch.file];
      if(job.mode==="api"&&job.apiProfile==="optimized")args.push("--api-profile","optimized");
      const output=await runStmemAsync(args,{maxOutput:2*1024*1024});
      const result=parseStmemJson(output);
      job.batchId=result.id||null;
      job.results=(result.tasks||[]).flatMap(task=>task.dates.map(date=>({date,status:["completed","completed_empty"].includes(task.status)?"completed":task.status,error:task.error||null})));
      job.completed=job.results.filter(row=>row.status==="completed").length;
      job.status=result.status==="cancelled"?"cancelled":result.status==="completed_with_failures"?"completed_with_failures":"completed";
      job.currentDate=null;job.completedAt=new Date().toISOString();job.updatedAt=job.completedAt;
      return;
    }catch(cause){
      job.status=job.cancelRequested?"cancelled":"failed";job.currentDate=null;job.error=String(cause.message||cause).slice(0,500);job.updatedAt=new Date().toISOString();
      return;
    }finally{batch.cleanup();}
  }
  for(const date of job.dates){
    if(job.cancelRequested)break;
    job.currentDate=date;job.updatedAt=new Date().toISOString();
    try{await runStmemAsync(miningCommandArgs(job.threadId,date,job.mode,job.forceDates.includes(date),job.apiProfile));job.results.push({date,status:"completed"});}
    catch(error){
      if(job.cancelRequested){job.results.push({date,status:"cancelled"});break;}
      job.results.push({date,status:"failed",error:String(error.message||error).slice(0,500)});
    }
    job.completed=job.results.length;
  }
  job.currentDate=null;
  job.status=job.cancelRequested?"cancelled":job.results.some(row=>row.status==="failed")?"completed_with_errors":"completed";
  job.completedAt=new Date().toISOString();job.updatedAt=job.completedAt;
}

function refreshMiningBatchJob(job){
  if(!job||job.dates.length<2||!["queued","running","cancelling"].includes(job.status))return job;
  try{
    const store=new MiningReviewBatchStore({memoryDir:path.join(getThreadDir(job.threadId),"memory"),threadId:job.threadId,directoryName:"mining-batches"});
    const batch=store.list().find(row=>row.autoApply&&row.createdAt>=job.createdAt&&JSON.stringify(row.dates)===JSON.stringify(job.dates));
    if(!batch)return job;
    job.batchId=batch.id;
    job.results=batch.tasks.flatMap(task=>task.dates.map(date=>({date,status:task.status,error:task.error||null})));
    job.completed=job.results.filter(row=>["completed","completed_empty"].includes(row.status)).length;
    const active=batch.tasks.find(task=>task.status==="running");
    job.currentDate=active?active.dates.join(" 至 "):null;
    job.updatedAt=batch.updatedAt;
  }catch{}
  return job;
}

function publicThreadSettings(threadId, { redactLocalPaths = false } = {}) {
  const config = loadConfig();
  let entry = config[threadId];
  let memoryId = entry?.memoryId || threadId;
  let layout = "legacy";
  let legacyThreadId = threadId;
  try {
    const context = getMemoryContext(threadId);
    memoryId = context.memoryId;
    layout = context.layout;
    legacyThreadId = context.legacyKey || threadId;
    if (context.layout === "memory-v1") entry = getMemoryRuntimeConfig(memoryId);
  } catch {}
  if (!entry) throw new Error(`记忆体不存在：${threadId}`);
  const actions = watcherActions(entry);
  return {
    memoryId, threadId: memoryId, externalThreadId: entry.externalThreadId || (layout !== "memory-v1" ? legacyThreadId : null),
    layout, upgradeRequired: layout === "legacy-runtime-v0" || layout === "legacy",
    libraryName: entry.label || memoryId, ai: entry.ai || "", user: entry.user || "",
    scenario: scenarioId(entry), userGender: entry.userGender || "unspecified", runtime: entry.runtime || "claude", purpose: entry.purpose || "accompany",
    sessionDir: redactLocalPaths ? "" : (entry.sessionDir || ""), minerMode: entry.minerMode || "subagent", apiProvider: entry.apiProvider || "",
    baseUrl: entry.apiProvider ? (config.apiKeys?.[entry.apiProvider]?.baseUrl || "") : "",
    model: entry.apiProvider ? (config.apiKeys?.[entry.apiProvider]?.model || "") : "",
    hasApiKey: !!(entry.apiProvider && config.apiKeys?.[entry.apiProvider]?.key),
    windowDays: entry.windowDays ?? 1, keepToolPairs: entry.keepToolPairs ?? 15,
    mcpRebuildDefaultsEnabled: entry.mcpRebuildDefaultsEnabled === true,
    mcpSummaryLimit: entry.mcpSummaryLimit ?? 0,
    mcpMinImportance: entry.mcpMinImportance ?? 0,
    contextWindowTokens: entry.contextWindowTokens || null,
    watcherEnabled: watcherEnabled(entry),
    automaticFullMining: actions.sync,
    automaticMemoryMaintenance: actions.mine,
    automaticCompression: actions.compact,
    automaticDream: actions.dream,
  };
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function error(res, status, message, headers = {}) { json(res, status, { error: redactWebSecrets(message) }, headers); }

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error("上传内容过大")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw.toString("utf8") || "{}"); }
  catch { throw new Error("请求 JSON 格式无效"); }
}

function safeFileName(name) {
  let decoded = String(name || "memory.jsonl");
  try { decoded = decodeURIComponent(decoded); } catch {}
  const base = path.basename(decoded).replace(/[^\w.()\-\u4e00-\u9fff]/g, "_");
  return base || "memory.jsonl";
}

function previewRows(source, page = 1) {
  // 用户在这里确认的是最终进入 archive 的纯对话，而不是线程文件的内部事件。
  // session_meta、工具状态、推理元数据等没有 message 的原始记录由现有清洗链过滤，
  // 不应伪装成“无法识别”的坏数据污染预览。
  const validRows = source.records.filter(record => !record.excludedReason && isArchiveConversation(record.message)).map((record, index) => ({
    index,
    timestamp: record.message.timestamp,
    role: record.message.type,
    context: record.message.text,
    valid: true,
  }));
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(validRows.length / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  return { page: current, pageSize, totalPages, rows: validRows.slice((current - 1) * pageSize, current * pageSize) };
}

function paginate(items, page = 1, pageSize = 20) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  return { page: current, pageSize, totalPages, total: items.length, rows: items.slice((current - 1) * pageSize, current * pageSize) };
}

function buildConversationCalendar(counts, page = 1) {
  const byDate = new Map(counts.map(row => [row.date, Number(row.count) || 0]));
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return { page: 1, totalPages: 1, month: null, leadingBlanks: 0, days: [] };
  const firstMonth = dates[0].slice(0, 7), lastMonth = dates.at(-1).slice(0, 7);
  const [firstYear, firstIndex] = firstMonth.split("-").map(Number);
  const [lastYear, lastIndex] = lastMonth.split("-").map(Number);
  const totalPages = (lastYear - firstYear) * 12 + lastIndex - firstIndex + 1;
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const monthDate = new Date(Date.UTC(lastYear, lastIndex - current, 1));
  const year = monthDate.getUTCFullYear(), monthIndex = monthDate.getUTCMonth();
  const month = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const dayCount = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const days = Array.from({ length: dayCount }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, "0")}`;
    return { date, count: byDate.get(date) || 0 };
  });
  return { page: current, totalPages, month, leadingBlanks: new Date(Date.UTC(year, monthIndex, 1)).getUTCDay(), days };
}

function listLibraries() {
  const config = loadConfig();
  const configured = listMemoryIds().flatMap(memoryId => {
    let context;
    try { context = getMemoryContext(memoryId); } catch { return []; }
    let tc, threadId, bound, bindingCount, createdAt;
    if (context.layout === "memory-v1") {
      let bindings;
      try { bindings = readBindingConfig(memoryId); } catch { return []; }
      const primary = bindings.bindings.find(item => item.id === bindings.primaryBindingId && item.enabled !== false);
      const enabledBindings = bindings.bindings.filter(item => item.enabled !== false);
      const memory = context.memoryConfig || {};
      const settingsComplete = !!(String(memory.label || "").trim() && String(memory.ai || "").trim()
        && String(memory.user || "").trim() && String(memory.purpose || "").trim());
      if (!primary && !settingsComplete) return [];
      tc = getMemoryRuntimeConfig(memoryId); threadId = memoryId;
      bound = !!primary?.externalThreadId;
      bindingCount = enabledBindings.length;
      createdAt = memory.createdAt || null;
    } else {
      tc = context.config || {}; threadId = context.legacyKey || memoryId;
      bound = !!threadId;
      bindingCount = bound ? 1 : 0;
      createdAt = tc.createdAt || null;
    }
    const actions = watcherActions(tc);
    const memoryDir = path.join(getThreadDir(threadId), "memory");
    const store = new MemoryStore({ memoryDir, threadId });
    try {
      const counts = store.db.prepare(`SELECT
        (SELECT COUNT(*) FROM messages WHERE thread_id=?) messages,
        (SELECT COUNT(*) FROM feelings WHERE thread_id=?) feelings,
        (SELECT COUNT(*) FROM features WHERE thread_id=?) features,
        (SELECT COUNT(*) FROM feelings WHERE thread_id=? AND summary_mode='coarse') coarse,
        (SELECT COUNT(*) FROM feelings WHERE thread_id=? AND summary_mode='hidden') hidden`).get(threadId, threadId, threadId, threadId, threadId);
      const latestArchived = store.db.prepare("SELECT MAX(timestamp) timestamp FROM messages WHERE thread_id=?").get(threadId);
      const latest = store.db.prepare("SELECT MAX(completed_at) completedAt FROM mining_day_state WHERE thread_id=? AND status='completed'").get(threadId);
      return {
        memoryId, layout: context.layout, upgradeRequired: context.layout === "legacy-runtime-v0", scenario: scenarioId(tc), configured: true, bound, bindingCount, threadId, externalThreadId: tc.externalThreadId || (context.layout !== "memory-v1" ? threadId : null), libraryName: tc.label || memoryId, runtime: tc.runtime || null, purpose: tc.purpose || "accompany", createdAt,
        ai: tc.ai || "", user: tc.user || "", counts,
        lastArchivedAt: latestArchived?.timestamp || null, lastMinedAt: latest?.completedAt || null,
        watcherEnabled: watcherEnabled(tc),
        automaticFullMining: actions.sync,
        automaticMemoryMaintenance: actions.mine,
        automaticCompression: actions.compact,
        automaticDream: actions.dream,
      };
    } finally { store.close(); }
  });
  const configuredMemoryIds = new Set(configured.map(item => item.memoryId));
  const drafts = listMemories(config).filter(memory => !configuredMemoryIds.has(memory.memoryId)).map(memory => ({
    memoryId: memory.memoryId, layout: "memory-v1", upgradeRequired: false, configured: false, threadId: null, libraryName: memory.label,
    runtime: null, purpose: null, ai: "", user: "", createdAt: memory.createdAt,
    counts: { messages: 0, feelings: 0, features: 0, coarse: 0, hidden: 0 },
    lastArchivedAt: null, lastMinedAt: null,
    watcherEnabled: false, automaticFullMining: false, automaticMemoryMaintenance: false,
    automaticCompression: false, automaticDream: false,
  }));
  return [...drafts, ...configured];
}

function directoryBytes(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) total += directoryBytes(file);
    else if (entry.isFile()) total += fs.statSync(file).size;
  }
  return total;
}

function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function countFeelingsMinedSince(store, threadId, sinceIso) {
  return Number(store.db.prepare("SELECT COUNT(*) count FROM feelings WHERE thread_id=? AND created_at>=?").get(threadId, sinceIso)?.count || 0);
}

// 生长天数锚点：优先记忆体创建日；旧布局没有 createdAt 时取最早对话的日期
// （messages.created_at 是入库时间，会随导入/重建批次漂移，不能代表记忆年龄）。
function memoryGrowthDays(createdAt, firstConversationDate, todayKey = localDateKey()) {
  const createdDate = Number.isFinite(Date.parse(createdAt || "")) ? localDateKey(new Date(createdAt)) : null;
  const startKey = createdDate || (/^\d{4}-\d{2}-\d{2}$/.test(String(firstConversationDate || "")) ? firstConversationDate : null);
  if (!startKey) return 0;
  return Math.max(1, Math.round((Date.parse(`${todayKey}T00:00:00+08:00`) - Date.parse(`${startKey}T00:00:00+08:00`)) / 86400000) + 1);
}

function homeOverview() {
  const libraries = listLibraries();
  const today = localDateKey();
  const todayStart = new Date(`${today}T00:00:00+08:00`).toISOString();
  const totals = {
    todayMessages: 0, todayFeelings: 0, totalFeelings: 0, pendingMiningDays: 0,
    latestMessageAt: null, latestMinedAt: null, caredDays: 0,
  };
  for (const library of libraries) {
    totals.totalFeelings += Number(library.counts?.feelings || 0);
    if (library.lastMinedAt && (!totals.latestMinedAt || library.lastMinedAt > totals.latestMinedAt)) {
      totals.latestMinedAt = library.lastMinedAt;
    }
    // 尚未绑定线程的 memory-first 草稿没有数据库；它仍计入记忆体总数，但不参与维护统计。
    if (!library.configured || !library.threadId) continue;
    const store = new MemoryStore({ memoryDir: path.join(getThreadDir(library.threadId), "memory"), threadId: library.threadId });
    try {
      const message = store.db.prepare(`SELECT
        SUM(CASE WHEN source_date=? THEN 1 ELSE 0 END) count, MAX(timestamp) latest,
        COUNT(DISTINCT source_date) caredDays
        FROM messages WHERE thread_id=?`).get(today, library.threadId);
      const feelingCount = countFeelingsMinedSince(store, library.threadId, todayStart);
      const pending = store.db.prepare(`SELECT COUNT(DISTINCT m.source_date) count FROM messages m
        LEFT JOIN mining_day_state s ON s.thread_id=m.thread_id AND s.source_date=m.source_date AND s.status IN ('completed','completed_empty')
        WHERE m.thread_id=? AND s.source_date IS NULL`).get(library.threadId);
      totals.todayMessages += Number(message?.count || 0);
      totals.todayFeelings += feelingCount;
      totals.pendingMiningDays += Number(pending?.count || 0);
      totals.caredDays = Math.max(totals.caredDays, Number(message?.caredDays || 0));
      if (message?.latest && (!totals.latestMessageAt || message.latest > totals.latestMessageAt)) totals.latestMessageAt = message.latest;
    } finally { store.close(); }
  }
  return {
    ...totals,
    memoryCount: libraries.length,
    supervisionCount: libraries.filter(item => scenarioId(item) === "life-supervision").length,
    companionCount: libraries.filter(item => scenarioId(item) === "accompany").length,
    codingCount: libraries.filter(item => scenarioId(item) === "coding").length,
    studyCount: libraries.filter(item => scenarioId(item) === "study").length,
    connectedRuntimeCount: new Set(libraries.map(item => item.runtime).filter(Boolean)).size,
    runningWatcherCount: libraries.filter(item => item.watcherEnabled).length,
    automationRunning: libraries.some(item => item.watcherEnabled),
    libraries,
  };
}

function listDeveloperModules(publicDir = PUBLIC_DIR) {
  const root = path.join(publicDir, "developer-modules");
  const legacyModules = !fs.existsSync(root) ? [] : fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name, "module.json"), "utf8"));
        const id = String(manifest.id || "").trim();
        const expectedEntry = `/developer-modules/${id}/`;
        if (!/^[a-z0-9][a-z0-9-]*$/u.test(id) || id !== entry.name || manifest.entry !== expectedEntry) return [];
        return [{
          id,
          scope: String(manifest.scope || "memory"),
          title: String(manifest.title || id),
          summary: String(manifest.summary || ""),
          contributor: String(manifest.contributor || ""),
          status: String(manifest.status || "社区实验"),
          eyebrow: String(manifest.eyebrow || "COMMUNITY MODULE"),
          actionLabel: String(manifest.actionLabel || "打开 →"),
          metaLabel: String(manifest.metaLabel || "Module"),
          features: Array.isArray(manifest.features) ? manifest.features.map(String).slice(0, 6) : [],
          order: Number.isFinite(Number(manifest.order)) ? Number(manifest.order) : 100,
          workshopSection: String(manifest.workshopSection || "plugins"),
          entry: expectedEntry,
        }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const canonicalModules = loadModules()
    .filter(item => !item.errors.length && item.manifest.entry?.frontend)
    .map(item => {
      const legacyFrontend = item.manifest.legacy?.frontend;
      const legacyRoot = legacyFrontend ? path.resolve(PROJECT_ROOT, legacyFrontend) : null;
      const legacyRelative = legacyRoot ? path.relative(publicDir, legacyRoot) : "";
      const entry = legacyRoot && !legacyRelative.startsWith("..") && !path.isAbsolute(legacyRelative)
        ? `/${legacyRelative.split(path.sep).join("/")}/`
        : `/developer-modules/${item.id}/`;
      let legacyManifest = {};
      if (legacyRoot) {
        try { legacyManifest = JSON.parse(fs.readFileSync(path.join(legacyRoot, "module.json"), "utf8")); } catch {}
      }
      const readmeCandidates = [path.join(item.moduleDir, "README.md")];
      if (legacyRoot) readmeCandidates.push(path.join(legacyRoot, "README.md"));
      const readmeFile = readmeCandidates.find(file => fs.existsSync(file));
      const readme = readmeFile ? fs.readFileSync(readmeFile, "utf8") : "";
      const readmeContributor = readme.match(/^贡献人[：:]\s*(.+)$/mu)?.[1]?.replace(/[`*_]/gu, "").trim() || "";
      const readmeSummary = readme.split(/\r?\n\r?\n/u)
        .map(block => block.replace(/^#+\s+.*$/gmu, "").replace(/\r?\n/gu, " ").trim())
        .find(block => block && !/^(?:贡献人|```|[-*]\s)/u.test(block) && (block.match(/[\u3400-\u9fff]/gu) || []).length >= 8)
        ?.replace(/[`*_#]/gu, "") || "";
      return {
      id: item.id,
      scope: String(item.manifest.scope || "memory"),
      title: String(item.manifest.title || legacyManifest.title || legacyManifest.name || item.id),
      summary: String(item.manifest.summary || legacyManifest.summary || legacyManifest.description || readmeSummary || `${item.manifest.title || item.id} 的功能、能力与使用说明请查看 README。`),
      contributor: String(item.manifest.contributor || legacyManifest.contributor || readmeContributor || "未署名"),
      status: String(item.manifest.status || legacyManifest.status || "开发者模块"),
      eyebrow: String(item.manifest.eyebrow || legacyManifest.eyebrow || "STONE MEMORY MODULE"),
      actionLabel: String(item.manifest.actionLabel || legacyManifest.actionLabel || "进入 →"),
      metaLabel: String(item.manifest.metaLabel || legacyManifest.metaLabel || `Module · v${item.manifest.version}`),
      features: Array.isArray(item.manifest.features) ? item.manifest.features.map(String).slice(0, 6) : Array.isArray(legacyManifest.features) ? legacyManifest.features.map(String).slice(0, 6) : [],
      order: Number.isFinite(Number(item.manifest.order)) ? Number(item.manifest.order) : Number.isFinite(Number(legacyManifest.order)) ? Number(legacyManifest.order) : 100,
      workshopSection: String(item.manifest.workshopSection || "plugins"),
      entry,
    };
    });
  const canonicalEntries = new Set(canonicalModules.map(item => item.entry));
  const byId = new Map(legacyModules.filter(item => !canonicalEntries.has(item.entry)).map(item => [item.id, item]));
  for (const item of canonicalModules) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function developerModuleDetail(id) {
  const loaded = loadModules().find(item => item.id === id && !item.errors.length);
  if (!loaded) return null;
  const manifest = loaded.manifest;
  const readmeCandidates = [path.join(loaded.moduleDir, "README.md")];
  if (manifest.legacy?.frontend) readmeCandidates.push(path.join(path.resolve(PROJECT_ROOT, manifest.legacy.frontend), "README.md"));
  const readmeFile = readmeCandidates.find(file => fs.existsSync(file));
  return {
    module: listDeveloperModules().find(item => item.id === id) || null,
    version: String(manifest.version || ""),
    scope: String(manifest.scope || "memory"),
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [],
    commands: Object.keys(manifest.entry?.commands || {}),
    storage: manifest.storage && typeof manifest.storage === "object" ? manifest.storage : {},
    watcher: manifest.watcher && typeof manifest.watcher === "object" ? manifest.watcher : null,
    readme: readmeFile ? fs.readFileSync(readmeFile, "utf8") : "这个模块暂未提供 README。",
  };
}

function serveCanonicalDeveloperModule(req, res, pathname) {
  const match = pathname.match(/^\/developer-modules\/([a-z0-9][a-z0-9-]*)(?:\/(.*))?$/u);
  if (!match) return false;
  const loaded = loadModules().find(item => item.id === match[1] && !item.errors.length);
  if (!loaded?.manifest.entry?.frontend || loaded.manifest.legacy?.frontend) return false;
  const frontendEntry = resolveInside(loaded.moduleDir, loaded.manifest.entry.frontend, "frontend entry");
  const frontendRoot = path.dirname(frontendEntry);
  const requested = match[2] || path.basename(frontendEntry);
  const file = path.resolve(frontendRoot, requested);
  const relative = path.relative(frontendRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
  const stat = fs.statSync(file);
  res.writeHead(200, {
    "content-type": types[path.extname(file)] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-cache",
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveLegacyDreamLab(res, url) {
  const { pathname } = url;
  if (!/^\/dream-lab(?:\/|$)/u.test(pathname)) return false;
  const suffix = pathname.slice("/dream-lab".length).replace(/^\//u, "");
  const location = `/developer-modules/dream-lab/${suffix}`.replace(/\/$/u, "/") + url.search;
  res.writeHead(302, { location });
  res.end();
  return true;
}

function overview(identifier) {
  const library = listLibraries().find(item => item.threadId === identifier || item.memoryId === identifier);
  if (!library) return null;
  if (!library.configured) return library;
  const threadId = library.threadId;
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
  try {
    const recent = store.db.prepare(`SELECT id,source_date sourceDate,event_time eventTime,content,importance,summary_mode summaryMode
      FROM feelings WHERE thread_id=? ORDER BY source_date DESC,COALESCE(event_time,'') DESC,order_key DESC LIMIT 5`).all(threadId);
    const daily = store.db.prepare("SELECT COUNT(*) count FROM feelings WHERE thread_id=? AND summary_mode='daily'").get(threadId).count;
    const failed = store.db.prepare("SELECT COUNT(*) count FROM mining_day_state WHERE thread_id=? AND status='failed'").get(threadId).count;
    const rebuildState=readRebuildState(threadId), rebuild=latestSuccessfulRebuild(threadId); let file=null;
    try { if (library.runtime) file=sessionFile(threadId,library.runtime); } catch {}
    const configuredMax=Number(getMemoryRuntimeConfig(threadId)?.contextWindowTokens);
    const withUsageLimit=rawUsage=>{
      const usage=rawUsage?{...rawUsage,maxTokens:configuredMax>0?configuredMax:rawUsage.detectedMaxTokens||null}:null;
      if(usage?.maxTokens)usage.percent=usage.usedTokens/usage.maxTokens*100;
      return usage;
    };
    const contextUsage=withUsageLimit(rebuildState.contextUsage||null);
    const contextUsageByBinding=Object.fromEntries(Object.entries(rebuildState.contextUsageByBinding||{}).map(([id,usage])=>[id,withUsageLimit(usage)]));
    const pendingMiningDays=store.db.prepare(`SELECT COUNT(DISTINCT m.source_date) count FROM messages m LEFT JOIN mining_day_state s ON s.thread_id=m.thread_id AND s.source_date=m.source_date AND s.status IN ('completed','completed_empty') WHERE m.thread_id=? AND s.source_date IS NULL`).get(threadId).count;
    const rules=listRules(threadId),enabledRules=rules.filter(rule=>rule.injected).length;
    let anchors={retain:{},eventAnchors:{}};
    try { anchors={...anchors,...JSON.parse(fs.readFileSync(path.join(getThreadDir(threadId),"memory","retain-config.json"),"utf8"))}; } catch {}
    const createdAt=library.createdAt||store.db.prepare("SELECT MIN(created_at) createdAt FROM messages WHERE thread_id=?").get(threadId)?.createdAt||null;
    const firstConversationDate=store.db.prepare("SELECT MIN(source_date) d FROM messages WHERE thread_id=? AND source_date IS NOT NULL").get(threadId)?.d||null;
    const growthDays=memoryGrowthDays(library.createdAt,firstConversationDate);
    return {
      ...library,
      createdAt,
      growthDays,
      counts: {
        ...library.counts,
        daily,
        rules: rules.length,
        disabledRules: rules.length-enabledRules,
        retainAnchors: Object.keys(anchors.retain||{}).length,
        eventAnchors: Object.keys(anchors.eventAnchors||{}).length,
      },
      archiveFullBytes: directoryBytes(path.join(getThreadDir(threadId),"memory","archive","full")),
      recent, rebuild, rebuildByBinding:rebuildState.lastCompletedByBinding||{}, contextUsage, contextUsageByBinding, threadFileFound:!!file, pendingMiningDays,
      attention: failed ? `${failed} 个日期挖掘失败` : null,
    };
  } finally { store.close(); }
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.endsWith("/") ? `${pathname.slice(1)}index.html` : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, requested);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return false;
  const stat = fs.statSync(file);
  if (stat.isDirectory()) return false;
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
  const extension = path.extname(file);
  const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && new Set([".html", ".css", ".js", ".json", ".svg"]).has(extension);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${gzip ? "-gz" : ""}"`;
  const headers = {
    "content-type": types[extension] || "application/octet-stream",
    "cache-control": "no-cache",
    etag,
    "last-modified": stat.mtime.toUTCString(),
    vary: "Accept-Encoding",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  if (gzip) {
    headers["content-encoding"] = "gzip";
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED })).pipe(res);
  } else {
    headers["content-length"] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  }
  return true;
}

async function handleDreamSettings(req, url, threadId, resource) {
  if (resource === "preferences") {
    return JSON.parse(runStmem(["dream", "preferences", "--thread", threadId]));
  }
  if (resource === "pin") {
    if (req.method === "PUT") {
      const body = await readJson(req);
      return JSON.parse(runStmem(["dream", "pin", "--thread", threadId, "--type", String(body.dreamType || "").trim()]));
    }
    if (req.method === "DELETE") {
      return JSON.parse(runStmem(["dream", "unpin", "--thread", threadId]));
    }
  }
  if (resource === "guard" && req.method === "PUT") {
    const body = await readJson(req);
    const args = ["dream", "guard", "--thread", threadId];
    for (const type of (body.excludedTypes || [])) args.push("--exclude", String(type));
    return JSON.parse(runStmem(args));
  }
  if (resource === "multiplier" && req.method === "PUT") {
    const body = await readJson(req);
    const args = ["dream", "multiplier", "--thread", threadId];
    for (const [type, value] of Object.entries(body.multipliers || {})) args.push(`--${type}`, String(value));
    return JSON.parse(runStmem(args));
  }
  if (resource === "nsfw" && req.method === "PUT") {
    const body = await readJson(req);
    return JSON.parse(runStmem(["dream", "nsfw", "--thread", threadId, body.enabled === true ? "on" : "off"]));
  }
  if (resource === "prompt") {
    if (req.method === "GET") {
      return JSON.parse(runStmem(["dream", "prompt", "--thread", threadId, "--type", String(url.searchParams.get("type") || "")]));
    }
    if (req.method === "DELETE") {
      return JSON.parse(runStmem(["dream", "prompt", "--thread", threadId, "--type", String(url.searchParams.get("type") || ""), "--reset"]));
    }
    if (req.method === "PUT") {
      const body = await readJson(req);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-prompt-"));
      try {
        const file = path.join(dir, "override.md");
        fs.writeFileSync(file, String(body.content ?? ""), "utf8");
        return JSON.parse(runStmem(["dream", "prompt", "--thread", threadId, "--type", String(body.type || "").trim(), "--set", file]));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  throw new Error("不支持的织梦设置请求");
}

function serveNotebookAsset(req, res, asset) {
  if (!asset) return false;
  const etag = `W/"${asset.size.toString(16)}-${Math.floor(asset.modifiedAt.getTime()).toString(16)}"`;
  const headers = {
    "content-type": asset.contentType,
    "content-length": asset.size,
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
    etag,
  };
  if (req.headers["if-none-match"] === etag) {
    delete headers["content-length"];
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, headers);
  fs.createReadStream(asset.absolutePath).pipe(res);
  return true;
}

async function handleApi(req, res, url, { isRemote = false } = {}) {
  if (req.method === "GET" && url.pathname === "/api/web-security") return json(res, 200, webSecurityStatus());
  if (req.method === "GET" && url.pathname === "/api/web-access") return json(res, 200, webAccessOverview());
  if (req.method === "POST" && url.pathname === "/api/web-security/token") {
    return json(res, 200, JSON.parse(runStmem(["web", "auth", "rotate", "--json"])));
  }
  const memoryExportMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/export$/u);
  if (req.method === "GET" && memoryExportMatch) {
    const requestedId = decodeURIComponent(memoryExportMatch[1]);
    const settings = publicThreadSettings(requestedId);
    const store = new MemoryStore({ memoryDir:path.join(getThreadDir(settings.threadId), "memory"), threadId:settings.threadId });
    try { return sendMemoryExport(res, memoryExportPayload(store, settings)); }
    finally { store.close(); }
  }
  const bindingMcpMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/mcp$/u);
  if (bindingMcpMatch && req.method === "GET") {
    const memoryId = decodeURIComponent(bindingMcpMatch[1]);
    publicThreadSettings(memoryId);
    return json(res, 200, JSON.parse(runStmem(["module", "mcp", "status", "--memory", memoryId, "--json"])));
  }
  if (bindingMcpMatch && req.method === "POST") {
    const memoryId = decodeURIComponent(bindingMcpMatch[1]);
    const body = await readJson(req);
    if (typeof body.enabled !== "boolean" || !/^[a-z0-9][a-z0-9-]*$/u.test(String(body.moduleId || ""))) throw new Error("需要合法的 moduleId 和 enabled");
    publicThreadSettings(memoryId);
    const args = ["module", "mcp", body.enabled ? "enable" : "disable", "--module", body.moduleId, "--memory", memoryId, "--json"];
    if (body.apply === true) args.push("--apply");
    return json(res, 200, JSON.parse(runStmem(args)));
  }
  if (url.pathname === "/api/developer-modules/mcp" || /^\/api\/developer-modules\/[a-z0-9][a-z0-9-]*\/mcp$/u.test(url.pathname)) {
    return json(res, 410, { error: "模块 MCP 权限已迁移到记忆体接入线程，请使用 Binding MCP 接口" });
  }
  if (req.method === "GET" && url.pathname === "/api/developer-modules") {
    return json(res, 200, { modules: listDeveloperModules() });
  }
  if (req.method === "GET" && url.pathname === "/api/developer-adapters") {
    return json(res, 200, { adapters: listDeveloperAdapters() });
  }
  const moduleDetailMatch = url.pathname.match(/^\/api\/developer-modules\/([a-z0-9][a-z0-9-]*)$/u);
  if (req.method === "GET" && moduleDetailMatch) {
    const detail = developerModuleDetail(moduleDetailMatch[1]);
    return detail ? json(res, 200, detail) : error(res, 404, "开发者模块不存在");
  }

  const bindingsMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/bindings$/);
  if (bindingsMatch) {
    const threadId = decodeURIComponent(bindingsMatch[1]);
    const settings = publicThreadSettings(threadId);
    if (req.method === "GET") {
      let status;
      try {
        status = JSON.parse(runStmem(["binding", "list", "--memory", threadId]));
        if (!status.bindings?.length) {
          const migrated = JSON.parse(runStmem(["binding", "migrate-legacy", "--memory", threadId, "--apply"]));
          if (migrated.changed !== false) status = JSON.parse(runStmem(["binding", "list", "--memory", threadId]));
        }
      } catch {
        try { status = JSON.parse(runStmem(["binding", "list", "--thread", threadId])); }
        catch { status = { memoryId: settings.memoryId, primaryBindingId: null, bindings: [] }; }
      }
      const bindings = Array.isArray(status.bindings) ? status.bindings : [];
      if (settings.externalThreadId && !bindings.some(binding => binding.externalThreadId === settings.externalThreadId)) {
        const legacyId = `legacy-config:${settings.externalThreadId}`;
        bindings.unshift({
          id: legacyId,
          provider: settings.runtime,
          externalThreadId: settings.externalThreadId,
          enabled: true,
          mode: "primary",
          source: "legacy-config",
          readOnly: true,
        });
        if (!status.primaryBindingId) status.primaryBindingId = legacyId;
      }
      return json(res, 200, { ...status, memoryId: status.memoryId || settings.memoryId, bindings });
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      if (isRemote && (body.threadFile || body.sessionRoot || body.sessionDir || body.source)) {
        throw new Error("远程 Web 不能为 Binding 指定服务器本地来源路径；请在本机 CLI / loopback Web 中注册");
      }
      const args = ["binding", "add", "--thread", threadId, "--provider", String(body.provider || "")];
      if (body.externalThreadId) args.push("--external-thread", String(body.externalThreadId));
      if (body.threadFile) args.push("--thread-file", String(body.threadFile));
      if (body.mode) args.push("--mode", String(body.mode));
      if (body.apply === true) args.push("--apply");
      return json(res, 200, JSON.parse(runStmem(args)));
    }
  }

  const bindingMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/bindings\/([^/]+)$/);
  if (bindingMatch && req.method === "PATCH") {
    const threadId = decodeURIComponent(bindingMatch[1]);
    const bindingId = decodeURIComponent(bindingMatch[2]);
    publicThreadSettings(threadId);
    const body = await readJson(req);
    const action = body.action || (body.enabled === false ? "disable" : "enable");
    if (!["enable", "disable", "primary"].includes(action)) throw new Error("不支持的 Binding 操作");
    const args = ["binding", action, "--memory", threadId, "--binding", bindingId];
    if (body.apply === true) args.push("--apply");
    return json(res, 200, JSON.parse(runStmem(args)));
  }
  if (bindingMatch && req.method === "DELETE") {
    const threadId = decodeURIComponent(bindingMatch[1]);
    const bindingId = decodeURIComponent(bindingMatch[2]);
    publicThreadSettings(threadId);
    return json(res, 200, JSON.parse(runStmem(["binding", "remove", "--memory", threadId, "--binding", bindingId, "--apply"])));
  }

  const bindingImportMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/bindings\/([^/]+)\/import$/);
  if (bindingImportMatch && req.method === "POST") {
    const threadId = decodeURIComponent(bindingImportMatch[1]);
    const bindingId = decodeURIComponent(bindingImportMatch[2]);
    publicThreadSettings(threadId);
    const body = await readJson(req);
    if (isRemote && body.source) throw new Error("远程 Web 不能临时指定服务器本地 Binding 来源；请使用已注册的 Binding");
    const args = ["binding", "import", "--thread", threadId, "--binding", bindingId];
    if (body.source) args.push("--source", String(body.source));
    if (body.apply === true) args.push("--apply");
    return json(res, 200, JSON.parse(runStmem(args)));
  }

  const moduleCommandMatch = url.pathname.match(/^\/api\/developer-modules\/([^/]+)\/commands\/([^/]+)$/);
  if (moduleCommandMatch && (req.method === "GET" || req.method === "POST")) {
    const moduleId = decodeURIComponent(moduleCommandMatch[1]);
    const action = decodeURIComponent(moduleCommandMatch[2]);
    const loaded = loadModules().find(item => item.id === moduleId && !item.errors.length);
    if (!loaded) throw new Error("开发者模块不存在或 manifest 无效");
    if (!loaded.manifest.entry?.commands?.[action]) throw new Error("开发者模块命令未登记");
    const threadId = String(url.searchParams.get("memoryId") || url.searchParams.get("memory") || url.searchParams.get("thread") || "");
    const bindingId = String(url.searchParams.get("binding") || "");
    if (loaded.manifest.scope === "memory" && !threadId) throw new Error("缺少当前记忆体");
    if (threadId) publicThreadSettings(threadId);
    const args = ["module", moduleId, action];
    if (threadId) args.push("--memory", threadId);
    if (bindingId) args.push("--binding", bindingId);
    let output;
    if (req.method === "POST") {
      const body = await readJson(req);
      if (body.apply === true) args.push("--apply");
      output = runStmemBatch(args, body);
    } else {
      output = JSON.parse(runStmem(args));
    }
    return json(res, 200, output);
  }

  const bindingBatchesMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/binding-imports$/);
  if (bindingBatchesMatch && req.method === "GET") {
    const threadId = decodeURIComponent(bindingBatchesMatch[1]);
    publicThreadSettings(threadId);
    const args = ["binding", "batches", "--thread", threadId];
    if (url.searchParams.get("binding")) args.push("--binding", url.searchParams.get("binding"));
    return json(res, 200, JSON.parse(runStmem(args)));
  }

  const bindingRevertMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/binding-imports\/([^/]+)\/revert$/);
  if (bindingRevertMatch && req.method === "POST") {
    const threadId = decodeURIComponent(bindingRevertMatch[1]);
    const batchId = decodeURIComponent(bindingRevertMatch[2]);
    publicThreadSettings(threadId);
    const body = await readJson(req);
    const args = ["binding", "revert", "--thread", threadId, "--batch", batchId];
    if (body.apply === true) args.push("--apply");
    return json(res, 200, JSON.parse(runStmem(args)));
  }

  const scratchJobMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/scratch\/jobs\/([^/]+)$/);
  if (req.method === "GET" && scratchJobMatch) {
    const threadId = decodeURIComponent(scratchJobMatch[1]);
    publicThreadSettings(threadId);
    const job = scratchJobs.get(decodeURIComponent(scratchJobMatch[2]));
    if (!job || job.threadId !== threadId) return error(res, 404, "刮刮乐任务不存在或已经过期");
    return json(res, 200, { job });
  }

  const scratchMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/scratch(?:\/(settings|generate))?$/);
  if (scratchMatch) {
    const threadId = decodeURIComponent(scratchMatch[1]);
    const action = scratchMatch[2] || "inspect";
    publicThreadSettings(threadId);
    if (req.method === "GET" && action === "inspect") {
      return json(res, 200, JSON.parse(runStmem(["scratch", "inspect", "--thread", threadId])));
    }
    if (req.method === "PATCH" && action === "settings") {
      const batch = writePrivateBatch(await readJson(req));
      try {
        return json(res, 200, JSON.parse(runStmem(["scratch", "settings", "--thread", threadId, "--batch-file", batch.file])));
      } finally {
        batch.cleanup();
      }
    }
    if (req.method === "POST" && action === "generate") {
      const job = startScratchJob({ threadId, payload: await readJson(req) });
      return json(res, 202, { job: { id: job.id, status: job.status } });
    }
  }

  if (req.method === "GET" && url.pathname === "/review-lab/api/libraries") {
    const threadId = String(url.searchParams.get("threadId") || "");
    if (!threadId) throw new Error("缺少当前记忆体标识，请从开发者模式进入记忆审阅实验室");
    const library = listLibraries().find(item => item.threadId === threadId);
    if (!library) throw new Error(`记忆体不存在：${threadId}`);
    const libraries = [{
      ...library,
      label: library.libraryName,
      publicThreadId: `${library.threadId.slice(0, 8)}…${library.threadId.slice(-8)}`,
    }];
    return json(res, 200, { libraries, providers: reviewProviders(threadId) });
  }
  if (req.method === "GET" && url.pathname === "/review-lab/api/dates") {
    const threadId = String(url.searchParams.get("threadId") || "");
    return json(res, 200, { dates: miningDates(threadId) });
  }
  if (req.method === "GET" && url.pathname === "/review-lab/api/candidates") {
    const threadId = String(url.searchParams.get("threadId") || "");
    const args = ["mine-review", "list", "--thread", threadId];
    if (url.searchParams.get("date")) args.push("--date", url.searchParams.get("date"));
    const result = parseStmemJson(runStmem(args));
    return json(res, 200, {
      candidates: (result.candidates || []).map(reviewCandidateForWeb),
      nearDuplicateHints: result.nearDuplicateHints || [],
    });
  }
  if (req.method === "POST" && url.pathname === "/review-lab/api/preview") {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    const profile = reviewProfileFromInput(threadId, body.profile);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ""))) throw new Error("候选日期无效");
    const ruleIds = Object.entries(REVIEW_RULE_IDS)
      .filter(([key]) => body.rules?.[key])
      .map(([, id]) => id);
    const job = {
      id: `review-${crypto.randomUUID()}`,
      threadId,
      date: body.date,
      profile,
      ruleIds,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    reviewJobs.set(job.id, job);
    executeReviewPreview(job);
    return json(res, 202, { job: { id: job.id, status: job.status } });
  }
  if (req.method === "GET" && url.pathname === "/review-lab/api/batches") {
    const threadId = String(url.searchParams.get("threadId") || "");
    const result = parseStmemJson(runStmem(reviewBatchCommandArgs("batch-list", threadId)));
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/review-lab/api/batches") {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    const batch = writePrivateBatch(reviewBatchPayload(threadId, body));
    try {
      const created = parseStmemJson(runStmem(reviewBatchCommandArgs("batch-create", threadId, batch.file)));
      runReviewBatchInBackground(threadId, created.id);
      return json(res, 202, { batch: created });
    } finally {
      batch.cleanup();
    }
  }
  const reviewBatchMatch = url.pathname.match(/^\/review-lab\/api\/batches\/(batch-[0-9a-f-]+)$/);
  if (req.method === "GET" && reviewBatchMatch) {
    const threadId = String(url.searchParams.get("threadId") || "");
    const batch = parseStmemJson(runStmem(reviewBatchCommandArgs(
      "batch-status",
      threadId,
      reviewBatchMatch[1],
    )));
    return json(res, 200, { batch });
  }
  const reviewBatchRetryMatch = url.pathname.match(/^\/review-lab\/api\/batches\/(batch-[0-9a-f-]+)\/retry$/);
  if (req.method === "POST" && reviewBatchRetryMatch) {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    runReviewBatchInBackground(threadId, reviewBatchRetryMatch[1], "batch-retry");
    return json(res, 202, { ok: true, batchId: reviewBatchRetryMatch[1] });
  }
  const reviewJobMatch = url.pathname.match(/^\/review-lab\/api\/preview-jobs\/([^/]+)$/);
  if (req.method === "GET" && reviewJobMatch) {
    const job = reviewJobs.get(decodeURIComponent(reviewJobMatch[1]));
    if (!job) return error(res, 404, "候选任务不存在；Web 服务重启后请从候选列表查看已完成结果");
    return json(res, 200, { job });
  }
  if (req.method === "POST" && url.pathname === "/review-lab/api/hybrid") {
    const body = await readJson(req);
    const batch = writePrivateBatch({
      date: body.date,
      selection: body.selection,
      enforceCountLimit: body.enforceCountLimit === true,
    });
    try {
      const result = parseStmemJson(runStmem([
        "mine-review", "mix", "--thread", String(body.threadId || ""), "--batch-file", batch.file,
      ]));
      return json(res, 200, { candidate: reviewCandidateForWeb(result) });
    } finally { batch.cleanup(); }
  }
  if (req.method === "POST" && url.pathname === "/review-lab/api/fusion") {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    const profile = reviewProfileFromInput(threadId, body.profile);
    const sourceCandidateId = String(body.sourceCandidateId || "");
    if (!/^candidate-[0-9a-f-]+$/.test(sourceCandidateId)) throw new Error("融合来源候选无效");
    const job = {
      id: `fusion-${crypto.randomUUID()}`,
      threadId,
      sourceCandidateId,
      profile,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    reviewJobs.set(job.id, job);
    executeFusionPreview(job);
    return json(res, 202, { job: { id: job.id, status: job.status } });
  }
  const fusionEditMatch = url.pathname.match(/^\/review-lab\/api\/candidates\/([^/]+)\/fusion-edit$/);
  if (req.method === "POST" && fusionEditMatch) {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    const reviews = new MiningReviewStore({
      memoryDir: path.join(getThreadDir(threadId), "memory"),
      threadId,
    });
    const candidate = editFusionCandidate({
      reviews,
      candidateId: decodeURIComponent(fusionEditMatch[1]),
      edits: body.edits,
    });
    return json(res, 200, { candidate: reviewCandidateForWeb(candidate) });
  }
  const reviewEvidenceMatch = url.pathname.match(/^\/review-lab\/api\/candidates\/([^/]+)\/evidence$/);
  if (req.method === "GET" && reviewEvidenceMatch) {
    const threadId = String(url.searchParams.get("threadId") || "");
    const reviews = new MiningReviewStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
    const candidate = reviews.load(decodeURIComponent(reviewEvidenceMatch[1]));
    const index = Number(url.searchParams.get("index"));
    const item = candidate.feelings?.[index];
    if (!item) throw new Error("候选摘要不存在");
    const center = Date.parse(item.eventTime || "");
    const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
    try {
      const rows = store.listMessages({ date: candidate.date }).filter(row => {
        const time = Date.parse(row.timestamp || "");
        return !Number.isFinite(center) || (time >= center - 5 * 60 * 1000 && time <= center + 30 * 60 * 1000);
      }).map(row => ({ timestamp: row.timestamp, role: row.type, text: row.text }));
      return json(res, 200, { date: candidate.date, eventTime: item.eventTime, note: "事件前 5 分钟至后 30 分钟", rows });
    } finally { store.close(); }
  }
  const reviewActionMatch = url.pathname.match(/^\/review-lab\/api\/candidates\/([^/]+)\/(apply|discard)$/);
  if (req.method === "POST" && reviewActionMatch) {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    const result = parseStmemJson(runStmem([
      "mine-review", reviewActionMatch[2], "--thread", threadId,
      "--candidate", decodeURIComponent(reviewActionMatch[1]),
    ]));
    return json(res, 200, reviewActionMatch[2] === "apply" ? {
      ...result,
      feelings: result.feelingCount,
      features: result.featureCount,
    } : result);
  }
  if (req.method === "GET" && url.pathname === "/api/home") return json(res, 200, homeOverview());
  if (req.method === "GET" && url.pathname === "/api/libraries") return json(res, 200, { libraries: listLibraries() });

  if (req.method === "POST" && url.pathname === "/api/session-file/check") {
    if (isRemote) throw new Error("远程 Web 不能探测服务器本地线程文件目录；请在本机 CLI / loopback Web 中检查");
    const body = await readJson(req);
    const threadId = String(body.threadId || "").trim(), sessionDir = String(body.sessionDir || "").trim();
    if (!threadId || !sessionDir) throw new Error("请先填写真实 Claude/Codex 线程 ID 和线程文件搜索目录");
    const file = findThreadSessionFile(sessionDir, threadId);
    if (!file) throw new Error(`在这个目录中没有找到线程 ${threadId} 的 JSONL 文件，请重新填写路径或检查文件是否存在`);
    return json(res, 200, { found: true, file });
  }

  const overviewMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/overview$/);
  if (req.method === "GET" && overviewMatch) {
    const data = overview(decodeURIComponent(overviewMatch[1]));
    return data ? json(res, 200, data) : error(res, 404, "记忆体不存在");
  }

  const settingsMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/settings$/);
  if (settingsMatch) {
    const threadId = decodeURIComponent(settingsMatch[1]);
    if (req.method === "GET") return json(res, 200, publicThreadSettings(threadId, { redactLocalPaths: isRemote }));
    if (req.method === "PATCH") {
      const body = await readJson(req);
      const current = publicThreadSettings(threadId);
      if (isRemote && ["sessionDir", "threadFile"].some(key => Object.hasOwn(body, key))) {
        throw new Error("远程 Web 不能修改服务器本地 Binding 来源；请在本机 CLI / loopback Web 中修改");
      }
      const automationKeys = ["automaticFullMining", "automaticMemoryMaintenance", "automaticCompression", "automaticDream", "watcherEnabled"];
      const regularBody = Object.fromEntries(Object.entries(body).filter(([key]) => !automationKeys.includes(key)));
      const input = { ...current, ...regularBody, threadId, runtime: current.runtime, purpose: current.purpose };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-config-"));
      const file = path.join(dir, "config.json");
      let canonical = false;
      try { canonical = getMemoryContext(threadId).layout === "memory-v1"; } catch {}
      const settingsPatch = {
        label: input.libraryName, scenario: input.scenario, ai: input.ai, user: input.user, userGender: input.userGender,
        miner: { mode: input.minerMode, apiProfile: input.minerMode === "api" ? input.apiProvider : null },
        rebuild: {
          windowDays: input.windowDays, keepToolPairs: input.keepToolPairs,
          contextWindowTokens: input.contextWindowTokens || null,
          mcpRebuildDefaultsEnabled: input.mcpRebuildDefaultsEnabled,
          mcpSummaryLimit: input.mcpSummaryLimit,
          mcpMinImportance: input.mcpMinImportance,
        },
      };
      fs.writeFileSync(file, JSON.stringify(canonical ? settingsPatch : input), { encoding: "utf8", mode: 0o600 });
      try {
        if (canonical && input.minerMode === "api") {
          const profileFile = path.join(dir, "api-profile.json");
          fs.writeFileSync(profileFile, JSON.stringify({ id: input.apiProvider, key: input.apiKey, baseUrl: input.baseUrl, model: input.model }), { encoding: "utf8", mode: 0o600 });
          runStmem(["api-profile", "set", "--batch-file", profileFile, "--validate"]);
          runStmem(["api-profile", "set", "--batch-file", profileFile, "--apply"]);
        }
        if (canonical) {
          runStmem(["memory", "settings", "--memory", threadId, "--batch-file", file, "--validate"]);
          runStmem(["memory", "settings", "--memory", threadId, "--batch-file", file, "--apply"]);
        } else runStmem(["init", "--thread", threadId, "--batch-file", file]);
        const moduleArgs = ["watcher", "set", canonical ? "--memory" : "--thread", threadId];
        const moduleMap = {
          automaticFullMining: "--archive",
          automaticMemoryMaintenance: "--miner",
          automaticCompression: "--compression",
          automaticDream: "--dream",
        };
        for (const [key, flag] of Object.entries(moduleMap)) {
          if (Object.hasOwn(body, key)) moduleArgs.push(flag, body[key] === true ? "on" : "off");
        }
        if (moduleArgs.length > 4) runStmem(moduleArgs);
        if (Object.hasOwn(body, "watcherEnabled")) {
          runStmem(["watcher", body.watcherEnabled === true ? "on" : "off", canonical ? "--memory" : "--thread", threadId]);
        } else if (moduleArgs.length > 4) {
          const resulting = publicThreadSettings(threadId);
          const anyModule = resulting.automaticFullMining || resulting.automaticMemoryMaintenance
            || resulting.automaticCompression || resulting.automaticDream;
          runStmem(["watcher", anyModule ? "on" : "off", canonical ? "--memory" : "--thread", threadId]);
        }
        return json(res, 200, { success: true, config: publicThreadSettings(threadId, { redactLocalPaths: isRemote }) });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }

  const dreamMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/dreams(?:\/(generate))?$/);
  if (dreamMatch) {
    const threadId = decodeURIComponent(dreamMatch[1]);
    const settings = publicThreadSettings(threadId);
    if (req.method === "GET" && !dreamMatch[2]) {
      const reader = new DreamReader();
      const dreamDates = reader.listDates(threadId);
      const selectedDate = String(url.searchParams.get("date") || "");
      const selectedDream = selectedDate ? reader.get(threadId, selectedDate) : null;
      if (selectedDate && !selectedDream) return json(res, 404, { error: "梦境不存在或当前不可见" });
      return json(res, 200, {
        enabled: settings.automaticDream,
        latest: selectedDream || reader.latest(threadId),
        selectedDate: selectedDream ? selectedDate : dreamDates.at(-1) || null,
        dreamDates,
        entries: reader.list(threadId),
        coverage: reader.coverage(threadId),
        eligibleDates: reader.eligibleDates(threadId),
        job: dreamJobs.get(threadId) || null,
      });
    }
    if (req.method === "POST" && dreamMatch[2] === "generate") {
      const body = await readJson(req);
      const date = String(body.date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("请选择已经完成记忆挖掘的日期");
      const reader = new DreamReader();
      if (!reader.eligibleDates(threadId).includes(date)) {
        throw new Error(`${date} 尚未完成记忆挖掘，不能用于织梦`);
      }
      const active = dreamJobs.get(threadId);
      if (active?.status === "running") return json(res, 202, { success: true, job: active });
      const job = { threadId, date, status: "running", startedAt: new Date().toISOString(), completedAt: null, error: null };
      dreamJobs.set(threadId, job);
      runStmemAsync(["dream", "--thread", threadId, "--date", date], { maxOutput: 20_000 })
        .then(output => {
          job.status = "completed";
          job.result = JSON.parse(output);
          job.completedAt = new Date().toISOString();
        })
        .catch(error => {
          job.status = "failed";
          job.error = error.message;
          job.completedAt = new Date().toISOString();
        });
      return json(res, 202, { success: true, job });
    }
  }

  const dreamPreviewMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/dreams\/policy-preview$/);
  if (dreamPreviewMatch && req.method === "POST") {
    const threadId = decodeURIComponent(dreamPreviewMatch[1]);
    publicThreadSettings(threadId);
    const body = await readJson(req);
    const prefs = new DreamPreferences().read(threadId);
    try {
      return json(res, 200, planDreamDistribution({
        multipliers: body.multipliers || {},
        excludedTypes: body.excludedTypes || [],
        nsfwEnabled: prefs.nsfwEnabled,
      }));
    } catch (error) {
      if (error.code === "DREAM_NO_CANDIDATE") return json(res, 200, { valid: false, error: error.message });
      throw error;
    }
  }

  const dreamSettingsMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/dreams\/(preferences|pin|guard|multiplier|nsfw|prompt)$/);
  if (dreamSettingsMatch) {
    const threadId = decodeURIComponent(dreamSettingsMatch[1]);
    publicThreadSettings(threadId);
    return json(res, 200, await handleDreamSettings(req, url, threadId, dreamSettingsMatch[2]));
  }

  const notebookMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/notebooks(?:\/(.*))?$/);
  if (notebookMatch) {
    const threadId = decodeURIComponent(notebookMatch[1]);
    publicThreadSettings(threadId);
    const parts = String(notebookMatch[2] || "").split("/").filter(Boolean).map(decodeURIComponent);
    const service = new NotebookService();
    if (req.method === "GET" && parts.length === 0) {
      return json(res, 200, service.status({ threadId }));
    }
    if (req.method === "POST" && parts[0] === "topics" && parts.length === 1) {
      const body = await readJson(req);
      return json(res, 201, runStmemBatch(["notebook", "topic-create", "--thread", threadId], body));
    }
    if (req.method === "GET" && parts[0] === "assets" && parts.length === 3) {
      const asset = service.asset({ threadId, topicId: parts[1], filename: parts[2] });
      if (!asset) return json(res, 404, { found: false });
      return serveNotebookAsset(req, res, asset);
    }
    if (req.method === "POST" && parts[0] === "assets" && parts.length === 2) {
      const contentLength = Number(req.headers["content-length"] || 0);
      if (contentLength > MAX_NOTEBOOK_ASSET_UPLOAD) throw new Error("notebook asset exceeds 20 MB limit");
      const filename = safeFileName(req.headers["x-file-name"] || "image");
      let altText = "笔记图片";
      try { altText = decodeURIComponent(String(req.headers["x-alt-text"] || altText)); } catch {}
      const buffer = await readBody(req, MAX_NOTEBOOK_ASSET_UPLOAD);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-asset-"));
      const sourcePath = path.join(directory, filename);
      fs.writeFileSync(sourcePath, buffer, { mode: 0o600, flag: "wx" });
      try {
        return json(res, 201, runStmemBatch(["notebook", "asset-import", "--thread", threadId], {
          topicId: parts[1], sourcePath, filename, altText,
        }));
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
    if (req.method === "PATCH" && parts[0] === "topics" && parts[1]) {
      const body = await readJson(req);
      return json(res, 200, runStmemBatch(["notebook", "topic-update", "--thread", threadId], {
        ...body, topicId: parts[1],
      }));
    }
    if (req.method === "GET" && parts[0] === "topics" && parts[1] && parts[2] === "entries") {
      return json(res, 200, service.list({ threadId, topicId: parts[1], includeBody: false }));
    }
    if (req.method === "POST" && parts[0] === "entries" && parts.length === 1) {
      const body = await readJson(req);
      return json(res, 201, runStmemBatch(["notebook", "write", "--thread", threadId], body));
    }
    if (req.method === "GET" && parts[0] === "entries" && parts[1]) {
      const note = service.read({ threadId, noteId: parts[1] });
      return json(res, note ? 200 : 404, note || { found: false, noteId: parts[1] });
    }
    if (req.method === "PATCH" && parts[0] === "entries" && parts[1] && parts[2] === "visibility") {
      const body = await readJson(req);
      const visibility = body.visibility === "sealed" ? "sealed" : body.visibility === "visible" ? "visible" : null;
      if (!visibility) throw new Error("笔记展示状态必须是 visible 或 sealed");
      const current = service.read({ threadId, noteId: parts[1] });
      if (!current) return json(res, 404, { found: false, noteId: parts[1] });
      return json(res, 200, runStmemBatch(["notebook", "write", "--thread", threadId], {
        topicId: current.topicId,
        noteId: current.id,
        title: current.title,
        body: current.body,
        tags: current.tags,
        visibility,
        expectedRevision: current.revision,
      }));
    }
    if (req.method === "PATCH" && parts[0] === "entries" && parts[1]) {
      const body = await readJson(req);
      return json(res, 200, runStmemBatch(["notebook", "write", "--thread", threadId], {
        ...body, noteId: parts[1],
      }));
    }
    if (req.method === "GET" && parts[0] === "search") {
      return json(res, 200, service.query({
        threadId,
        query: String(url.searchParams.get("q") || ""),
        topicId: url.searchParams.get("topicId") || null,
        tags: String(url.searchParams.get("tags") || "").split(/[，,]/).map(value => value.trim()).filter(Boolean),
        limit: Number(url.searchParams.get("limit") || 20),
      }));
     }
  }

  const libraryMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)$/);
  if (req.method === "DELETE" && libraryMatch) {
    const threadId = decodeURIComponent(libraryMatch[1]);
    const context = getMemoryContext(threadId);
    if (context.layout === "memory-v1" && !(context.bindingConfig?.bindings || []).length) {
      runStmem(["memory", "delete", "--memory", context.memoryId, "--apply"]);
    } else runStmem(["delete", "--thread", threadId]);
    return json(res, 200, { success: true, threadId });
  }

  const miningMatch=url.pathname.match(/^\/api\/libraries\/([^/]+)\/mining\/(status|start|stop|check|day|targeted-messages|targeted)$/);
  if(miningMatch){
    const threadId=decodeURIComponent(miningMatch[1]);publicThreadSettings(threadId);
    if(req.method==="GET"&&miningMatch[2]==="status")return json(res,200,{job:refreshMiningBatchJob(miningJobs.get(threadId)||null),dates:miningDates(threadId)});
    if(req.method==="POST"&&miningMatch[2]==="check"){
      const body=await readJson(req),date=String(body.date||""),mode=body.mode==="api"?"api":body.mode==="subagent"?"subagent":null,apiProfile=normalizeMiningApiProfile(body.apiProfile);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error("请选择需要自检的对话日期");
      if(!mode)throw new Error("请选择 API 或 Subagent 挖掘通道");
      try{
        const output=await runStmemAsync(miningCheckCommandArgs(threadId,date,mode,apiProfile),{maxOutput:50000});
        return json(res,200,JSON.parse(output));
      }catch(cause){
        const text=String(cause.message||cause);
        try{return json(res,200,JSON.parse(text.slice(text.indexOf("{"))));}catch{}
        throw cause;
      }
    }
    if(req.method==="POST"&&miningMatch[2]==="stop"){
      const active=miningJobs.get(threadId);
      if(!active||!["queued","running","cancelling"].includes(active.status))return json(res,200,{stopped:false,code:"MINING_NOT_RUNNING"});
      active.cancelRequested=true;active.status="cancelling";active.updatedAt=new Date().toISOString();
      let result;
      try{result=JSON.parse(runStmem(["mine","--thread",threadId,"--stop","--json"])||"{}");}
      catch(cause){result={stopped:false,code:"MINING_STOP_FAILED",reason:cause.message};}
      return json(res,200,{...result,job:active});
    }
    if(req.method==="GET"&&miningMatch[2]==="day"){
      const date=String(url.searchParams.get("date")||"");
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error("日期格式无效");
      const store=new MemoryStore({memoryDir:path.join(getThreadDir(threadId),"memory"),threadId});
      try{
        let anchors={retain:{},eventAnchors:{}};
        try{anchors={...anchors,...JSON.parse(fs.readFileSync(path.join(getThreadDir(threadId),"memory","retain-config.json"),"utf8"))};}catch{}
        const feelings=store.listFeelings({date}).map(row=>({...row,retainAnchor:!!anchors.retain?.[row.id],eventAnchor:!!anchors.eventAnchors?.[row.id]}));
        const features=store.listFeatures({date});
        return json(res,200,{date,feelings,features});
      }finally{store.close();}
    }
    if(req.method==="GET"&&miningMatch[2]==="targeted-messages"){
      const date=String(url.searchParams.get("date")||""),search=String(url.searchParams.get("search")||"").trim();
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error("日期格式无效");
      const store=new MemoryStore({memoryDir:path.join(getThreadDir(threadId),"memory"),threadId});
      try{
        const rows=store.db.prepare("SELECT timestamp,source_date sourceDate,role,text FROM messages WHERE thread_id=? AND source_date=? ORDER BY timestamp,message_seq").all(threadId,date);
        const needle=search.toLocaleLowerCase();
        return json(res,200,{date,search,matchCount:needle?rows.filter(row=>row.text.toLocaleLowerCase().includes(needle)).length:0,
          rows:rows.map(row=>({...row,matched:!!needle&&row.text.toLocaleLowerCase().includes(needle)}))});
      }finally{store.close();}
    }
    if(req.method==="POST"&&miningMatch[2]==="targeted"){
      const body=await readJson(req),date=String(body.date||""),mode=body.mode==="api"?"api":body.mode==="subagent"?"subagent":null,apiProfile=normalizeMiningApiProfile(body.apiProfile);
      const timestamps=[...new Set(Array.isArray(body.timestamps)?body.timestamps.map(String):[])];
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error("日期格式无效");
      if(!mode)throw new Error("请选择 API 或 Subagent 挖掘通道");
      if(!timestamps.length)throw new Error("请至少选择一条对话");
      const batchFile=path.join(os.tmpdir(),`stmem-targeted-${crypto.randomUUID()}.json`);
      fs.writeFileSync(batchFile,JSON.stringify({date,timestamps,instruction:String(body.instruction||"")}));
      try{
        const output=await runStmemAsync(targetedMiningCommandArgs(threadId,mode,batchFile,apiProfile));
        return json(res,200,{success:true,output});
      }finally{try{fs.unlinkSync(batchFile);}catch{}}
    }
    if(req.method==="POST"&&miningMatch[2]==="start"){
      const active=miningJobs.get(threadId);
      if(active&&["queued","running"].includes(active.status))return error(res,409,"这个记忆体正在挖掘，请等待当前任务完成");
      const body=await readJson(req),mode=body.mode==="api"?"api":body.mode==="subagent"?"subagent":null,apiProfile=normalizeMiningApiProfile(body.apiProfile);
      if(!mode)throw new Error("请选择 API 或 Subagent 挖掘通道");
      const available=new Set(miningDates(threadId).map(row=>row.date));
      const dates=[...new Set(Array.isArray(body.dates)?body.dates.map(String):[])].filter(date=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&available.has(date)).sort();
      if(!dates.length)throw new Error("请至少选择一个有对话的日期");
      const requestedForceDates=new Set(Array.isArray(body.forceDates)?body.forceDates.map(String):[]);
      const forceDates=dates.filter(date=>requestedForceDates.has(date));
      const now=new Date().toISOString(),job={id:crypto.randomUUID(),threadId,mode,apiProfile,dates,forceDates,status:"queued",currentDate:null,completed:0,results:[],cancelRequested:false,createdAt:now,updatedAt:now};
      miningJobs.set(threadId,job);
      executeMiningJob(job).catch(cause=>{job.status="failed";job.currentDate=null;job.error=String(cause.message||cause).slice(0,500);job.updatedAt=new Date().toISOString();});
      return json(res,202,{job});
    }
  }

  const promptsMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/mining\/prompts$/);
  if (promptsMatch) {
    const memoryId = decodeURIComponent(promptsMatch[1]);
    const config = loadConfig(); const context = getMemoryContext(memoryId);
    const entry = context.layout === "memory-v1" ? getMemoryRuntimeConfig(memoryId) : (config[memoryId] || {});
    const timeline = Array.isArray(entry.relationshipTimeline) ? entry.relationshipTimeline : [];
    const memoryDir = path.join(getThreadDir(memoryId), "memory");
    const scenario = scenarioId(entry);
    const defaults = resolveMiningPrompts(entry, { defaultsOnly: true });
    const resolved = resolveMiningPrompts(entry, { memoryDir });
    if (req.method === "GET") {
      return json(res, 200, {
        scenario,
        summaryPrompt: resolved.tasks.feelings.template,
        featurePrompt: resolved.tasks.features.template,
        defaultSummary: defaults.tasks.feelings.template,
        defaultFeature: defaults.tasks.features.template,
        timeline,
      });
    }
    if (req.method === "PUT") return json(res, 403, { error: "挖掘提示词编辑功能暂时关闭" });
  }

  const memorySectionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/(rules|feelings|features)$/);
  if (memorySectionMatch) {
    const threadId = decodeURIComponent(memorySectionMatch[1]), section = memorySectionMatch[2];
    publicThreadSettings(threadId);
    if (req.method === "GET" && section === "rules") return json(res, 200, { rows: listRules(threadId) });
    if (req.method === "GET" && ["feelings", "features"].includes(section)) {
      const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
      try {
        const search = String(url.searchParams.get("search") || "").toLowerCase();
        const category = String(url.searchParams.get("category") || "");
        let rows = section === "feelings" ? store.listFeelings() : store.listFeatures().reverse();
        if (section === "feelings") { let anchors={retain:{},eventAnchors:{}}; try{anchors={...anchors,...JSON.parse(fs.readFileSync(path.join(getThreadDir(threadId),"memory","retain-config.json"),"utf8"))};}catch{} rows=rows.map(row=>({...row,retainAnchor:!!anchors.retain?.[row.id],eventAnchor:!!anchors.eventAnchors?.[row.id]})); }
        if (search) rows = rows.filter(row => String(row.content || "").toLowerCase().includes(search) || String(row.coarse_summary || "").toLowerCase().includes(search));
        if (category && section === "features") rows = rows.filter(row => row.category === category);
        if (section === "feelings" && url.searchParams.get("mode")) rows=rows.filter(row=>row.summary_mode===url.searchParams.get("mode"));
        if (section === "feelings" && url.searchParams.get("importance")) rows=rows.filter(row=>String(row.importance)===url.searchParams.get("importance"));
        if (section === "feelings" && url.searchParams.get("date")) rows=rows.filter(row=>row.source_date===url.searchParams.get("date"));
        if (section === "feelings" && url.searchParams.get("retainAnchor")==="1") rows=rows.filter(row=>row.retainAnchor);
        if (section === "feelings" && url.searchParams.get("eventAnchor")==="1") rows=rows.filter(row=>row.eventAnchor);
        if (section === "feelings") {
          const direction=url.searchParams.get("sort")==="asc"?1:-1;
          rows.sort((a,b)=>direction*((Number(a.seq)||0)-(Number(b.seq)||0)));
        }
        return json(res, 200, { rows: paginate(rows, url.searchParams.get("page")), categories: section === "features" ? [...new Set(store.listFeatures().map(row => row.category))].sort() : [] });
      } finally { store.close(); }
    }
    if (section === "rules" && ["POST", "PUT"].includes(req.method)) {
      const name = safeFileName(req.headers["x-file-name"] || "rule.md");
      const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rule-")), source = path.join(sourceDir, name);
      fs.writeFileSync(source, await readBody(req));
      try { runStmem(["rules", req.method === "POST" ? "import" : "update", "--thread", threadId, "--name", name, "--source", source]); return json(res, 200, { success: true }); }
      finally { fs.rmSync(sourceDir, { recursive: true, force: true }); }
    }
  }

  const conversationsMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/conversations$/);
  if (req.method === "GET" && conversationsMatch) {
    const threadId=decodeURIComponent(conversationsMatch[1]);
    publicThreadSettings(threadId);
    const store=new MemoryStore({memoryDir:path.join(getThreadDir(threadId),"memory"),threadId});
    try {
      const query=String(url.searchParams.get("search")||"").trim(), date=String(url.searchParams.get("date")||"").trim(), focus=String(url.searchParams.get("focus")||"").trim(), pageSize=20;
      const counts=store.db.prepare("SELECT source_date date,COUNT(*) count FROM messages WHERE thread_id=? GROUP BY source_date ORDER BY source_date ASC").all(threadId);
      const calendar=buildConversationCalendar(counts,url.searchParams.get("calendarPage"));
      if(query){const pattern=`%${query}%`,total=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND text LIKE ?").get(threadId,pattern).count,page=Math.max(1,Number(url.searchParams.get("page"))||1);const rows=store.db.prepare("SELECT timestamp,source_date sourceDate,role,text FROM messages WHERE thread_id=? AND text LIKE ? ORDER BY timestamp DESC,message_seq DESC LIMIT ? OFFSET ?").all(threadId,pattern,pageSize,(page-1)*pageSize);return json(res,200,{mode:"search",query,calendar,rows:{page,pageSize,total,totalPages:Math.max(1,Math.ceil(total/pageSize)),rows}});}
      if(date){const total=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND source_date=?").get(threadId,date).count;let page=Math.max(1,Number(url.searchParams.get("page"))||1);if(focus){const position=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND source_date=? AND timestamp<=?").get(threadId,date,focus).count;if(position)page=Math.ceil(position/pageSize);}const totalPages=Math.max(1,Math.ceil(total/pageSize));page=Math.min(page,totalPages);const rows=store.db.prepare("SELECT timestamp,source_date sourceDate,role,text FROM messages WHERE thread_id=? AND source_date=? ORDER BY timestamp ASC,message_seq ASC LIMIT ? OFFSET ?").all(threadId,date,pageSize,(page-1)*pageSize);return json(res,200,{mode:"date",date,focus,calendar,rows:{page,pageSize,total,totalPages,rows}});}
      return json(res,200,{mode:"calendar",calendar});
    } finally { store.close(); }
  }

  const toolPolicyMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/tool-policy$/);
  if (toolPolicyMatch) {
    const threadId=decodeURIComponent(toolPolicyMatch[1]);
    publicThreadSettings(threadId);
    if(req.method==="GET") {
      const action=url.searchParams.get("action")==="detect"?"detect":url.searchParams.get("action")==="filtered"?"filtered":"status";
      const args=["tool-policy",action,"--thread",threadId];
      if(action==="filtered"){args.push("--limit",String(url.searchParams.get("limit")||100),"--offset",String(url.searchParams.get("offset")||0));}
      return json(res,200,JSON.parse(runStmem(args,{maxBuffer:64*1024*1024})));
    }
    if(req.method==="POST") {
      const requested=url.searchParams.get("action");
      const action=requested==="plan"?"plan":requested==="unfilter-preview"?"unfilter-preview":requested==="unfilter"?"unfilter":"apply";
      return json(res,200,runStmemBatch(["tool-policy",action,"--thread",threadId],await readJson(req)));
    }
  }

  const timelineMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/timeline$/);
  if (req.method === "GET" && timelineMatch) {
    const threadId = decodeURIComponent(timelineMatch[1]);
    publicThreadSettings(threadId);
    const terms = String(url.searchParams.get("terms") || "").split(",");
    const args = timelineCommandArgs(threadId, terms, {
      from: String(url.searchParams.get("from") || ""),
      to: String(url.searchParams.get("to") || ""),
    });
    return json(res, 200, compactTimelineReport(JSON.parse(runStmem(args, { timeout: 2 * 60 * 1000 }))));
  }

  const compressionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/compression\/(preview|apply)$/);
  if (compressionMatch) {
    const threadId = decodeURIComponent(compressionMatch[1]), action = compressionMatch[2];
    publicThreadSettings(threadId);
    if (req.method === "GET" && action === "preview") {
      const args = compressionCommandArgs(threadId, {
        kind: String(url.searchParams.get("kind") || "compact"),
        afterDays: url.searchParams.get("afterDays") || 90,
      });
      return json(res, 200, JSON.parse(await runStmemAsync(args, { maxOutput: 64 * 1024 * 1024 })));
    }
    if (req.method === "POST" && action === "apply") {
      if (compressionJobs.has(threadId)) throw new Error("这个记忆体已有压缩任务正在执行");
      const body = await readJson(req);
      const args = compressionCommandArgs(threadId, {
        kind: body.kind, apply: true, mode: body.mode,
        from: body.from, to: body.to, afterDays: body.afterDays,
      });
      compressionJobs.add(threadId);
      try { return json(res, 200, JSON.parse(await runStmemAsync(args, { maxOutput: 64 * 1024 * 1024 }))); }
      finally { compressionJobs.delete(threadId); }
    }
  }

  const feelingActionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/feelings\/(update|batch-update|anchor)$/);
  if (req.method === "POST" && feelingActionMatch) {
    const threadId=decodeURIComponent(feelingActionMatch[1]);
    publicThreadSettings(threadId);
    const body=await readJson(req);
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-memory-")), file=path.join(dir,"input.json");
    fs.writeFileSync(file,JSON.stringify(body),{encoding:"utf8",mode:0o600});
    try { return json(res,200,JSON.parse(runStmem(["memory",feelingActionMatch[2],"--thread",threadId,"--batch-file",file]))); }
    finally { fs.rmSync(dir,{recursive:true,force:true}); }
  }

  const retainPreviewMatch=url.pathname.match(/^\/api\/libraries\/([^/]+)\/feelings\/retain-preview$/);
  if(req.method==="GET"&&retainPreviewMatch){
    const threadId=decodeURIComponent(retainPreviewMatch[1]),id=String(url.searchParams.get("id")||"");
    publicThreadSettings(threadId);
    const store=new MemoryStore({memoryDir:path.join(getThreadDir(threadId),"memory"),threadId});
    try{
      const feeling=store.db.prepare("SELECT * FROM feelings WHERE thread_id=? AND id=?").get(threadId,id);
      if(!feeling)throw new Error("摘要不存在");
      const parsed=parseFeelingTime(feeling.content),eventTime=feeling.event_time||(parsed?feelingToUtc({...parsed,date:feeling.source_date}):null);
      const all=store.listFeelings(),index=all.findIndex(row=>row.id===id),next=index>=0?all.slice(index+1).find(row=>row.event_time||parseFeelingTime(row.content)?.hour!=null):null;
      let nextEventUtc=null;
      if(next){
        const nextParsed=parseFeelingTime(next.content);
        nextEventUtc=next.event_time||(nextParsed?feelingToUtc({...nextParsed,date:next.source_date}):null);
      }
      const dayMessages=store.listMessages({date:feeling.source_date});
      const automatic=automaticRetainWindow(eventTime,nextEventUtc,dayMessages);
      const startUtc=automatic?.startUtc||null,endUtc=automatic?.endUtc||null;
      let config={retain:{}};try{config={...config,...JSON.parse(fs.readFileSync(path.join(getThreadDir(threadId),"memory","retain-config.json"),"utf8"))};}catch{}
      const saved=config.retain?.[id]||{},effectiveStart=saved.startUtc||startUtc,effectiveEnd=saved.endUtc||endUtc;
      const startMs=effectiveStart?new Date(effectiveStart).getTime():NaN,endMs=effectiveEnd?new Date(effectiveEnd).getTime():NaN;
      const rows=dayMessages.map(row=>{const time=new Date(row.timestamp).getTime();return {...row,selected:Number.isFinite(time)&&Number.isFinite(startMs)&&Number.isFinite(endMs)&&time>=startMs&&time<endMs};});
      return json(res,200,{feeling:{id:feeling.id,content:feeling.content,sourceDate:feeling.source_date},startUtc:effectiveStart,endUtc:effectiveEnd,rows});
    }finally{store.close();}
  }

  const ruleActionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/rules\/([^/]+)\/(enable|disable)$/);
  if (req.method === "POST" && ruleActionMatch) { runStmem(["rules", ruleActionMatch[3], "--thread", decodeURIComponent(ruleActionMatch[1]), "--name", decodeURIComponent(ruleActionMatch[2])]); return json(res, 200, { success: true }); }
  const ruleDeleteMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/rules\/([^/]+)$/);
  if (req.method === "DELETE" && ruleDeleteMatch) { runStmem(["rules", "delete", "--thread", decodeURIComponent(ruleDeleteMatch[1]), "--name", decodeURIComponent(ruleDeleteMatch[2])]); return json(res, 200, { success: true }); }

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
      const bindingValue = String(url.searchParams.get("binding") || "").trim();
      const binding = bindingValue ? getConfiguredBinding(threadId, bindingValue) : null;
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
      try{return json(res,200,parseRebuildDryRun(runStmem(rebuildArgs)));}
      finally{fs.rmSync(dir,{recursive:true,force:true});}
    }
    if (req.method === "GET" && action === "check") {
      const checkArgs = ["rebuild", "--thread", threadId, "--check"];
      const bindingValue = (url.searchParams.get("binding") || "").trim();
      if (bindingValue) checkArgs.push("--binding", bindingValue);
      return json(res, 200, JSON.parse(runStmem(checkArgs)));
    }
    if (req.method === "POST" && action === "repair") {
      const body = await readJson(req);
      const repairArgs = ["rebuild", "--thread", threadId, "--repair"];
      const bindingValue = String(body.bindingId || "").trim();
      if (bindingValue) repairArgs.push("--binding", bindingValue);
      return json(res, 200, JSON.parse(runStmem(repairArgs)));
    }
    if (req.method === "POST" && action === "queue") {
      const body = await readJson(req);
      const bindingValue = String(body.bindingId || "").trim();
      const binding = bindingValue ? getConfiguredBinding(threadId, bindingValue) : null;
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
      const bindingValue = String(body.bindingId || "").trim();
      const binding = bindingValue ? getConfiguredBinding(threadId, bindingValue) : null;
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

  if (req.method === "POST" && url.pathname === "/api/imports/preview") {
    const filename = safeFileName(req.headers["x-file-name"]);
    const buffer = await readBody(req, MAX_UPLOAD);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-import-"));
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);
    try {
      const source = readImportSource({ filePath, table: req.headers["x-sqlite-table"] || undefined });
      const token = crypto.randomUUID();
      previews.set(token, { filePath, source, filename, createdAt: Date.now() });
      return json(res, 200, { token, filename, ...source.preview, ...previewRows(source, 1) });
    } catch (cause) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw cause;
    }
  }

  const pageMatch = url.pathname.match(/^\/api\/imports\/([^/]+)$/);
  if (req.method === "GET" && pageMatch) {
    const item = previews.get(pageMatch[1]);
    return item ? json(res, 200, { token: pageMatch[1], filename: item.filename, ...item.source.preview, ...previewRows(item.source, url.searchParams.get("page")) }) : error(res, 404, "导入预览已过期");
  }

  const libraryImportMatch=url.pathname.match(/^\/api\/libraries\/([^/]+)\/imports$/);
  if(req.method==="POST"&&libraryImportMatch){
    const threadId=decodeURIComponent(libraryImportMatch[1]);publicThreadSettings(threadId);
    const input=await readJson(req),tokens=[...new Set(Array.isArray(input.importTokens)?input.importTokens.map(String):[])];
    if(!tokens.length)throw new Error("请先上传并确认至少一个对话文件");
    const items=tokens.map(token=>({token,item:previews.get(token)}));
    if(items.some(row=>!row.item))throw new Error("有一个导入预览已经过期，请重新上传");
    const imported={imported:0,fullBacked:0,files:0};
    for(const {token,item} of items){
      runStmem(["import","--thread",threadId,"--source",item.filePath,"--apply"]);
      imported.imported+=item.source.preview.valid;imported.fullBacked+=item.source.preview.valid+(item.source.preview.filtered||0);imported.files++;
      fs.rmSync(path.dirname(item.filePath),{recursive:true,force:true});previews.delete(token);
    }
    return json(res,200,imported);
  }

  const layoutUpgradeMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/layout-upgrade$/);
  if (req.method === "POST" && layoutUpgradeMatch) {
    if (isRemote) throw new Error("旧布局升级只能在运行 Stone Memory 的本机完成");
    const memoryId = decodeURIComponent(layoutUpgradeMatch[1]);
    const before = listLibraries().find(item => item.memoryId === memoryId);
    if (!before) throw new Error(`记忆体不存在：${memoryId}`);
    if (!before.upgradeRequired) return json(res, 200, { changed: false, library: before });
    const body = await readJson(req);
    const payload = {
      label: String(body.libraryName || before.libraryName || memoryId).trim(),
      ai: String(body.ai || before.ai || "").trim(),
      user: String(body.user || before.user || "").trim(),
      scenario: String(body.scenario || before.scenario || before.purpose || "accompany").trim(),
      purpose: String(body.scenario || before.scenario || before.purpose || "accompany").trim(),
      userGender: String(body.userGender || "unspecified"),
    };
    if (!payload.label || !payload.ai || !payload.user) throw new Error("请补全记忆体名字、AI 名字和用户名字");
    runStmemBatch(["memory", "migrate-layout", "--memory", memoryId], payload);
    runStmemBatch(["memory", "migrate-layout", "--memory", memoryId, "--apply"], payload);
    let bindingCreated = false, bindingWarning = null;
    try {
      const bindingPlan = JSON.parse(runStmem(["binding", "migrate-legacy", "--memory", memoryId]));
      if (bindingPlan.changed) {
        runStmem(["binding", "migrate-legacy", "--memory", memoryId, "--apply"]);
        bindingCreated = true;
      }
    } catch (error) {
      bindingWarning = "旧窗口无法自动验证，请升级后在接入设置中重新绑定";
    }
    runStmem(["watcher", "set", "--memory", memoryId,
      "--archive", before.automaticFullMining ? "on" : "off",
      "--miner", before.automaticMemoryMaintenance ? "on" : "off",
      "--compression", before.automaticCompression ? "on" : "off",
      "--dream", before.automaticDream ? "on" : "off"]);
    runStmem(["watcher", before.watcherEnabled && bindingCreated ? "on" : "off", "--memory", memoryId]);
    const library = listLibraries().find(item => item.memoryId === memoryId);
    return json(res, 200, { changed: true, library, bindingCreated, bindingRequired: !library?.bound, bindingWarning });
  }

  if (req.method === "POST" && url.pathname === "/api/libraries") {
    const body = await readJson(req);
    if (isRemote && (body.threadId || body.sessionDir || body.threadFile || body.source)) {
      throw new Error("远程 Web 可以创建和配置记忆体，但不能同时注册服务器本地 Binding；请在本机完成接入");
    }
    const input = body.scenario || body.purpose ? normalizeScenarioConfig(body) : body;
    let createdNow = false;
    if (!input.memoryId) {
      const result = JSON.parse(runStmem(["memory", "create", ...(String(input.libraryName || "").trim() ? ["--name", String(input.libraryName).trim()] : [])]));
      createdNow = true;
      if (!String(input.threadId || "").trim()) {
        if (!String(input.ai || "").trim() || !String(input.user || "").trim() || !String(input.purpose || "").trim()) {
          return json(res, 201, { library: { ...result.memory, libraryName: result.memory.label, configured: false, threadId: null } });
        }
        input.memoryId = result.memory.memoryId;
      } else {
        // Compatibility for an already-open older frontend: it may still submit
        // the former all-in-one payload. The server still routes both writes through CLI.
        input.memoryId = result.memory.memoryId;
      }
    }
    if (!getMemory(input.memoryId)) throw new Error(`记忆体不存在：${input.memoryId}`);
    const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-init-"));
    const imported = { imported: 0, fullBacked: 0, files: 0 };
    try {
      if (!String(input.threadId || "").trim()) {
        const settingsFile = path.join(initDir, "memory-settings.json");
        fs.writeFileSync(settingsFile, JSON.stringify({
          label: input.libraryName, purpose: input.purpose, scenario: input.scenario, ai: input.ai, user: input.user,
          userGender: input.userGender || "unspecified", miner: { mode: "subagent", apiProfile: null },
        }), { encoding: "utf8", mode: 0o600 });
        runStmem(["memory", "settings", "--memory", input.memoryId, "--batch-file", settingsFile, "--validate"]);
        runStmem(["memory", "settings", "--memory", input.memoryId, "--batch-file", settingsFile, "--apply"]);
        const created = listLibraries().find(item => item.memoryId === input.memoryId);
        if (!created?.configured) throw new Error("记忆体基础设置保存成功但页面未能识别");
        return json(res, 201, { library: created, imported });
      }
      if (input.minerMode === "api") {
        const profileFile = path.join(initDir, "api-profile.json");
        fs.writeFileSync(profileFile, JSON.stringify({ id: input.apiProvider, key: input.apiKey, baseUrl: input.baseUrl, model: input.model }), { encoding: "utf8", mode: 0o600 });
        runStmem(["api-profile", "set", "--batch-file", profileFile, "--validate"]);
        runStmem(["api-profile", "set", "--batch-file", profileFile, "--apply"]);
      }
      const settingsFile = path.join(initDir, "memory-settings.json");
      fs.writeFileSync(settingsFile, JSON.stringify({
        label: input.libraryName, purpose: input.purpose, scenario: input.scenario, ai: input.ai, user: input.user,
        userGender: input.userGender || "unspecified",
        miner: { mode: input.minerMode, apiProfile: input.minerMode === "api" ? input.apiProvider : null },
        rebuild: { windowDays: Number(input.windowDays) || 1, keepToolPairs: input.keepToolPairs === undefined || input.keepToolPairs === "" ? 15 : Math.max(0, Number(input.keepToolPairs) || 0) },
      }), { encoding: "utf8", mode: 0o600 });
      runStmem(["memory", "settings", "--memory", input.memoryId, "--batch-file", settingsFile, "--validate"]);
      runStmem(["memory", "settings", "--memory", input.memoryId, "--batch-file", settingsFile, "--apply"]);

      const bindingFile = path.join(initDir, "binding.json");
      fs.writeFileSync(bindingFile, JSON.stringify({ provider: input.runtime, externalThreadId: input.threadId, sessionRoot: input.sessionDir, mode: "primary" }), { encoding: "utf8", mode: 0o600 });
      runStmem(["binding", "add", "--memory", input.memoryId, "--batch-file", bindingFile]);
      runStmem(["binding", "add", "--memory", input.memoryId, "--batch-file", bindingFile, "--apply"]);

      const modules = ["watcher", "set", "--memory", input.memoryId,
        "--archive", input.automaticFullMining === false ? "off" : "on",
        "--miner", input.automaticMemoryMaintenance === false ? "off" : "on",
        "--compression", input.automaticCompression === true ? "on" : "off",
        "--dream", input.automaticDream === true ? "on" : "off"];
      runStmem(modules);
      const watcherOn = input.watcherEnabled !== false && (input.automaticFullMining !== false || input.automaticMemoryMaintenance !== false || input.automaticCompression === true || input.automaticDream === true);
      runStmem(["watcher", watcherOn ? "on" : "off", "--memory", input.memoryId]);

      for (const token of input.importTokens || []) {
        const item = previews.get(token);
        if (!item) throw new Error("有一个导入预览已经过期，请重新上传");
        runStmem(["import", "--memory", input.memoryId, "--source", item.filePath, "--apply"]);
        imported.imported += item.source.preview.valid;
        imported.fullBacked += item.source.preview.valid + (item.source.preview.filtered || 0);
        imported.files++;
        fs.rmSync(path.dirname(item.filePath), { recursive: true, force: true });
        previews.delete(token);
      }
      const created = listLibraries().find(item => item.memoryId === input.memoryId);
      if (!created?.configured) throw new Error("Binding 创建成功但记忆体未进入已配置状态");
      return json(res, 201, { library: created, imported });
    } catch (cause) {
      if (createdNow) {
        try { runStmem(["memory", "delete", "--memory", input.memoryId, "--apply"]); } catch {}
      }
      throw cause;
    } finally { fs.rmSync(initDir, { recursive: true, force: true }); }
  }

  return error(res, 404, "接口不存在");
}

function cleanupPreviews() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [token, item] of previews) if (item.createdAt < cutoff) {
    try { fs.rmSync(path.dirname(item.filePath), { recursive: true, force: true }); } catch {}
    previews.delete(token);
  }
  for (const [id, job] of reviewJobs) {
    const timestamp = Date.parse(job.completedAt || job.createdAt || "");
    if (Number.isFinite(timestamp) && timestamp < cutoff) reviewJobs.delete(id);
  }
  for (const [id, job] of scratchJobs) {
    const timestamp = Date.parse(job.completedAt || job.createdAt || "");
    if (job.status !== "running" && Number.isFinite(timestamp) && timestamp < cutoff) scratchJobs.delete(id);
  }
}

function webAccessOverview() {
  const config = loadConfig(), web = config.web || {};
  const host = String(web.host || "127.0.0.1"), port = Number(web.port) || 4173;
  const urls = [];
  if (!isLoopbackHost(host)) {
    for (const rows of Object.values(os.networkInterfaces())) {
      for (const row of rows || []) {
        if (row.family === "IPv4" && !row.internal && row.address) urls.push(`http://${row.address}:${port}`);
      }
    }
  }
  return { enabled:!isLoopbackHost(host), host, port, urls:[...new Set(urls)].sort(), authenticationEnabled:Boolean(configuredAuth(config)) };
}

function startWebServer({ host = "127.0.0.1", port = 4173 } = {}) {
  const initialConfig = loadConfig();
  if ((!isLoopbackHost(host) || initialConfig.web?.publicUrl) && !configuredAuth(initialConfig)) {
    throw new Error("非 loopback Web 监听必须先配置 Web API Token");
  }
  const webAuth = createWebAuth({ host, configProvider: loadConfig, sessionStore:createWebSessionStore() });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    try {
      if (isPublicWebApiRoute(req.method, url.pathname) && url.pathname === "/api/auth/status") {
        let status = webAuth.status(req);
        // Legacy reverse-proxy installs can listen on loopback while browsers
        // arrive through a public/Tailscale hostname. The listener alone cannot
        // reveal that topology during startup, so migrate on the first remote
        // status request instead of leaving the browser in a 503 dead end.
        if (status.authenticationRequired && !status.enabled) {
          ensureLegacyWebAuth();
          status = webAuth.status(req);
        }
        return json(res, 200, { ...status, bootstrapPending:webSecurityStatus().bootstrapPending });
      }
      if (isPublicWebApiRoute(req.method, url.pathname) && url.pathname === "/api/auth/unlock") {
        webAuth.assertSameOrigin(req, { kind: "none" });
        const body = await readJson(req);
        const cookie = webAuth.unlock(String(body.token || ""), req);
        return json(res, 200, { unlocked: true }, { "set-cookie": cookie });
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/review-lab/api/")) {
        const principal = webAuth.authenticate(req);
        webAuth.assertSameOrigin(req, principal);
        if (principal.refreshCookie) res.setHeader("set-cookie", principal.refreshCookie);
        return await handleApi(req, res, url, { isRemote: isRemoteRequest(req) });
      }
      if (serveLegacyDreamLab(res, url)) return;
      if (serveCanonicalDeveloperModule(req, res, url.pathname)) return;
      if (serveStatic(req, res, url.pathname)) return;
      if (!path.extname(url.pathname)) return serveStatic(req, res, "/");
      error(res, 404, "页面不存在");
    } catch (cause) {
      if (cause instanceof WebAuthError) return error(res, cause.status, cause.message || "认证失败", cause.headers);
      error(res, 400, cause.message || "请求失败");
    }
  });
  const timer = setInterval(cleanupPreviews, 10 * 60 * 1000);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = {
  startWebServer, listLibraries, homeOverview, countFeelingsMinedSince, memoryGrowthDays, overview, previewRows, paginate, buildConversationCalendar,
  listDeveloperModules, developerModuleDetail,
  miningDatesFromStore, miningCommandArgs, miningCheckCommandArgs, targetedMiningCommandArgs,
  timelineCommandArgs, compactTimelineReport, compressionCommandArgs, safeStmemFailure, runStmem,
  reviewCandidateForWeb, reviewProfileFromInput, reviewBatchPayload, reviewBatchCommandArgs, webAccessOverview,
};
