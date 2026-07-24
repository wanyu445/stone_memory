#!/usr/bin/env node
const fs=require("fs");
const os=require("os");
const path=require("path");
const crypto=require("crypto");
const {checkIntegrityFile,repairIntegrityFile}=require("../src/services/rebuild-workbench");

function hash(file){return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");}
function rows(file){return fs.readFileSync(file,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line));}
function write(file,records,{malformed=false}={}){fs.writeFileSync(file,records.map(JSON.stringify).join("\n")+(malformed?"\n{broken-json\n":"\n"));}

function injectClaude(source,dir){
  const target=path.join(dir,path.basename(source)),records=rows(source),beforeHash=hash(source);
  let removed=-1;
  for(let i=1;i<records.length-1;i++)if(records[i].uuid&&records[i+1].parentUuid===records[i].uuid){removed=i;break;}
  if(removed<0)throw new Error("Claude fixture 中没有可断开的 UUID 链");
  records.splice(removed,1);
  const uuidRows=records.filter(row=>row.uuid);
  if(uuidRows.length>2)uuidRows[1].uuid=uuidRows[0].uuid;
  write(target,records);
  const detected=checkIntegrityFile(target,"claude",path.basename(source,".jsonl"));
  const repaired=repairIntegrityFile(target,"claude",path.basename(source,".jsonl"));
  return {source,target,sourceUnchanged:hash(source)===beforeHash,detected,repaired:repaired.after};
}

function injectCodex(source,dir){
  const target=path.join(dir,path.basename(source)),original=rows(source),beforeHash=hash(source);
  fs.copyFileSync(source,path.join(dir,`${path.basename(source,".jsonl")}.original.bak`));
  const records=original.filter(row=>row.type!=="session_meta");
  const meta=original.find(row=>row.type==="session_meta");
  if(!meta)throw new Error("Codex fixture 缺少 session_meta");
  const brokenMeta={...meta,payload:{...meta.payload,id:"mismatched-id"}};
  delete brokenMeta.payload.base_instructions;
  records.splice(Math.min(5,records.length),0,brokenMeta);
  const call=records.find(row=>row.type==="response_item"&&row.payload?.type==="function_call");
  if(call) {
    const outputIndex=records.findIndex(row=>row.type==="response_item"&&row.payload?.type==="function_call_output"&&row.payload.call_id===call.payload.call_id);
    if(outputIndex>=0)records.splice(outputIndex,1);
  }
  write(target,records,{malformed:true});
  const detected=checkIntegrityFile(target,"codex",meta.payload.session_id||meta.payload.id);
  const repaired=repairIntegrityFile(target,"codex",meta.payload.session_id||meta.payload.id);
  return {source,target,sourceUnchanged:hash(source)===beforeHash,detected,repaired:repaired.after};
}

const [claudeSource,codexSource]=process.argv.slice(2);
if(!claudeSource||!codexSource)throw new Error("用法: fault-inject-thread-integrity.js <claude.jsonl> <codex.jsonl>");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-real-integrity-"));
console.log(JSON.stringify({dir,claude:injectClaude(claudeSource,dir),codex:injectCodex(codexSource,dir)},null,2));
