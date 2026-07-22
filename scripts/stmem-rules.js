#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { listThreadIds } = require("../src/config");
const { listRules, writeRule, deleteRule, setRuleInjected } = require("../src/services/rule-store");
const args = process.argv.slice(3), value = key => { const i=args.indexOf(key); return i>=0 ? args[i+1] : null; };
const threadId = value("--thread") || listThreadIds()[0], action = args[0] || "list";
if (!threadId) throw new Error("请指定 --thread");
if (action === "list") console.log(JSON.stringify(listRules(threadId)));
else if (action === "import" || action === "update") { const source=value("--source"); if(!source) throw new Error("请指定 --source"); const name=value("--name") || path.basename(source); writeRule(threadId,name,fs.readFileSync(source,"utf8")); console.log(JSON.stringify({success:true,name})); }
else if (action === "delete") { deleteRule(threadId,value("--name")); console.log(JSON.stringify({success:true})); }
else if (action === "enable" || action === "disable") { setRuleInjected(threadId,value("--name"),action === "enable"); console.log(JSON.stringify({success:true,injected:action === "enable"})); }
else throw new Error("用法: stmem rules list|import|update|delete|enable|disable --thread <id>");
