const test=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const path=require('path');const vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'../src/web/public/app.js'),'utf8');const start=source.indexOf('function renderImports() {'),end=source.indexOf('function previewTable(',start);
test('completed asynchronous uploads release the busy label and enable cover preview',()=>{
const apply={disabled:true,textContent:'正在识别…'};const list={innerHTML:'',querySelectorAll:()=>[]};const context={state:{imports:[{filename:'synthetic.jsonl',rows:[],valid:1}],importBusy:false},document:{querySelector:s=>s==='#apply-import'?apply:s==='#import-list'?list:s==='#import-mode'?{value:'replace-matching'}:null},escapeHtml:x=>x,previewTable:()=>'',pagination:()=>''};vm.runInNewContext(source.slice(start,end)+'\nrenderImports();',context);assert.equal(apply.disabled,false);assert.equal(apply.textContent,'预览同文覆盖');
});
