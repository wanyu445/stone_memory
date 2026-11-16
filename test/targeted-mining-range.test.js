const test=require('node:test');const assert=require('node:assert/strict');
const {targetedMessageMatches:match}=require('../src/services/targeted-mining-range');
const rows=['2026-11-15T20:59:59Z','2026-11-15T21:00:00Z','2026-11-15T21:00:00Z','2026-11-15T22:00:00Z'].map(timestamp=>({timestamp,text:'对话'}));
test('Beijing half-open range keeps all simultaneous messages',()=>{
 assert.equal(match(rows,{startTime:'05:00',endTime:'06:00'}).matchCount,2);
 assert.equal(match(rows,{startTime:'05:00'}).matchCount,3);
 assert.equal(match(rows,{endTime:'05:00'}).matchCount,1);
 assert.equal(match(rows,{search:'没有',startTime:'05:00'}).matchCount,0);
 assert.equal(match(rows).matchCount,4);
 assert.throws(()=>match(rows,{startTime:'06:00',endTime:'05:00'}));
 assert.throws(()=>match(rows,{startTime:'25:00'}));
});
test('multi-date overwrite dispatches each date with explicit CLI flags and continues after failure',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const file=path.resolve(__dirname,'../src/web/mining.js');const realRequire=require('node:module').createRequire(file);const calls=[];
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:name=>name==='./cli-client'?{runStmemAsync:async args=>{calls.push(args);if(calls.length===1)throw new Error('failure');}}:realRequire(name)});
 const job={threadId:'fixture',dates:['2026-11-14','2026-11-15'],forceDates:[],mode:'api',apiProfile:'optimized',overwriteProtected:true,removeAnchors:true,results:[]};
 await module.exports.executeMiningJob(job);
 assert.equal(calls.length,2);
 for(let i=0;i<2;i++){assert.equal(calls[i][calls[i].indexOf('--date')+1],job.dates[i]);for(const flag of ['--force','--overwrite-protected','--remove-anchors'])assert.ok(calls[i].includes(flag));}
 assert.equal(job.results[0].status,'failed');assert.equal(job.results[1].status,'completed');
});
