const test = require('node:test');
const assert = require('node:assert/strict');
const { requestMiningApi } = require('../src/services/mining-api-request');
const { repairMiningJson } = require('../src/services/mining-json-repair');
for (const statuses of [[524,200],[524,524],[401]]) {
  test(`HTTP ${statuses}`, async () => {
    let calls=0;
    const request=requestMiningApi('https://example.invalid', {}, {backoffMs:0,fetchImpl:async()=>{
      const status=statuses[calls++]; return new Response('{}',{status});
    }});
    if(statuses.at(-1)===200) await request;
    else await assert.rejects(request,{code:`API_HTTP_${statuses.at(-1)}`});
    assert.equal(calls,statuses.length);
  });
}
test('timeout is bounded and retains code',async()=>{
 let calls=0;
 await assert.rejects(requestMiningApi('https://example.invalid',{}, {timeoutMs:5,backoffMs:0,fetchImpl:(_, {signal})=>{
 calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));
 }}),{code:'API_TIMEOUT'});assert.equal(calls,2);
});
test('content repair preserves quotes, controls and punctuation',()=>{
 const text='[{"importance":3,"content":"她试了"清蒸" "红烧"，例子,}，然后\n结束"}]';
 const result=JSON.parse(repairMiningJson(text));
 assert.equal(result[0].content,'她试了"清蒸" "红烧"，例子,}，然后\n结束');
 const valid=JSON.stringify(result);assert.equal(repairMiningJson(valid),valid);
 assert.equal(repairMiningJson('聊天回复'), '聊天回复');
});
