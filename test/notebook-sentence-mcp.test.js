"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('sentence-book real MCP process preserves CRUD, revisions and authorization',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'sentence-mcp-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const root=path.join(home,'.stone_memory');fs.mkdirSync(root);
 fs.writeFileSync(path.join(root,'stmem.json'),JSON.stringify({synthetic:{runtime:'codex',purpose:'accompany',user:'user',ai:'assistant',mcpModules:['notebook-lab']}}));
 const env={...process.env,HOME:home,USERPROFILE:home,STMEM_DB_PATH:path.join(root,'stone-memory.db'),STMEM_CURRENT_THREAD_ID:'synthetic',STMEM_SKIP_PENDING_REBUILDS:'1',STMEM_SEARCH_ONLY:'0',STMEM_NOTEBOOK_STEWARD:'0'};delete env.NODE_TEST_CONTEXT; delete env.STMEM_MEMORY_ID; delete env.STMEM_BINDING_ID;
 const request=(method,params)=>{const r=spawnSync(process.execPath,[path.join(__dirname,'../mcp-server.js')],{env,input:JSON.stringify({jsonrpc:'2.0',id:1,method,params})+'\n',encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim().split(/\r?\n/).find(x=>JSON.parse(x).id===1)).result;};
 const call=(name,args)=>request('tools/call',{name:'stmem_notebook_'+name,arguments:args});
 const data=(name,args)=>{const r=call(name,args);assert.equal(r.isError,false,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 assert.ok(request('tools/list',{}).tools.some(x=>x.name==='stmem_notebook_write'));
 const topic=data('topic_manage',{action:'create',name:'Synthetic book',kind:'sentence-book'});assert.equal(topic.kind,'sentence-book');
 let note=data('write',{topicId:topic.id,title:'Synthetic quote',body:'Quote body',metadata:{speaker:'speaker-key',note:'ripple-key',collector:'user'}});
 let read=data('read',{noteId:note.id});assert.equal(read.metadata.note,'ripple-key');
 assert.equal(data('status',{}).topics[0].kind,'sentence-book');
 assert.equal(data('query',{query:'speaker-key'}).matches[0].id,note.id);
 assert.equal(data('query',{query:'ripple-key'}).matches[0].id,note.id);
 const old=note.revision;
 for(const sentenceRemoved of [true,false]){read=data('read',{noteId:note.id});note=data('write',{topicId:topic.id,noteId:note.id,title:read.title,body:'Updated body',expectedRevision:read.revision,metadata:{...read.metadata,sentenceRemoved}});assert.equal(data('read',{noteId:note.id}).metadata.sentenceRemoved,sentenceRemoved);}
 assert.equal(call('write',{topicId:topic.id,noteId:note.id,title:'Stale',body:'No',expectedRevision:old}).isError,true);
 assert.equal(call('read',{thread:'unauthorized',noteId:note.id}).isError,true);
 assert.equal(call('write',{title:'Bad',body:'No',metadata:{unexpected:'bad'}}).isError,true);
 fs.writeFileSync(path.join(root,'stmem.json'),JSON.stringify({synthetic:{runtime:'codex',purpose:'accompany',user:'user',ai:'assistant',mcpModules:[]}}));
 assert.equal(request('tools/list',{}).tools.some(x=>x.name==='stmem_notebook_write'),false);
});

for (const provider of ["codex", "claude"]) {
 test(`sentence-book canonical memory binding isolates ${provider} sessions`, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentence-memory-v1-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".stone_memory");
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "stmem.json"), JSON.stringify({ memories: Object.fromEntries(ids.map(memoryId => [memoryId, { memoryId, label: "Synthetic memory" }])) }));
  const configPath = i => path.join(root, "memories", ids[i], "memory.json");
  ids.forEach((memoryId, i) => {
   const directory = path.dirname(configPath(i)); fs.mkdirSync(directory, { recursive: true });
   fs.writeFileSync(path.join(directory, ".layout-v1.json"), JSON.stringify({ schemaVersion: 1, status: "complete", memoryId }));
   fs.writeFileSync(configPath(i), JSON.stringify({ memoryId, label: "Synthetic memory", mcpModuleConfigVersion: 1, mcpModules: [] }));
   fs.writeFileSync(path.join(directory, "bindings.json"), JSON.stringify({ schemaVersion: 1, primaryBindingId: "binding-" + i, bindings: [{ id: "binding-" + i, provider, externalThreadId: "synthetic-session-" + i, enabled: true }] }));
  });
  function environment(session = 0) {
   const env = { ...process.env, HOME: home, USERPROFILE: home, STMEM_DB_PATH: path.join(root, "stone-memory.db"), STMEM_SKIP_PENDING_REBUILDS: "1", STMEM_SEARCH_ONLY: "0", STMEM_NOTEBOOK_STEWARD: "0" };
   for (const key of ["NODE_TEST_CONTEXT", "STMEM_CURRENT_THREAD_ID", "STMEM_MEMORY_ID", "STMEM_BINDING_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"]) delete env[key];
   if (session !== null) env[provider === "codex" ? "CODEX_THREAD_ID" : "CLAUDE_CODE_SESSION_ID"] = "synthetic-session-" + session;
   return env;
  }
  function request(method, params = {}, session = 0) {
   const result = spawnSync(process.execPath, [path.join(__dirname, "../mcp-server.js")], { env: environment(session), input: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n", encoding: "utf8", timeout: 15000 });
   assert.equal(result.status, 0, result.stderr);
   return JSON.parse(result.stdout.trim().split(/\r?\n/).find(line => JSON.parse(line).id === 1)).result;
  }
  const call = (name, args = {}, session = 0) => request("tools/call", { name: "stmem_notebook_" + name, arguments: args }, session);
  const data = (name, args = {}, session = 0) => { const result = call(name, args, session); assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  const hasTools = session => request("tools/list", {}, session).tools.some(tool => tool.name === "stmem_notebook_write");
  function permission(i, enabled) {
   const result = spawnSync(process.execPath, [path.join(__dirname, "../bin/stmem"), "module", "mcp", enabled ? "enable" : "disable", "--module", "notebook-lab", "--memory", ids[i], "--apply"], { env: environment(i), encoding: "utf8", timeout: 15000 });
   assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(hasTools(0), false);
  permission(0, true);
  assert.equal(hasTools(0), true); assert.equal(hasTools(1), false);
  assert.equal(hasTools(null), false); assert.equal(hasTools("unknown"), false);
  assert.equal(data("status").topics.length, 0);
  assert.equal(fs.existsSync(path.join(root, "stone-memory.db")), false, "read-only discovery must not create storage");
  const topic = data("topic_manage", { action: "create", name: "Synthetic sentence book", kind: "sentence-book" });
  let note = data("write", { topicId: topic.id, title: "Synthetic quote", body: "Original quote", metadata: { speaker: "speaker-key", note: "ripple-key", collector: "collector-key" } });
  assert.equal(data("status").topics[0].kind, "sentence-book");
  assert.equal(data("query", { query: "ripple-key" }).matches[0].id, note.id);
  const oldRevision = note.revision;
  for (const sentenceRemoved of [true, false]) {
   const read = data("read", { noteId: note.id });
   note = data("write", { topicId: topic.id, noteId: note.id, title: read.title, body: "Original quote", expectedRevision: read.revision, metadata: { ...read.metadata, sentenceRemoved } });
   assert.equal(data("read", { noteId: note.id }).metadata.sentenceRemoved, sentenceRemoved);
  }
  assert.equal(call("write", { topicId: topic.id, noteId: note.id, title: "Stale", body: "Rejected", expectedRevision: oldRevision }).isError, true);
  permission(1, true);
  assert.equal(hasTools(1), true); assert.equal(data("status", {}, 1).topics.length, 0);
  assert.equal(data("query", { query: "ripple-key" }, 1).matches.length, 0);
  const foreignRead = call("read", { noteId: note.id }, 1);
  assert.ok(foreignRead.isError || JSON.parse(foreignRead.content[0].text).found === false);
  assert.equal(call("write", { topicId: topic.id, noteId: note.id, title: "Foreign", body: "Rejected", expectedRevision: note.revision }, 1).isError, true);
  assert.equal(call("read", { noteId: note.id, memoryId: ids[1] }).isError, true);
  const before = fs.readFileSync(path.join(root, "stone-memory.db"));
  data("status"); data("query", { query: "speaker-key" }); data("read", { noteId: note.id });
  assert.deepEqual(fs.readFileSync(path.join(root, "stone-memory.db")), before);
  permission(0, false);
  assert.equal(hasTools(0), false); assert.equal(call("read", { noteId: note.id }).isError, true);
  assert.equal(hasTools(1), true);
 });
}
