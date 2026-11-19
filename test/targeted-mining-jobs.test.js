const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {MemoryStore}=require('../src/storage/memory-store');const {MemoryMiner}=require('../src/services/memory-miner');const jobs=require('../src/services/targeted-mining-jobs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stmem-target-job-'));const miner=new MemoryMiner({memoryDir:dir,threadId:'fixture',deepseekConfig:{},personaConfig:{purpose:'accompany'}});t.after(()=>{miner.store.close();fs.rmSync(dir,{recursive:true,force:true});});return miner;}
const payload={date:'2026-11-19',timestamps:['2026-11-19T01:00:00Z'],mode:'api'};
test('enqueue deduplicates selection; completed job and count survive reopening',async t=>{
 const miner=fixture(t),store=miner.store;
 const first=jobs.enqueue(store,payload),second=jobs.enqueue(store,payload);assert.equal(first.job.id,second.job.id);assert.equal(second.created,false);
 miner._extractViaSubagent=async()=>[{content:'11月19日，上午九点。测试',importance:3}];
 await miner.mineTargeted(payload.date,[{timestamp:payload.timestamps[0],text:'材料'}],{jobId:first.job.id});
 const reopened=new MemoryStore({memoryDir:miner.memoryDir,threadId:'fixture'});t.after(()=>reopened.close());
 assert.equal(jobs.list(reopened,payload.date)[0].status,'completed');assert.equal(jobs.list(reopened,payload.date)[0].feelingCount,1);
 assert.equal(jobs.enqueue(reopened,payload).created,false);
});
test('empty model output completes task with zero additions',async t=>{
 const miner=fixture(t),job=jobs.enqueue(miner.store,payload).job;miner._extractViaSubagent=async()=>[];
 await miner.mineTargeted(payload.date,[{text:'材料'}],{jobId:job.id});assert.equal(miner.store.getJob(job.id).status,'completed');assert.equal(miner.store.getJob(job.id).feeling_count,0);
});
test('transaction rolls back appended summaries if completion update fails',async t=>{
 const miner=fixture(t),job=jobs.enqueue(miner.store,payload).job;
 miner._extractViaSubagent=async()=>[{content:'11月19日，上午九点。测试',importance:3}];
 const update=miner.store.updateJob.bind(miner.store);miner.store.updateJob=(id,patch)=>{if(patch.status==='completed')throw new Error('commit failure');return update(id,patch);};
 await assert.rejects(()=>miner.mineTargeted(payload.date,[{text:'材料'}],{jobId:job.id}),/commit failure/);
 assert.equal(miner.store.listFeelings({date:payload.date}).length,0);assert.equal(miner.store.getJob(job.id).status,'failed');
 assert.equal(jobs.enqueue(miner.store,payload).created,true);
});
