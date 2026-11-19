const crypto=require('crypto');
function payloadFor(input){
 const date=String(input.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('日期格式无效');
 const timestamps=[...new Set((input.timestamps||[]).map(String))].sort();if(!timestamps.length)throw new Error('请至少选择一条对话');
 if(!['api','subagent'].includes(input.mode))throw new Error('请选择挖掘通道');
 return {date,timestamps,mode:input.mode,apiProfile:input.apiProfile==='raw'?'raw':'optimized',instruction:String(input.instruction||'')};
}
function enqueue(store,input){
 const payload=payloadFor(input),fingerprint=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 return store.db.transaction(()=>{
  const existing=store.db.prepare("SELECT * FROM mining_jobs WHERE thread_id=? AND mode='targeted' AND trigger_type='web' ORDER BY created_at DESC").all(store.threadId).find(row=>{
   try{if(interrupted(row)){store.updateJob(row.id,{status:'failed',errorCode:'TASK_INTERRUPTED',errorMessage:'后台进程已退出，请重新提交'});return false;}return JSON.parse(row.instruction).fingerprint===fingerprint&&['queued','running','completed'].includes(row.status);}catch{return false;}
  });
  if(existing)return {job:existing,created:false};
  const instruction=JSON.stringify({kind:'targeted-web-v1',fingerprint,payload});
  const created=store.createJob({sourceDate:payload.date,mode:'targeted',triggerType:'web',publishStrategy:'append',instruction});
  return {job:store.getJob(created.id),created:true};
 }).immediate();
}
function list(store,date){return store.db.prepare("SELECT * FROM mining_jobs WHERE thread_id=? AND source_date=? AND mode='targeted' AND trigger_type='web' ORDER BY created_at DESC LIMIT 20").all(store.threadId,date).map(publicJob);}
function interrupted(row){
 if(!['queued','running'].includes(row.status))return false;
 const meta=JSON.parse(row.instruction||'{}');
 if(meta.kind!=='targeted-web-v1')return false;
 if(!meta.pid)return Date.now()-Date.parse(row.created_at)>60000;
 try{process.kill(meta.pid,0);return false;}catch(error){return error.code==='ESRCH';}
}
function publicJob(row){if(interrupted(row))row={...row,status:'failed',error_code:'TASK_INTERRUPTED',error_message:'后台进程已退出，请重新提交'};return {id:row.id,date:row.source_date,status:row.status,feelingCount:row.feeling_count,errorCode:row.error_code,error:row.error_message,createdAt:row.created_at};}
module.exports={enqueue,list,publicJob,payloadFor};
