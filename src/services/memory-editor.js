const fs = require("fs");
const path = require("path");
const { getThreadDir } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { temporalPrefix } = require("./memory-compressor");

function editFeeling(threadId, input) {
  const memoryDir = path.join(getThreadDir(threadId), "memory"), store = new MemoryStore({ memoryDir, threadId });
  try {
    const row = store.db.prepare("SELECT * FROM feelings WHERE thread_id=? AND id=?").get(threadId, input.id);
    if (!row) throw new Error("摘要不存在");
    const mode = String(input.summaryMode || row.summary_mode);
    if (!["daily", "coarse", "hidden"].includes(mode)) throw new Error("摘要状态无效");
    let coarse = input.coarseSummary === undefined ? row.coarse_summary : String(input.coarseSummary || "").trim();
    if (mode === "coarse") {
      const prefix = temporalPrefix(row.content);
      if (!coarse) throw new Error("手动精简需要填写精简文本");
      if (!prefix || !coarse.startsWith(prefix)) throw new Error("精简文本必须原样保留完整日期和对应时间");
    }
    const terms = Array.isArray(input.coreTerms) ? input.coreTerms.map(v=>String(v).trim()).filter(Boolean).slice(0,3) : null;
    store.db.prepare("UPDATE feelings SET summary_mode=?,coarse_summary=?,coarse_terms=COALESCE(?,coarse_terms),updated_at=? WHERE thread_id=? AND id=?")
      .run(mode, coarse || null, terms ? JSON.stringify(terms) : null, new Date().toISOString(), threadId, input.id);
    return store.db.prepare("SELECT * FROM feelings WHERE thread_id=? AND id=?").get(threadId, input.id);
  } finally { store.close(); }
}

function setAnchor(threadId, feelingId, type, enabled) {
  if (!["event", "retain"].includes(type)) throw new Error("锚点类型无效");
  const memoryDir = path.join(getThreadDir(threadId), "memory"), store = new MemoryStore({ memoryDir, threadId });
  let feeling; try { feeling=store.db.prepare("SELECT id,source_date FROM feelings WHERE thread_id=? AND id=?").get(threadId,feelingId); } finally { store.close(); }
  if (!feeling) throw new Error("摘要不存在");
  const file=path.join(memoryDir,"retain-config.json"); let config={retain:{},eventAnchors:{}};
  try { config={...config,...JSON.parse(fs.readFileSync(file,"utf8"))}; } catch {}
  const key=type==="event"?"eventAnchors":"retain"; config[key]=config[key]||{};
  if (enabled) config[key][feelingId]={...(config[key][feelingId]||{}),anchor:true,_date:config[key][feelingId]?._date||feeling.source_date}; else delete config[key][feelingId];
  const temp=`${file}.tmp-${process.pid}`; fs.writeFileSync(temp,JSON.stringify(config,null,2)); fs.renameSync(temp,file);
  return { id:feelingId,type,enabled:!!enabled };
}
module.exports={editFeeling,setAnchor};
