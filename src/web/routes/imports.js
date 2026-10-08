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
const { loadConfig } = require("../../config");
const { NOT_HANDLED } = require("../route-result");

async function handleImports(req, res, url) {
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
    if (input.mode === "replace-matching") {
      const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-import-manifest-"));
      const manifest = path.join(manifestDir, "sources.json");
      fs.writeFileSync(manifest, JSON.stringify(items.map(row => row.item.filePath)), { mode: 0o600 });
      try {
        const args = ["import", "--memory", threadId, "--sources-file", manifest, "--replace-matching"];
        const preview = !input.confirmedPlan;
        const result = JSON.parse(runStmem(preview ? [...args, "--dry-run"] : [...args, "--expect-hash", String(input.confirmedPlan), "--apply"]));
        if (!preview) for (const { token, item } of items) { fs.rmSync(path.dirname(item.filePath), { recursive: true, force: true }); previews.delete(token); }
        const { backupFile, ...safeResult } = result;
        return json(res, 200, { ...safeResult, backedUp: !!backupFile });
      } finally { fs.rmSync(manifestDir, { recursive: true, force: true }); }
    }
    if (input.mode && input.mode !== "append") throw new Error("未知导入方式");
    const imported={imported:0,fullBacked:0,files:0};
    for(const {token,item} of items){
      runStmem(["import","--thread",threadId,"--source",item.filePath,"--apply"]);
      imported.imported+=item.source.preview.valid;imported.fullBacked+=item.source.preview.valid+(item.source.preview.filtered||0);imported.files++;
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
