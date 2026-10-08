const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryStore } = require('../src/storage/memory-store');
const { planMatchingReplacement, applyMatchingReplacement } = require('../src/services/import-matching-replacement');
const LONG = 'This is an exact historical conversation message with sufficient unique context.';
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-matching-test-'));
  const store = new MemoryStore({memoryDir:dir,threadId:'synthetic-memory'});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const put = (text=LONG,role='user',timestamp='2026-01-03T10:00:00+08:00',source='json',bindingId=null) => store.insertMessagesDetailed([{text,role,timestamp,sourceDate:timestamp.slice(0,10),source}],bindingId?{bindingId}:{});
  const record = (text=LONG,role='user',timestamp='2026-01-02T10:00:00+08:00') => ({raw:{content:text,role,timestamp},message:{text,type:role,timestamp}});
  const batches = records => [{records,format:'jsonl'}];
  return {store,dir,put,record,batches};
}
test('same content replaces its timestamp across dates and preserves unrelated records',t=>{
  const {store,put,record,batches}=setup(t);put('```\n'+LONG+'\n```');put('Unrelated conversation must survive');
  const input=batches([record()]),plan=planMatchingReplacement(store,input);
  assert.equal(plan.replace,1);assert.equal(plan.add,1);assert.equal(store.listMessages({date:'2026-01-03'}).length,2);
  const result=applyMatchingReplacement(store,input,{expectedHash:plan.expectedHash});
  assert.equal(result.replaced,1);assert.ok(fs.existsSync(result.backupFile));
  assert.equal(store.listMessages({date:'2026-01-03'}).length,1);assert.equal(store.listMessages({date:'2026-01-02'})[0].text,LONG);
  assert.equal(store.getDayState('2026-01-03').error_code,'ARCHIVE_REPLACED_REMINING_REQUIRED');
});
test('already appended originals repair legacy duplicates without adding the new copy twice',t=>{
  const {store,put,record,batches}=setup(t);put();put(LONG,'user','2026-01-02T10:00:00+08:00','jsonl');
  const input=batches([record()]),plan=planMatchingReplacement(store,input);
  assert.equal(plan.replace,1);assert.equal(plan.add,0);assert.equal(plan.alreadyPresent,1);
  const result=applyMatchingReplacement(store,input,{expectedHash:plan.expectedHash});assert.equal(result.imported,0);
  const next=planMatchingReplacement(store,input);assert.equal(next.replace,0);assert.deepEqual(next.affectedDates,[]);
});
test('short repeated responses require adjacent evidence, never a date range guess',t=>{
  const {put,record,batches,store}=setup(t);put();put('OK','assistant','2026-01-03T10:01:00+08:00');put('OK','assistant','2026-01-04T10:01:00+08:00');
  const plan=planMatchingReplacement(store,batches([record(),record('OK','assistant','2026-01-02T10:01:00+08:00')]));
  assert.equal(plan.replace,2);assert.equal(plan.ambiguous,0);
  const ambiguous=planMatchingReplacement(store,batches([record('OK','assistant')]));assert.equal(ambiguous.replace,0);assert.equal(ambiguous.ambiguous,1);
});
test('file boundaries do not supply false adjacency for short messages',t=>{
  const {put,record,store}=setup(t);put();put('OK','assistant','2026-01-03T10:01:00+08:00');
  const plan=planMatchingReplacement(store,[{records:[record()],format:'jsonl'},{records:[record('OK','assistant')],format:'jsonl'}]);
  assert.equal(plan.replace,1);assert.equal(plan.ambiguous,1);
});
test('short responses separated by edited content need unchanged anchors on both sides',t=>{
  const {put,record,batches,store}=setup(t);
  const end=LONG+' ending';
  put();put('An older inserted paragraph','assistant','2026-01-03T10:01:00+08:00');
  put('OK','assistant','2026-01-03T10:02:00+08:00');put('Another older paragraph','user','2026-01-03T10:03:00+08:00');
  put(end,'assistant','2026-01-03T10:04:00+08:00');
  const input=batches([record(),record('OK','assistant','2026-01-02T10:02:00+08:00'),record(end,'assistant','2026-01-02T10:04:00+08:00')]);
  assert.equal(planMatchingReplacement(store,input).replace,3);
  assert.equal(planMatchingReplacement(store,batches(input[0].records.slice(0,2))).ambiguous,1);
});
test('binding and runtime messages cannot be silently replaced',t=>{
  const {store,put,record,batches}=setup(t);put(LONG,'user',undefined,'claude');
  const input=batches([record()]);assert.equal(planMatchingReplacement(store,input).replace,0);
  store.db.prepare('UPDATE messages SET source=?,binding_id=? WHERE thread_id=?').run('json','synthetic-binding',store.threadId);
  assert.equal(planMatchingReplacement(store,input).replace,0);
});
test('changed preview, invalid inputs, or running mining refuse writes',t=>{
  const {store,put,record,batches}=setup(t);put();const input=batches([record()]),plan=planMatchingReplacement(store,input);
  put('A new message invalidates the preview');
  assert.throws(()=>applyMatchingReplacement(store,input,{expectedHash:plan.expectedHash}),/预览/);
  assert.throws(()=>planMatchingReplacement(store,batches([{raw:{}}])),/有效/);
  store.setDayState('2026-01-03',{status:'running'});assert.throws(()=>planMatchingReplacement(store,input),/正在挖掘/);
});
test('ingest failure restores old rows and preserves existing summaries',t=>{
  const {store,put,record,batches}=setup(t);put();const input=batches([record()]),plan=planMatchingReplacement(store,input);
  const original=store.insertMessagesDetailed;store.insertMessagesDetailed=()=>{throw new Error('synthetic ingestion failure');};
  assert.throws(()=>applyMatchingReplacement(store,input,{expectedHash:plan.expectedHash}),/synthetic ingestion/);
  store.insertMessagesDetailed=original;assert.equal(store.listMessages({date:'2026-01-03'}).length,1);assert.equal(store.getDayState('2026-01-03'),null);
});
