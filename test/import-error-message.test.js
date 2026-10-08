const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'../src/web/server.js'),'utf8');
const start=source.indexOf('function safeStmemFailure('),end=source.indexOf('function runStmem(',start);
test('formal import validation errors reach the frontend without unmarked private stderr',()=>{
  const context={redactWebSecrets:value=>value};
  vm.runInNewContext(source.slice(start,end)+'\nthis.failure=safeStmemFailure;',context);
  assert.match(context.failure('[import] error: 同文覆盖只接受完整有效的纯对话','import',1),/同文覆盖只接受完整有效的纯对话/);
  assert.doesNotMatch(context.failure('synthetic private conversation text','import',1),/private conversation/);
});
