const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { URL } = require("url");
const { loadConfig, listThreadIds, getThreadDir } = require("../config");
const { readImportSource } = require("../services/import-source");
const { MemoryStore } = require("../storage/memory-store");
const { buildRebuildPreview } = require("../services/rebuild-workbench");
const { findThreadSessionFile } = require("../lib/thread-session-file");
const { listRules } = require("../services/rule-store");
const { latestSuccessfulRebuild, readRebuildState } = require("../services/rebuild-log");
const { sessionFile } = require("../services/rebuild-workbench");
const { parseFeelingTime, feelingToUtc, automaticRetainWindow } = require("../services/thread-rebuilder");
const { parseRebuildDryRun } = require("../services/rebuild-dry-run");

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_UPLOAD = 512 * 1024 * 1024;
const previews = new Map();
const miningJobs = new Map();
const compressionJobs = new Set();
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const STMEM_BIN = path.join(PROJECT_ROOT, "bin", "stmem");

function runStmem(args, { timeout = 10 * 60 * 1000 } = {}) {
  const result = spawnSync(process.execPath, [STMEM_BIN, ...args], { cwd: PROJECT_ROOT, encoding: "utf8", timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `stmem ${args[0]} 失败`).trim());
  return (result.stdout || "").trim();
}

function runStmemAsync(args, { maxOutput = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child=spawn(process.execPath,[STMEM_BIN,...args],{cwd:PROJECT_ROOT,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout=(stdout+chunk).slice(-maxOutput);});
    child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-Math.min(maxOutput,8000));});
    child.once("error",reject);
    child.once("close",code=>code===0?resolve(stdout.trim()):reject(new Error((stderr||stdout||`stmem ${args[0]} 失败`).trim())));
  });
}

function miningDatesFromStore(store,threadId) {
  return store.db.prepare(`SELECT m.source_date date,COUNT(*) messageCount,
    COALESCE(s.status,'pending') status,
    (SELECT COUNT(*) FROM feelings f WHERE f.thread_id=m.thread_id AND f.source_date=m.source_date) feelingCount,
    (SELECT COUNT(*) FROM features x WHERE x.thread_id=m.thread_id AND x.source_date=m.source_date) featureCount,
    s.updated_at updatedAt,s.error_message errorMessage
    FROM messages m LEFT JOIN mining_day_state s ON s.thread_id=m.thread_id AND s.source_date=m.source_date
    WHERE m.thread_id=? GROUP BY m.source_date ORDER BY m.source_date DESC`).all(threadId);
}

function miningDates(threadId) {
  const store=new MemoryStore({memoryDir:path.join(getThreadDir(threadId),"memory"),threadId});
  try{return miningDatesFromStore(store,threadId);}
  finally{store.close();}
}

function miningCommandArgs(threadId, date, mode) {
  return ["mine","--thread",threadId,"--date",date,mode==="api"?"--api":"--subagent"];
}

function targetedMiningCommandArgs(threadId, mode, batchFile) {
  return ["mine","--thread",threadId,"--targeted","--batch-file",batchFile,mode==="api"?"--api":"--subagent"];
}

