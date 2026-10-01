const { path, getCfg, getThreadDir, listMemoryIds, MemoryStore, loadConfig } = require("./shared");

/** 手动检查当前待办 */
function toolTriggersCheck(args) {
  try {
  const cfg = loadConfig();
  if (!cfg) return "未配置 stmem.json";
  const lines = ["📋 系统待办检查", ""];
  let found = false;
  for (const tid of listMemoryIds()) {
    const memoryDir = path.join(getThreadDir(tid), "memory");
    const store = new MemoryStore({ memoryDir, threadId: tid });
    try {
      const blockedDays = store.listDayStates().filter(row => row.status === "blocked").map(row => ({
        date: row.source_date, attempt: row.attempt, errorCode: row.error_code, errorMessage: row.error_message,
      }));
      for (const blocked of blockedDays) {
        lines.push(`🚨 挖掘已阻塞 — ${tid} / ${blocked.date}（连续失败 ${blocked.attempt} 次）`);
        lines.push(`   ${blocked.errorCode || "MINING_FAILED"}: ${blocked.errorMessage || "未知错误"}`);
        lines.push(`   → 修复后手动执行 stmem mine --thread ${tid} --date ${blocked.date}`);
        lines.push("");
        found = true;
      }
    } finally { store.close(); }
    // 待重建
    const windowDays = getCfg("windowDays", tid, 1);
    let lastArchiveDate = null;
    try {
      const files = new MemoryStore({ memoryDir, threadId: tid });
      const dates = files.listMessageDates();
      files.close();
      if (dates.length > 0) lastArchiveDate = dates.pop();
    } catch {}
    if (lastArchiveDate) {
      const d = Math.floor((Date.now() - new Date(lastArchiveDate).getTime()) / 86400000);
      if (d >= windowDays) { lines.push(`1️⃣  线程重建待执行 — ${tid}，上次存档 ${d} 天前，窗口 ${windowDays} 天`); lines.push(`   → stmem_memory_rebuild(thread: "${tid}")`); lines.push(""); found = true; }
    }
  }
  if (!found) lines.push("暂无待办，一切正常 ✅");
  return lines.join("\n");
  } catch (err) {
    throw new Error(`待办检查失败: ${err.message}`);
  }
}


function toolStatus() {
  try {
  const cfg = loadConfig();
  if (!cfg || listMemoryIds().length === 0) return "未配置 stmem.json 或无记忆体";

  const lines = [];
  for (const tid of listMemoryIds()) {
    const dir = getThreadDir(tid);
    let archiveCount = 0, feelingCount = 0, featureCount = 0, blockedCount = 0;
    try {
      const memoryDir = path.join(dir, "memory");
      const store = new MemoryStore({ memoryDir, threadId: tid });
      archiveCount = store.listMessageDates().length;
      feelingCount = store.listFeelings().length;
      featureCount = store.listFeatures().length;
      blockedCount = store.listDayStates().filter(row => row.status === "blocked").length;
      store.close();
    } catch {}

    const label = getCfg("label", tid, tid);
    lines.push(`stmem — ${getCfg("ai", tid)} × ${getCfg("user", tid)}${label !== tid ? ` (${label})` : ""}`);
    lines.push(`线程: ${tid} (${getCfg("runtime", tid)}/${getCfg("purpose", tid)})`);
    lines.push(`archive: ${archiveCount} 天 | feelings: ${feelingCount} | features: ${featureCount}`);
    if (blockedCount) lines.push(`⚠️ 挖掘阻塞: ${blockedCount} 天（请调用 stmem_memory_triggers_check 查看）`);
  }
  return lines.join("\n");
  } catch (err) {
    throw new Error(`状态查询失败: ${err.message}`);
  }
}


module.exports = { toolTriggersCheck, toolStatus };
