const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { publicThreadSettings } = require("../library-queries");
const { json, readJson, error } = require("../http-io");
const { refreshMiningBatchJob, miningDates, miningCheckCommandArgs, targetedMiningCommandArgs, executeMiningJob } = require("../mining");
const { miningJobs } = require("../state");
const { normalizeMiningApiProfile } = require("../../services/mining-api-profile");
const { runStmemAsync, runStmem } = require("../cli-client");
const { MemoryStore } = require("../../storage/memory-store");
const { getThreadDir } = require("../../config");
const { NOT_HANDLED } = require("../route-result");

async function handleMining(req, res, url) {
  const miningMatch=url.pathname.match(/^\/api\/libraries\/([^/]+)\/mining\/(status|start|stop|check|day|targeted-jobs|targeted-messages|targeted)$/);
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
        const { targetedMessageMatches } = require("../../services/targeted-mining-range");
        const result=targetedMessageMatches(rows,{search,startTime:url.searchParams.get("startTime")||"",endTime:url.searchParams.get("endTime")||""});
        return json(res,200,{date,search,...result});
      }finally{store.close();}
    }
    if(req.method==="GET"&&miningMatch[2]==="targeted-jobs"){
      const store=new MemoryStore({memoryDir:path.join(getThreadDir(threadId),"memory"),threadId});
      try {const jobs=require("../../services/targeted-mining-jobs");return json(res,200,{jobs:jobs.list(store,String(url.searchParams.get("date")||""))});}finally{store.close();}
    }
    if(req.method==="POST"&&miningMatch[2]==="targeted"){
      const body=await readJson(req),date=String(body.date||""),mode=body.mode==="api"?"api":body.mode==="subagent"?"subagent":null,apiProfile=normalizeMiningApiProfile(body.apiProfile);
      const timestamps=[...new Set(Array.isArray(body.timestamps)?body.timestamps.map(String):[])];
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error("日期格式无效");
      if(!mode)throw new Error("请选择 API 或 Subagent 挖掘通道");
      if(!timestamps.length)throw new Error("请至少选择一条对话");
      const batchFile=path.join(os.tmpdir(),`stmem-targeted-${crypto.randomUUID()}.json`);
      fs.writeFileSync(batchFile,JSON.stringify({date,timestamps,mode,apiProfile,instruction:String(body.instruction||"")}),{mode:0o600});
      try{
        const output=await runStmemAsync(["mine","--memory",threadId,"--targeted-enqueue","--batch-file",batchFile]);
        return json(res,202,{success:true,...JSON.parse(output)});
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
      const now=new Date().toISOString(),job={id:crypto.randomUUID(),threadId,mode,apiProfile,dates,forceDates,overwriteProtected:body.overwriteProtected===true,removeAnchors:body.removeAnchors===true,status:"queued",currentDate:null,completed:0,results:[],cancelRequested:false,createdAt:now,updatedAt:now};
      miningJobs.set(threadId,job);
      executeMiningJob(job).catch(cause=>{job.status="failed";job.currentDate=null;job.error=String(cause.message||cause).slice(0,500);job.updatedAt=new Date().toISOString();});
      return json(res,202,{job});
    }
  }
  return NOT_HANDLED;
}

module.exports = { handleMining };
