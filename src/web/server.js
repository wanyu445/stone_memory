const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { URL } = require("url");
const { loadConfig, listThreadIds, getThreadDir } = require("../config");
const { readImportSource } = require("../services/import-source");
const { MemoryStore } = require("../storage/memory-store");
const { buildRebuildPreview } = require("../services/rebuild-workbench");
const { findThreadSessionFile } = require("../lib/thread-session-file");
const { listRules } = require("../services/rule-store");
const { latestSuccessfulRebuild, readRebuildState } = require("../services/rebuild-log");
const { sessionFile } = require("../services/rebuild-workbench");

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_UPLOAD = 512 * 1024 * 1024;
const previews = new Map();
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const STMEM_BIN = path.join(PROJECT_ROOT, "bin", "stmem");

function runStmem(args, { timeout = 10 * 60 * 1000 } = {}) {
  const result = spawnSync(process.execPath, [STMEM_BIN, ...args], { cwd: PROJECT_ROOT, encoding: "utf8", timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `stmem ${args[0]} 失败`).trim());
  return (result.stdout || "").trim();
}

function publicThreadSettings(threadId) {
  const config = loadConfig(), entry = config[threadId];
  if (!entry) throw new Error(`记忆库不存在：${threadId}`);
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
    if (!threadId || !sessionDir) throw new Error("请先填写对应线程名和线程文件搜索目录");
    const file = findThreadSessionFile(sessionDir, threadId);
    if (!file) throw new Error(`在这个目录中没有找到线程 ${threadId} 的 JSONL 文件，请重新填写路径或检查文件是否存在`);
    return json(res, 200, { found: true, file });
  }

  const overviewMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/overview$/);
  if (req.method === "GET" && overviewMatch) {
    const data = overview(decodeURIComponent(overviewMatch[1]));
    return data ? json(res, 200, data) : error(res, 404, "记忆库不存在");
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

  const memorySectionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/(rules|feelings|features)$/);
  if (memorySectionMatch) {
    const threadId = decodeURIComponent(memorySectionMatch[1]), section = memorySectionMatch[2];
    if (req.method === "GET" && section === "rules") return json(res, 200, { rows: listRules(threadId) });
    if (req.method === "GET" && ["feelings", "features"].includes(section)) {
      const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
      try {
        const search = String(url.searchParams.get("search") || "").toLowerCase();
        const category = String(url.searchParams.get("category") || "");
        let rows = section === "feelings" ? store.listFeelings().reverse() : store.listFeatures().reverse();
        if (section === "feelings") { let anchors={retain:{},eventAnchors:{}}; try{anchors={...anchors,...JSON.parse(fs.readFileSync(path.join(getThreadDir(threadId),"memory","retain-config.json"),"utf8"))};}catch{} rows=rows.map(row=>({...row,retainAnchor:!!anchors.retain?.[row.id],eventAnchor:!!anchors.eventAnchors?.[row.id]})); }
        if (search) rows = rows.filter(row => String(row.content || "").toLowerCase().includes(search) || String(row.coarse_summary || "").toLowerCase().includes(search));
        if (category && section === "features") rows = rows.filter(row => row.category === category);
        if (section === "feelings" && url.searchParams.get("mode")) rows=rows.filter(row=>row.summary_mode===url.searchParams.get("mode"));
        if (section === "feelings" && url.searchParams.get("importance")) rows=rows.filter(row=>String(row.importance)===url.searchParams.get("importance"));
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
      const dates=store.db.prepare("SELECT source_date date,COUNT(*) count FROM messages WHERE thread_id=? GROUP BY source_date ORDER BY source_date DESC").all(threadId);
      if(query){const pattern=`%${query}%`,total=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND text LIKE ?").get(threadId,pattern).count,page=Math.max(1,Number(url.searchParams.get("page"))||1);const rows=store.db.prepare("SELECT timestamp,source_date sourceDate,role,text FROM messages WHERE thread_id=? AND text LIKE ? ORDER BY timestamp DESC LIMIT ? OFFSET ?").all(threadId,pattern,pageSize,(page-1)*pageSize);return json(res,200,{mode:"search",query,dates,rows:{page,pageSize,total,totalPages:Math.max(1,Math.ceil(total/pageSize)),rows}});}
      if(date){const total=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND source_date=?").get(threadId,date).count;let page=Math.max(1,Number(url.searchParams.get("page"))||1);if(focus){const position=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND source_date=? AND timestamp<=?").get(threadId,date,focus).count;if(position)page=Math.ceil(position/pageSize);}const totalPages=Math.max(1,Math.ceil(total/pageSize));page=Math.min(page,totalPages);const rows=store.db.prepare("SELECT timestamp,source_date sourceDate,role,text FROM messages WHERE thread_id=? AND source_date=? ORDER BY timestamp ASC LIMIT ? OFFSET ?").all(threadId,date,pageSize,(page-1)*pageSize);return json(res,200,{mode:"date",date,focus,dates,rows:{page,pageSize,total,totalPages,rows}});}
      return json(res,200,{mode:"dates",dates});
    } finally { store.close(); }
  }

  const feelingActionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/feelings\/(update|anchor)$/);
  if (req.method === "POST" && feelingActionMatch) {
    const threadId=decodeURIComponent(feelingActionMatch[1]), body=await readJson(req);
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-memory-")), file=path.join(dir,"input.json");
    fs.writeFileSync(file,JSON.stringify(body),{encoding:"utf8",mode:0o600});
    try { return json(res,200,JSON.parse(runStmem(["memory",feelingActionMatch[2],"--thread",threadId,"--batch-file",file]))); }
    finally { fs.rmSync(dir,{recursive:true,force:true}); }
  }

  const ruleActionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/rules\/([^/]+)\/(enable|disable)$/);
  if (req.method === "POST" && ruleActionMatch) { runStmem(["rules", ruleActionMatch[3], "--thread", decodeURIComponent(ruleActionMatch[1]), "--name", decodeURIComponent(ruleActionMatch[2])]); return json(res, 200, { success: true }); }
  const ruleDeleteMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/rules\/([^/]+)$/);
  if (req.method === "DELETE" && ruleDeleteMatch) { runStmem(["rules", "delete", "--thread", decodeURIComponent(ruleDeleteMatch[1]), "--name", decodeURIComponent(ruleDeleteMatch[2])]); return json(res, 200, { success: true }); }

  const rebuildMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/rebuild\/(preview|apply|check|repair)$/);
  if (rebuildMatch) {
    const threadId = decodeURIComponent(rebuildMatch[1]), action = rebuildMatch[2];
    if (req.method === "GET" && action === "preview") {
      const windowDays = Math.max(1, Number(url.searchParams.get("windowDays")) || 3);
      const toolValue = url.searchParams.get("toolPairs");
      const toolPairs = Math.max(0, toolValue === null ? 30 : Number(toolValue));
      const preview = buildRebuildPreview(threadId, { windowDays, toolPairs });
      return json(res, 200, { ...preview, items: paginate(preview.items, url.searchParams.get("page")), tools: paginate(preview.tools, url.searchParams.get("toolPage")) });
    }
    if (req.method === "GET" && action === "check") return json(res, 200, JSON.parse(runStmem(["rebuild", "--thread", threadId, "--check"])));
    if (req.method === "POST" && action === "repair") return json(res, 200, JSON.parse(runStmem(["rebuild", "--thread", threadId, "--repair"])));
    if (req.method === "POST" && action === "apply") {
      const body = await readJson(req);
      const planFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-plan-")), "plan.json");
      fs.writeFileSync(planFile, JSON.stringify({ excludedMessages: body.excludedMessages || [], excludedTools: body.excludedTools || [] }), "utf8");
      try {
        const requestedTools = body.toolPairs === undefined ? 30 : Number(body.toolPairs);
        const output = runStmem(["rebuild", "--thread", threadId, "--window", String(Math.max(1, Number(body.windowDays) || 3)), "--tool-pairs", String(Math.max(0, requestedTools)), "--plan", planFile, "--trigger", "web", "--apply"]);
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

module.exports = { startWebServer, listLibraries, overview, previewRows, paginate, runStmem };
