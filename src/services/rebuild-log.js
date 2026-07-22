const fs = require("fs");
const path = require("path");
const { getThreadDir } = require("../config");

function stateFile(threadId) {
  return path.join(getThreadDir(threadId), "logs", "rebuild-state.json");
}

function readRebuildState(threadId) {
  try { return JSON.parse(fs.readFileSync(stateFile(threadId), "utf8")); }
  catch { return {}; }
}

function writeState(threadId, state) {
  const file = stateFile(threadId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temporary, file);
  return state;
}

function appendRebuildLog(threadId, record) {
  const row={completedAt:new Date().toISOString(),threadId,...record};
  const state=readRebuildState(threadId);
  if(row.status==="completed") {
    state.lastCompleted=row;
    delete state.pendingReplace;
  } else if(row.status==="pending_replace") state.pendingReplace=row;
  state.updatedAt=new Date().toISOString();
  writeState(threadId,state);
  return row;
}
function latestSuccessfulRebuild(threadId) {
  const current=readRebuildState(threadId);
  if(current.lastCompleted?.status==="completed") return current.lastCompleted;
  // 兼容旧版本的追加日志；新版本不再继续写入它。
  const file=path.join(getThreadDir(threadId),"logs","rebuild.jsonl");let latest=null;
  try{for(const line of fs.readFileSync(file,"utf8").split("\n").filter(Boolean)){const row=JSON.parse(line);if(row.status==="completed")latest=row;}}catch{}
  return latest;
}
function updateContextUsage(threadId, usage) {
  const state=readRebuildState(threadId);
  state.contextUsage={...usage,updatedAt:new Date().toISOString()};
  state.updatedAt=state.contextUsage.updatedAt;
  writeState(threadId,state);
  return state.contextUsage;
}
module.exports={appendRebuildLog,latestSuccessfulRebuild,readRebuildState,updateContextUsage,stateFile};
