function buildCodexSessionMeta(meta, { threadId, now = new Date(), cwd = process.cwd() } = {}) {
  const payload=meta?.payload&&typeof meta.payload==="object"?{...meta.payload}:{};
  const sessionId=payload.session_id||payload.id||threadId;
  if(!sessionId)throw new Error("Codex session_meta 缺少线程 ID");
  return {
    timestamp:now.toISOString(),
    type:"session_meta",
    payload:{
      ...payload,
      session_id:sessionId,
      id:sessionId,
      timestamp:payload.timestamp||meta?.timestamp||now.toISOString(),
      cwd:payload.cwd||cwd,
      originator:payload.originator||"codex",
    },
  };
}

function validateCodexRebuildOutput(outputText, expectedSessionId) {
  const lines=String(outputText||"").split("\n").filter(Boolean);
  if(!lines.length)throw new Error("Codex rebuild 输出为空");
  const rows=lines.map((line,index)=>{
    try{return JSON.parse(line);}
    catch{throw new Error(`Codex rebuild 输出第 ${index+1} 行不是有效 JSON`);}
  });
  const meta=rows[0];
  if(meta?.type!=="session_meta")throw new Error("Codex rebuild 输出首行不是 session_meta");
  if(meta.payload?.session_id!==expectedSessionId||meta.payload?.id!==expectedSessionId)throw new Error("Codex rebuild 输出线程 ID 不一致");
  return {lines:rows.length,sessionId:expectedSessionId};
}

module.exports={buildCodexSessionMeta,validateCodexRebuildOutput};
