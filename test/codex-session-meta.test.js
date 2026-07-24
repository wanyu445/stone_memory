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