function timelineCommandArgs(threadId, terms, { from = "", to = "" } = {}) {
  const cleaned = [...new Set((terms || []).map(term => String(term).trim()).filter(Boolean))];
  if (cleaned.length < 1 || cleaned.length > 3) throw new Error("时间轴每次请选择 1～3 个关键词");
  if (cleaned.some(term => term.length > 64)) throw new Error("时间轴关键词过长");
  const validDate = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!validDate(from) || !validDate(to)) throw new Error("时间范围格式无效");
  if (from && to && from > to) throw new Error("开始日期不能晚于结束日期");
  const args = ["term-timeline", "--thread", threadId, "--terms", cleaned.join(","), "--json"];
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
  return {
    threadId: data.threadId,
    report: (data.report || []).map(row => ({
      term: row.term, normalizedTerm: row.normalizedTerm, categories: row.categories || [],
      categorySupport: row.categorySupport || {}, from: row.from, to: row.to,
      messageCount: row.messageCount, occurrenceCount: row.occurrenceCount, activeDays: row.activeDays,
      firstSeen: row.firstSeen, lastSeen: row.lastSeen, baseline: row.baseline,
      timeline: row.timeline || [], feelings: row.feelings || [],
    })),
    intersections: (data.intersections || []).map(row => ({
      terms: row.terms || [],
      sameDayCount: row.sameDays?.length || 0,
      sameMessageCount: row.sameMessages?.length || 0,
      sameFeelingCount: row.sameFeelings?.length || 0,
    })),
    relation: {
      terms: (data.relation?.terms || []).map(row => ({
        term: row.term, normalizedTerm: row.normalizedTerm, state: row.state,
        shape: row.shape, confidence: row.confidence, reasons: row.reasons || [],
        signature: row.signature ? {
          term: row.signature.term, normalizedTerm: row.signature.normalizedTerm,
          sameFeelings: row.signature.sameFeelings, sameDays: row.signature.sameDays,
          strength: row.signature.strength,
        } : null,
      })),
      pairs: (data.relation?.pairs || []).map(row => ({
        terms: row.terms || [], normalizedTerms: row.normalizedTerms || [],
        state: row.state, shape: row.shape, evidence: row.evidence || {},
      })),
    },
    work: {
      groups: (data.work?.groups || []).map(row => ({
        id: row.id, state: row.state, shape: row.shape, firstSeen: row.firstSeen,
        lastSeen: row.lastSeen, members: (row.members || []).map(member => ({
          term: member.term, normalizedTerm: member.normalizedTerm,
        })),
      })),
    },
  };
}

async function executeMiningJob(job) {
  job.status="running";job.startedAt=new Date().toISOString();
  for(const date of job.dates){
    job.currentDate=date;job.updatedAt=new Date().toISOString();
    try{await runStmemAsync(miningCommandArgs(job.threadId,date,job.mode));job.results.push({date,status:"completed"});}
    catch(error){job.results.push({date,status:"failed",error:String(error.message||error).slice(0,500)});}
    job.completed=job.results.length;
  }
  job.currentDate=null;job.status=job.results.some(row=>row.status==="failed")?"completed_with_errors":"completed";job.completedAt=new Date().toISOString();job.updatedAt=job.completedAt;
}

