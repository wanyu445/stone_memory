const test=require("node:test");
const assert=require("node:assert/strict");
const {buildCodexSessionMeta,validateCodexRebuildOutput}=require("../src/services/codex-session-meta");

test("Codex rebuild preserves the complete session metadata and both IDs",()=>{
  const source={timestamp:"2026-07-01T00:00:00.000Z",payload:{
    session_id:"session-1",id:"session-1",cwd:"C:\\work",originator:"codex-tui",
    cli_version:"0.144.4",source:"cli",model_provider:"openai",
    base_instructions:{text:"persona"},context_window:{window_id:"window-1"},
  }};
  const result=buildCodexSessionMeta(source,{threadId:"fallback",now:new Date("2026-07-24T00:00:00.000Z")});
  assert.equal(result.payload.session_id,"session-1");
  assert.equal(result.payload.id,"session-1");
  assert.deepEqual(result.payload.base_instructions,{text:"persona"});
  assert.deepEqual(result.payload.context_window,{window_id:"window-1"});
  assert.equal(result.payload.cli_version,"0.144.4");
});

test("Codex rebuild output validation rejects a mismatched session",()=>{
  assert.throws(()=>validateCodexRebuildOutput('{"type":"session_meta","payload":{"session_id":"wrong","id":"wrong"}}\n',"expected"),/线程 ID 不一致/);
});

test("Codex rebuild preserves a single ID field used by the source format",()=>{
  const idOnly=buildCodexSessionMeta({payload:{id:"session-1"}},{threadId:"fallback"});
  assert.equal(idOnly.payload.id,"session-1");
  assert.equal("session_id" in idOnly.payload,false);
  assert.doesNotThrow(()=>validateCodexRebuildOutput(`${JSON.stringify(idOnly)}\n`,"session-1"));

  const sessionOnly=buildCodexSessionMeta({payload:{session_id:"session-2"}},{threadId:"fallback"});
  assert.equal(sessionOnly.payload.session_id,"session-2");
  assert.equal("id" in sessionOnly.payload,false);
  assert.doesNotThrow(()=>validateCodexRebuildOutput(`${JSON.stringify(sessionOnly)}\n`,"session-2"));
});

test("Codex integrity accepts either ID field and rejects missing or conflicting IDs",()=>{
  const {checkIntegrityFile}=require("../src/services/rebuild-workbench");
  const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-meta-"));
  const file=path.join(dir,"rollout.jsonl");
  try {
    fs.writeFileSync(file,`${JSON.stringify({type:"session_meta",payload:{id:"session-1",base_instructions:{text:"persona"}}})}\n`);
    assert.equal(checkIntegrityFile(file,"codex","session-1").healthy,true);

    fs.writeFileSync(file,`${JSON.stringify({type:"session_meta",payload:{session_id:"one",id:"two",base_instructions:{text:"persona"}}})}\n`);
    assert.equal(checkIntegrityFile(file,"codex","session-1").mismatchedSessionIds,1);

    fs.writeFileSync(file,`${JSON.stringify({type:"session_meta",payload:{base_instructions:{text:"persona"}}})}\n`);
    assert.equal(checkIntegrityFile(file,"codex","session-1").missingSessionId,1);
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
