const path = require("path");
const { MemoryStore } = require("../storage/memory-store");
const { getThreadDir } = require("../config");
const { normalizeMiningApiProfile } = require("../services/mining-api-profile");
const { writePrivateBatch, runStmemAsync, parseStmemJson } = require("./cli-client");
const { MiningReviewBatchStore } = require("../services/mining-review-batch");

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

async function executeMiningJob(job) {
  job.status="running";job.startedAt=new Date().toISOString();
  if(job.dates.length>1&&!job.overwriteProtected){
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
    try{await runStmemAsync(miningCommandArgs(job.threadId,date,job.mode,job.forceDates.includes(date),job.apiProfile).concat(job.overwriteProtected?["--force","--overwrite-protected",...(job.removeAnchors?["--remove-anchors"]:[])]:[]));job.results.push({date,status:"completed"});}
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

module.exports = { miningDatesFromStore, safeJsonArray, miningDates, miningCommandArgs, miningCheckCommandArgs, targetedMiningCommandArgs, executeMiningJob, refreshMiningBatchJob };
