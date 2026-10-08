const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MemoryStore } = require('../src/storage/memory-store');
const { planMatchingReplacement, applyMatchingReplacement } = require('../src/services/import-matching-replacement');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sm-original-file-'));
  const store=new MemoryStore({memoryDir:dir,threadId:'synthetic-memory'});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const record=(text,day='2026-01-02',role='user')=>({raw:{content:text,timestamp:day+'T09:00:00+08:00',role},message:{text,timestamp:day+'T09:00:00+08:00',type:role}});
  const insert=(r,source='json')=>store.insertMessages([{text:r.message.text,role:r.message.type,timestamp:r.message.timestamp,sourceDate:r.message.timestamp.slice(0,10),source}]);
  return {store,record,insert};
}
test('explicit original file replaces edited prose and short messages without touching other imports',t=>{
  const {store,record,insert}=fixture(t);
  const old=[record('Old shortened prose'),record('OK','2026-01-02','assistant')];old.forEach(r=>insert(r));
  const unrelated=record('Old shortened prose','2026-01-03');insert(unrelated);
  const fresh=[record('Original complete prose with restored details','2026-01-01'),record('OK','2026-01-01','assistant')];fresh.forEach(r=>insert(r,'jsonl'));
  const originalBatch={records:old,format:'json'},batches=[{records:fresh,format:'jsonl'}];
  const plan=planMatchingReplacement(store,batches,{originalBatch});assert.equal(plan.replace,2);assert.equal(plan.add,0);assert.equal(plan.ambiguous,0);
  const result=applyMatchingReplacement(store,batches,{originalBatch,expectedHash:plan.expectedHash});assert.equal(result.replaced,2);assert.equal(result.imported,0);
  assert.equal(store.listMessages({date:'2026-01-02'}).length,0);assert.equal(store.listMessages({date:'2026-01-01'}).length,2);assert.equal(store.listMessages({date:'2026-01-03'}).length,1);
});
test('partially replaced files remove only their remaining exact rows',t=>{
  const {store,record,insert}=fixture(t);
  const old=[record('Already removed old message'),record('Remaining old message','2026-01-03')];insert(old[1]);
  const fresh=[record('Restored first message','2026-01-01'),record('Restored second message','2026-01-04')];fresh.forEach(r=>insert(r,'jsonl'));
  const originalBatch={records:old,format:'json'},batches=[{records:fresh,format:'jsonl'}];
  const plan=planMatchingReplacement(store,batches,{originalBatch});assert.equal(plan.replace,1);
  applyMatchingReplacement(store,batches,{originalBatch,expectedHash:plan.expectedHash});
  assert.equal(store.listMessages({date:'2026-01-03'}).length,0);
  assert.throws(()=>planMatchingReplacement(store,batches,{originalBatch}),/已无现存/);
});
test('unchanged timestamp/content is retained through formal ingest when it belongs to the selected old file',t=>{
  const {store,record,insert}=fixture(t);const same=record('Unchanged record');insert(same);
  const originalBatch={records:[same],format:'json'},batches=[{records:[same],format:'jsonl'}];
  const plan=planMatchingReplacement(store,batches,{originalBatch});assert.equal(plan.add,1);
  const result=applyMatchingReplacement(store,batches,{originalBatch,expectedHash:plan.expectedHash});assert.equal(result.imported,1);
  assert.equal(store.listMessages({date:'2026-01-02'})[0].source,'jsonl');
});
test('different old-file contents invalidate the confirmed plan',t=>{
  const {store,record,insert}=fixture(t);const old=record('Old record');insert(old);
  const originalBatch={records:[old],format:'json'},batches=[{records:[record('Fresh record','2026-01-01')],format:'jsonl'}];
  const plan=planMatchingReplacement(store,batches,{originalBatch});
  const changed={records:[old,record('An extra old-file record')],format:'json'};
  assert.throws(()=>applyMatchingReplacement(store,batches,{originalBatch:changed,expectedHash:plan.expectedHash}),/预览/);
  assert.equal(store.listMessages({date:'2026-01-02'}).length,1);
});
test('original-file scope rejects Binding rows and invalid historical files',t=>{
  const {store,record,insert}=fixture(t);const old=record('Old record');insert(old);
  const batches=[{records:[record('Fresh record','2026-01-01')],format:'jsonl'}];
  store.db.prepare('UPDATE messages SET binding_id=? WHERE thread_id=?').run('synthetic-binding',store.threadId);
  assert.throws(()=>planMatchingReplacement(store,batches,{originalBatch:{records:[old],format:'json'}}),/Binding/);
  assert.throws(()=>planMatchingReplacement(store,batches,{originalBatch:{records:[{raw:{}}],format:'json'}}),/有效/);
});
test('ingestion failures restore rows from the original file transactionally',t=>{
  const {store,record,insert}=fixture(t);const old=record('Old record');insert(old);
  const originalBatch={records:[old],format:'json'},batches=[{records:[record('Fresh record','2026-01-01')],format:'jsonl'}];
  const plan=planMatchingReplacement(store,batches,{originalBatch});store.insertMessagesDetailed=()=>{throw new Error('synthetic failure');};
  assert.throws(()=>applyMatchingReplacement(store,batches,{originalBatch,expectedHash:plan.expectedHash}),/synthetic failure/);
  assert.equal(store.listMessages({date:'2026-01-02'}).length,1);
});
