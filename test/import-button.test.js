const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'../src/web/public/app.js'),'utf8');
const start=source.indexOf('function renderImports() {');
const end=source.indexOf('function previewTable(',start);
function render(imports,label='导入当前记忆体') {
  const apply={disabled:true,textContent:label};
  const list={innerHTML:'',querySelectorAll:()=>[]};
  const context={state:{imports},document:{querySelector:s=>s==='#apply-import'?apply:s==='#import-list'?list:null},escapeHtml:x=>x,previewTable:()=>'',pagination:()=>''};
  vm.runInNewContext(source.slice(start,end)+'\nrenderImports();',context);
  return apply;
}
test('rendering recognized uploads enables the import action, even without the receive closure',()=>{
  assert.equal(render([{filename:'synthetic.jsonl',rows:[],totalRows:1,valid:1,firstDate:'2026-01-01',lastDate:'2026-01-01'}]).disabled,false);
  assert.equal(render([]).disabled,true);
});
test('preview rerender must not enable an in-flight import',()=>{
  const apply=render([{filename:'synthetic.jsonl',rows:[],valid:1}],'正在导入…');
  assert.equal(apply.disabled,true);assert.equal(apply.textContent,'正在导入…');
});
