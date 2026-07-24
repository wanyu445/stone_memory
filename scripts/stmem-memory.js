#!/usr/bin/env node
const fs=require("fs");
const {listThreadIds}=require("../src/config");
const {editFeeling,setAnchor}=require("../src/services/memory-editor");
const args=process.argv.slice(3), value=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:null;};
const action=args[0],threadId=value("--thread")||listThreadIds()[0],batch=value("--batch-file");
if(!threadId||!batch) throw new Error("请指定 --thread 和 --batch-file");
const input=JSON.parse(fs.readFileSync(batch,"utf8"));
if(action==="update") console.log(JSON.stringify(editFeeling(threadId,input)));
else if(action==="anchor") console.log(JSON.stringify(setAnchor(threadId,input.id,input.type,input.enabled,input)));
else throw new Error("用法: stmem memory update|anchor --thread <id> --batch-file <json>");
