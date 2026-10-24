const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { safeFileName, readBody, json, error, readJson } = require("../http-io");
const { MAX_UPLOAD } = require("../paths");
const { readImportSource } = require("../../services/import-source");
const { previews } = require("../state");
const { previewRows } = require("../view-models");
const { publicThreadSettings } = require("../library-queries");
const { runStmem } = require("../cli-client");
const { loadConfig, getThreadDir } = require("../../config");
const { MemoryStore } = require("../../storage/memory-store");
const { NOT_HANDLED } = require("../route-result");

async function handleImports(req, res, url) {
  const libraryImportMatch=url.pathname.match(/^\/api\/libraries\/([^/]+)\/imports$/);
  const libraryImportAgainMatch=url.pathname.match(/^\/api\/libraries\/([^/]+)\/imports\/([^/]+)\/reimport$/);
  const libraryImportRevertMatch=url.pathname.match(/^\/api\/libraries\/([^/]+)\/imports\/([^/]+)\/revert$/);
  if(req.method==="POST"&&libraryImportAgainMatch){
    const threadId=decodeURIComponent(libraryImportAgainMatch[1]),batchId=decodeURIComponent(libraryImportAgainMatch[2]);
    publicThreadSettings(threadId);
    return json(res,200,JSON.parse(runStmem(["import","--memory",threadId,"--reimport",batchId,"--apply","--json"])));
  }
  if(req.method==="POST"&&libraryImportRevertMatch){
    const threadId=decodeURIComponent(libraryImportRevertMatch[1]),batchId=decodeURIComponent(libraryImportRevertMatch[2]);
    publicThreadSettings(threadId);
    const input=await readJson(req),args=["import","--memory",threadId,"--revert",batchId,"--json"];
    if(input.apply===true)args.push("--apply");
    return json(res,200,JSON.parse(runStmem(args)));
  }
  if (req.method === "GET" && libraryImportMatch) {
    const threadId=decodeURIComponent(libraryImportMatch[1]);
    publicThreadSettings(threadId);
    const batches=(JSON.parse(runStmem(["import","--memory",threadId,"--list","--json"])).batches||[]).map(({sourcePath,...batch})=>batch);
    const store=new MemoryStore({memoryDir:path.join(getThreadDir(threadId),"memory"),threadId,readonly:true});
    try {
      if(!store.db)return json(res,200,{messages:0,dates:0,firstDate:null,lastDate:null,sources:[],batches});
      const totals=store.db.prepare("SELECT COUNT(*) messages,COUNT(DISTINCT source_date) dates,MIN(source_date) firstDate,MAX(source_date) lastDate FROM messages WHERE thread_id=?").get(threadId);
      const sources=store.db.prepare(`SELECT COALESCE(source,'unknown') source,COUNT(*) messages,
        MIN(source_date) firstDate,MAX(source_date) lastDate,MAX(created_at) lastImportedAt
        FROM messages WHERE thread_id=? GROUP BY COALESCE(source,'unknown') ORDER BY messages DESC,source`).all(threadId);
      return json(res,200,{...totals,sources,batches});
    } finally { store.close(); }
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

  if(req.method==="POST"&&libraryImportMatch){
    const threadId=decodeURIComponent(libraryImportMatch[1]);publicThreadSettings(threadId);
    const input=await readJson(req),tokens=[...new Set(Array.isArray(input.importTokens)?input.importTokens.map(String):[])];
    if(!tokens.length)throw new Error("请先上传并确认至少一个对话文件");
    const items=tokens.map(token=>({token,item:previews.get(token)}));
    if(items.some(row=>!row.item))throw new Error("有一个导入预览已经过期，请重新上传");
    const imported={imported:0,fullBacked:0,files:0,batches:[]};
    for(const {token,item} of items){
      const applied=JSON.parse(runStmem(["import","--memory",threadId,"--source",item.filePath,"--apply","--json"]));
      imported.imported+=applied.imported||0;imported.fullBacked+=applied.fullBacked||0;imported.files++;imported.batches.push(...(applied.results||[]));
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
        imported.fullBacked += item.source.preview.valid + (item.source.preview.filtered || 0);
        imported.files++;
        fs.rmSync(path.dirname(item.filePath), { recursive: true, force: true });
        previews.delete(token);
      }
      return json(res, 201, { library: created, imported });
    } catch (cause) { throw cause; }
  }
  return NOT_HANDLED;
}

module.exports = { handleImports };