function publicThreadSettings(threadId) {
  const config = loadConfig(), entry = config[threadId];
  if (!entry) throw new Error(`记忆体不存在：${threadId}`);
  return {
    threadId, libraryName: entry.label || threadId, ai: entry.ai || "", user: entry.user || "",
    userGender: entry.userGender || "unspecified", runtime: entry.runtime || "claude", purpose: entry.purpose || "accompany",
    sessionDir: entry.sessionDir || "", minerMode: entry.minerMode || "subagent", apiProvider: entry.apiProvider || "",
    baseUrl: entry.apiProvider ? (config.apiKeys?.[entry.apiProvider]?.baseUrl || "") : "",
    apiKey: entry.apiProvider ? (config.apiKeys?.[entry.apiProvider]?.key || "") : "",
    hasApiKey: !!(entry.apiProvider && config.apiKeys?.[entry.apiProvider]?.key),
    windowDays: entry.windowDays ?? 3, keepToolPairs: entry.keepToolPairs ?? 30,
    contextWindowTokens: entry.contextWindowTokens || null,
    automaticFullMining: entry.automaticFullMining !== false,
    automaticMemoryMaintenance: entry.automaticMemoryMaintenance !== false,
  };
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function error(res, status, message) { json(res, status, { error: message }); }

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
  const validRows = source.records.filter(record => record.message).map((record, index) => ({
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
  return listThreadIds().map(threadId => {
    const tc = config[threadId] || {};
    const memoryDir = path.join(getThreadDir(threadId), "memory");
    const store = new MemoryStore({ memoryDir, threadId });
    try {
      const counts = store.db.prepare(`SELECT
        (SELECT COUNT(*) FROM messages WHERE thread_id=?) messages,
        (SELECT COUNT(*) FROM feelings WHERE thread_id=?) feelings,
        (SELECT COUNT(*) FROM features WHERE thread_id=?) features,
        (SELECT COUNT(*) FROM feelings WHERE thread_id=? AND summary_mode='coarse') coarse,
        (SELECT COUNT(*) FROM feelings WHERE thread_id=? AND summary_mode='hidden') hidden`).get(threadId, threadId, threadId, threadId, threadId);
      const latest = store.db.prepare("SELECT MAX(completed_at) completedAt FROM mining_day_state WHERE thread_id=? AND status='completed'").get(threadId);
      return {
        threadId, libraryName: tc.label || threadId, runtime: tc.runtime || "claude", purpose: tc.purpose || "accompany",
        ai: tc.ai || "", user: tc.user || "", counts, lastMinedAt: latest?.completedAt || null,
        automaticFullMining: tc.automaticFullMining !== false,
        automaticMemoryMaintenance: tc.automaticMemoryMaintenance !== false,
      };
    } finally { store.close(); }
  });
}

function overview(threadId) {
  const library = listLibraries().find(item => item.threadId === threadId);
  if (!library) return null;
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
  try {
    const recent = store.db.prepare(`SELECT id,source_date sourceDate,event_time eventTime,content,importance,summary_mode summaryMode
      FROM feelings WHERE thread_id=? ORDER BY source_date DESC,COALESCE(event_time,'') DESC,order_key DESC LIMIT 5`).all(threadId);
    const daily = store.db.prepare("SELECT COUNT(*) count FROM feelings WHERE thread_id=? AND summary_mode='daily'").get(threadId).count;
    const failed = store.db.prepare("SELECT COUNT(*) count FROM mining_day_state WHERE thread_id=? AND status='failed'").get(threadId).count;
    const rebuild=latestSuccessfulRebuild(threadId), file=sessionFile(threadId,library.runtime);
    const rawUsage=readRebuildState(threadId).contextUsage||null, configuredMax=Number(loadConfig()[threadId]?.contextWindowTokens);
    const contextUsage=rawUsage?{...rawUsage,maxTokens:configuredMax>0?configuredMax:rawUsage.detectedMaxTokens||null}:null;
    if(contextUsage?.maxTokens)contextUsage.percent=contextUsage.usedTokens/contextUsage.maxTokens*100;
    const pendingMiningDays=store.db.prepare(`SELECT COUNT(DISTINCT m.source_date) count FROM messages m LEFT JOIN mining_day_state s ON s.thread_id=m.thread_id AND s.source_date=m.source_date AND s.status IN ('completed','completed_empty') WHERE m.thread_id=? AND s.source_date IS NULL`).get(threadId).count;
    return { ...library, counts: { ...library.counts, daily }, recent, rebuild, contextUsage, threadFileFound:!!file, pendingMiningDays, attention: failed ? `${failed} 个日期挖掘失败` : null };
  } finally { store.close(); }
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, requested);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/libraries") return json(res, 200, { libraries: listLibraries() });

  if (req.method === "POST" && url.pathname === "/api/session-file/check") {
    const body = await readJson(req);
    const threadId = String(body.threadId || "").trim(), sessionDir = String(body.sessionDir || "").trim();
    if (!threadId || !sessionDir) throw new Error("请先填写绑定线程和线程文件搜索目录");
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
    if (req.method === "GET") return json(res, 200, publicThreadSettings(threadId));
    if (req.method === "PATCH") {
      const body = await readJson(req);
      const current = publicThreadSettings(threadId);
      const input = { ...current, ...body, threadId, runtime: current.runtime, purpose: current.purpose };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-config-"));
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, JSON.stringify(input), { encoding: "utf8", mode: 0o600 });
      try {
        runStmem(["init", "--thread", threadId, "--batch-file", file]);
        return json(res, 200, { success: true, config: publicThreadSettings(threadId) });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }

  const libraryMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)$/);
  if (req.method === "DELETE" && libraryMatch) {
    const threadId = decodeURIComponent(libraryMatch[1]);
    runStmem(["delete", "--thread", threadId]);
    return json(res, 200, { success: true, threadId });
  }

  const miningMatch=url.pathname.match(/^\/api\/libraries\/([^/]+)\/mining\/(status|start|day|targeted-messages|targeted)$/);
  if(miningMatch){
    const threadId=decodeURIComponent(miningMatch[1]);publicThreadSettings(threadId);
    if(req.method==="GET"&&miningMatch[2]==="status")return json(res,200,{job:miningJobs.get(threadId)||null,dates:miningDates(threadId)});
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
        const rows=store.db.prepare("SELECT timestamp,source_date sourceDate,role,text FROM messages WHERE thread_id=? AND source_date=? ORDER BY timestamp").all(threadId,date);
        const needle=search.toLocaleLowerCase();
        return json(res,200,{date,search,matchCount:needle?rows.filter(row=>row.text.toLocaleLowerCase().includes(needle)).length:0,
          rows:rows.map(row=>({...row,matched:!!needle&&row.text.toLocaleLowerCase().includes(needle)}))});
      }finally{store.close();}
    }
    if(req.method==="POST"&&miningMatch[2]==="targeted"){
      const body=await readJson(req),date=String(body.date||""),mode=body.mode==="api"?"api":body.mode==="subagent"?"subagent":null;
      const timestamps=[...new Set(Array.isArray(body.timestamps)?body.timestamps.map(String):[])];
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error("日期格式无效");
      if(!mode)throw new Error("请选择 API 或 Subagent 挖掘通道");
      if(!timestamps.length)throw new Error("请至少选择一条对话");
      const batchFile=path.join(os.tmpdir(),`stmem-targeted-${crypto.randomUUID()}.json`);
      fs.writeFileSync(batchFile,JSON.stringify({date,timestamps,instruction:String(body.instruction||"")}));
      try{
        const output=await runStmemAsync(targetedMiningCommandArgs(threadId,mode,batchFile));
        return json(res,200,{success:true,output});
      }finally{try{fs.unlinkSync(batchFile);}catch{}}
    }
    if(req.method==="POST"&&miningMatch[2]==="start"){
      const active=miningJobs.get(threadId);
      if(active&&["queued","running"].includes(active.status))return error(res,409,"这个记忆体正在挖掘，请等待当前任务完成");
      const body=await readJson(req),mode=body.mode==="api"?"api":body.mode==="subagent"?"subagent":null;
      if(!mode)throw new Error("请选择 API 或 Subagent 挖掘通道");
      const available=new Set(miningDates(threadId).map(row=>row.date));
      const dates=[...new Set(Array.isArray(body.dates)?body.dates.map(String):[])].filter(date=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&available.has(date)).sort();
      if(!dates.length)throw new Error("请至少选择一个有对话的日期");
      const now=new Date().toISOString(),job={id:crypto.randomUUID(),threadId,mode,dates,status:"queued",currentDate:null,completed:0,results:[],createdAt:now,updatedAt:now};
      miningJobs.set(threadId,job);
      executeMiningJob(job).catch(cause=>{job.status="failed";job.currentDate=null;job.error=String(cause.message||cause).slice(0,500);job.updatedAt=new Date().toISOString();});
      return json(res,202,{job});
    }
  }

  const memorySectionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/(rules|feelings|features)$/);
  if (memorySectionMatch) {
    const threadId = decodeURIComponent(memorySectionMatch[1]), section = memorySectionMatch[2];
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
    const threadId=decodeURIComponent(conversationsMatch[1]), store=new MemoryStore({memoryDir:path.join(getThreadDir(threadId),"memory"),threadId});
    try {
      const query=String(url.searchParams.get("search")||"").trim(), date=String(url.searchParams.get("date")||"").trim(), focus=String(url.searchParams.get("focus")||"").trim(), pageSize=20;
      const counts=store.db.prepare("SELECT source_date date,COUNT(*) count FROM messages WHERE thread_id=? GROUP BY source_date ORDER BY source_date ASC").all(threadId);
      const calendar=buildConversationCalendar(counts,url.searchParams.get("calendarPage"));
      if(query){const pattern=`%${query}%`,total=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND text LIKE ?").get(threadId,pattern).count,page=Math.max(1,Number(url.searchParams.get("page"))||1);const rows=store.db.prepare("SELECT timestamp,source_date sourceDate,role,text FROM messages WHERE thread_id=? AND text LIKE ? ORDER BY timestamp DESC LIMIT ? OFFSET ?").all(threadId,pattern,pageSize,(page-1)*pageSize);return json(res,200,{mode:"search",query,calendar,rows:{page,pageSize,total,totalPages:Math.max(1,Math.ceil(total/pageSize)),rows}});}
      if(date){const total=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND source_date=?").get(threadId,date).count;let page=Math.max(1,Number(url.searchParams.get("page"))||1);if(focus){const position=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND source_date=? AND timestamp<=?").get(threadId,date,focus).count;if(position)page=Math.ceil(position/pageSize);}const totalPages=Math.max(1,Math.ceil(total/pageSize));page=Math.min(page,totalPages);const rows=store.db.prepare("SELECT timestamp,source_date sourceDate,role,text FROM messages WHERE thread_id=? AND source_date=? ORDER BY timestamp ASC LIMIT ? OFFSET ?").all(threadId,date,pageSize,(page-1)*pageSize);return json(res,200,{mode:"date",date,focus,calendar,rows:{page,pageSize,total,totalPages,rows}});}
      return json(res,200,{mode:"calendar",calendar});
    } finally { store.close(); }
  }

  const timelineMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/timeline$/);
  if (req.method === "GET" && timelineMatch) {
    const threadId = decodeURIComponent(timelineMatch[1]);
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

  const feelingActionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/feelings\/(update|anchor)$/);
  if (req.method === "POST" && feelingActionMatch) {
    const threadId=decodeURIComponent(feelingActionMatch[1]), body=await readJson(req);
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-memory-")), file=path.join(dir,"input.json");
    fs.writeFileSync(file,JSON.stringify(body),{encoding:"utf8",mode:0o600});
    try { return json(res,200,JSON.parse(runStmem(["memory",feelingActionMatch[2],"--thread",threadId,"--batch-file",file]))); }
    finally { fs.rmSync(dir,{recursive:true,force:true}); }
  }

  const retainPreviewMatch=url.pathname.match(/^\/api\/libraries\/([^/]+)\/feelings\/retain-preview$/);
  if(req.method==="GET"&&retainPreviewMatch){
    const threadId=decodeURIComponent(retainPreviewMatch[1]),id=String(url.searchParams.get("id")||"");
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

  const rebuildMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/rebuild\/(preview|dry-run|apply|check|repair)$/);
  if (rebuildMatch) {
    const threadId = decodeURIComponent(rebuildMatch[1]), action = rebuildMatch[2];
    if (req.method === "GET" && action === "preview") {
      const windowDays = Math.max(1, Number(url.searchParams.get("windowDays")) || 3);
      const toolValue = url.searchParams.get("toolPairs");
      const toolPairs = Math.max(0, toolValue === null ? 30 : Number(toolValue));
      const preview = buildRebuildPreview(threadId, { windowDays, toolPairs });
      return json(res, 200, { ...preview, items: paginate(preview.items, url.searchParams.get("page")), tools: paginate(preview.tools, url.searchParams.get("toolPage")) });
    }
    if(req.method==="GET"&&action==="dry-run"){
      const windowDays=Math.max(1,Number(url.searchParams.get("windowDays"))||3),toolValue=url.searchParams.get("toolPairs"),toolPairs=Math.max(0,toolValue===null?30:Number(toolValue)),watermark=url.searchParams.get("watermark")==="true";
      const rebuildArgs=["rebuild","--thread",threadId,"--window",String(windowDays),"--tool-pairs",String(toolPairs)];
      if(watermark)rebuildArgs.push("--watermark");
      return json(res,200,parseRebuildDryRun(runStmem(rebuildArgs)));
    }
    if(req.method==="POST"&&action==="dry-run"){
      const body=await readJson(req),windowDays=Math.max(1,Number(body.windowDays)||3),toolPairs=Math.max(0,body.toolPairs===undefined?30:Number(body.toolPairs)),watermark=body.watermark===true;
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-rebuild-preview-")),planFile=path.join(dir,"plan.json");
      fs.writeFileSync(planFile,JSON.stringify({excludedMessages:body.excludedMessages||[],excludedTools:body.excludedTools||[]}),{encoding:"utf8",mode:0o600});
      const rebuildArgs=["rebuild","--thread",threadId,"--window",String(windowDays),"--tool-pairs",String(toolPairs),"--plan",planFile];
      if(watermark)rebuildArgs.push("--watermark");
      try{return json(res,200,parseRebuildDryRun(runStmem(rebuildArgs)));}
      finally{fs.rmSync(dir,{recursive:true,force:true});}
    }
    if (req.method === "GET" && action === "check") return json(res, 200, JSON.parse(runStmem(["rebuild", "--thread", threadId, "--check"])));
    if (req.method === "POST" && action === "repair") return json(res, 200, JSON.parse(runStmem(["rebuild", "--thread", threadId, "--repair"])));
    if (req.method === "POST" && action === "apply") {
      const body = await readJson(req);
      const planFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-plan-")), "plan.json");
      fs.writeFileSync(planFile, JSON.stringify({ excludedMessages: body.excludedMessages || [], excludedTools: body.excludedTools || [] }), "utf8");
      try {
        const requestedTools = body.toolPairs === undefined ? 30 : Number(body.toolPairs);
        const rebuildArgs=["rebuild", "--thread", threadId, "--window", String(Math.max(1, Number(body.windowDays) || 3)), "--tool-pairs", String(Math.max(0, requestedTools)), "--plan", planFile, "--trigger", "web", "--apply"];
        if(body.watermark===true)rebuildArgs.push("--watermark");
        const output = runStmem(rebuildArgs);
        const integrity = JSON.parse(runStmem(["rebuild", "--thread", threadId, "--check"]));
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
      imported.imported+=item.source.preview.valid;imported.fullBacked+=item.source.preview.valid;imported.files++;
      fs.rmSync(path.dirname(item.filePath),{recursive:true,force:true});previews.delete(token);
    }
    return json(res,200,imported);
  }

  if (req.method === "POST" && url.pathname === "/api/libraries") {
    const input = await readJson(req);
    const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-init-"));
    const initFile = path.join(initDir, "init.json");
    fs.writeFileSync(initFile, JSON.stringify(input), { encoding: "utf8", mode: 0o600 });
    try { runStmem(["init", "--thread", input.threadId, "--batch-file", initFile]); }
    finally { fs.rmSync(initDir, { recursive: true, force: true }); }
    const createdConfig = loadConfig()[input.threadId];
    if (!createdConfig) throw new Error("init 返回成功但没有生成线程配置");
    const created = { threadId: input.threadId, ...createdConfig };
    const imported = { imported: 0, fullBacked: 0, files: 0 };
    try {
      for (const token of input.importTokens || []) {
        const item = previews.get(token);
        if (!item) throw new Error("有一个导入预览已经过期，请重新上传");
        runStmem(["import", "--thread", created.threadId, "--source", item.filePath, "--apply"]);
        imported.imported += item.source.preview.valid;
        imported.fullBacked += item.source.preview.valid;
        imported.files++;
        fs.rmSync(path.dirname(item.filePath), { recursive: true, force: true });
        previews.delete(token);
      }
      return json(res, 201, { library: created, imported });
    } catch (cause) { throw cause; }
  }

  return error(res, 404, "接口不存在");
}

function cleanupPreviews() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [token, item] of previews) if (item.createdAt < cutoff) {
    try { fs.rmSync(path.dirname(item.filePath), { recursive: true, force: true }); } catch {}
    previews.delete(token);
  }
}

function startWebServer({ host = "127.0.0.1", port = 4173 } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      if (serveStatic(req, res, url.pathname)) return;
      if (!path.extname(url.pathname)) return serveStatic(req, res, "/");
      error(res, 404, "页面不存在");
    } catch (cause) { error(res, 400, cause.message || "请求失败"); }
  });
  const timer = setInterval(cleanupPreviews, 10 * 60 * 1000);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { startWebServer, listLibraries, overview, previewRows, paginate, buildConversationCalendar, miningDatesFromStore, miningCommandArgs, targetedMiningCommandArgs, timelineCommandArgs, compactTimelineReport, compressionCommandArgs, runStmem };
