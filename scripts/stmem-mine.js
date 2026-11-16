#!/usr/bin/env node
/**
 * stmem mine — 挖掘 feelings + features
 *
 * 默认按线程配置的 minerMode 走 (api/subagent)，
 * 也可用 --api / --subagent 临时覆盖。
 *
 * 用法:
 *   stmem mine [--thread <id>] [--date <YYYY-MM-DD>]
 *   stmem mine [--thread <id>] --all
 *   stmem mine [--thread <id>] --api          # 临时走 API
 *   stmem mine [--thread <id>] --api --api-profile <raw|optimized>
 *   stmem mine [--thread <id>] --subagent     # 临时走 subagent
 *   stmem mine [--thread <id>] --targeted --batch-file <json>
 */
const fs = require("fs");
const path = require("path");
const { MemoryMiner } = require("../src/services/memory-miner");
const { getCfg, getThreadDir, loadConfig, getMemoryRuntimeConfig } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { isCompleted, requiresRemine, shouldAttempt } = require("../src/services/mining-state");
const { resolveMiningApiCredentials } = require("../src/services/mining-engine-config");
const { normalizeMiningApiProfile } = require("../src/services/mining-api-profile");
const { handleMiningBatch, miningBatchAction, runMiningSelection } = require("./stmem-mine-batch");

function resolveApiConfig(tid, forceApi, forceSub, { diagnostic = false, model = "", apiProfile = "optimized" } = {}) {
  if (forceSub) return {};  // 强制 subagent

  const tc = getMemoryRuntimeConfig(tid);
  const mode = forceApi ? "api" : (tc.minerMode || "subagent");
  if (mode !== "api") return {};

  return {
    ...resolveMiningApiCredentials({
    config: loadConfig(),
    threadId: tid,
    provider: tc.apiProvider,
    model,
    diagnostic,
    }),
    apiProfile: normalizeMiningApiProfile(apiProfile),
  };
}

function processFile(tid) {
  return path.join(getThreadDir(tid), "logs", "mining-process.json");
}

function registerMiningProcess(tid, date, mode) {
  const file = processFile(tid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, threadId: tid, date, mode, startedAt: new Date().toISOString() }, null, 2));
}

function clearMiningProcess(tid) {
  try { fs.unlinkSync(processFile(tid)); } catch {}
}

function stopMiningProcess(tid) {
  const file = processFile(tid);
  let state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { stopped: false, code: "MINING_NOT_RUNNING", reason: "当前没有登记中的挖掘进程" }; }
  try {
    process.kill(Number(state.pid), "SIGTERM");
    if (state.kind !== "batch") {
      try { fs.rmSync(path.join(getThreadDir(tid), "memory", `.mining-lock-${state.date}`), { recursive: true, force: true }); } catch {}
    }
    if (state.kind !== "batch") try {
      const store = new MemoryStore({ memoryDir: path.join(getThreadDir(tid), "memory"), threadId: tid });
      const current = store.getDayState(state.date);
      store.setDayState(state.date, {
        status: "failed",
        attempt: current?.attempt || 0,
        errorCode: "MINING_CANCELLED",
        errorMessage: "用户手动停止挖掘",
        failedAt: new Date().toISOString(),
        nextRetryAt: new Date().toISOString(),
      });
      store.close();
    } catch {}
    clearMiningProcess(tid);
    return { stopped: true, code: "MINING_STOP_REQUESTED", pid: state.pid, date: state.date };
  } catch (error) {
    clearMiningProcess(tid);
    return { stopped: false, code: "MINING_PROCESS_STALE", reason: error.message, pid: state.pid, date: state.date };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf("--date");
  let targetDate = dateIdx >= 0 ? args[dateIdx + 1] : "";
  const allMode = args.includes("--all");
  let forceApi = args.includes("--api");
  let forceSub = args.includes("--subagent");
  let force = args.includes("--force");
  if (args.includes("--overwrite-protected") && (!force || !args.includes("--date") || args.includes("--all") || args.includes("--batch-file"))) throw new Error("覆盖保护摘要须使用 --date <日期> --force --overwrite-protected；批量覆盖请逐日调用");
  if (args.includes("--remove-anchors") && !args.includes("--overwrite-protected")) throw new Error("--remove-anchors 必须与 --overwrite-protected 一起使用");
  const modelIdx = args.indexOf("--model");
  const model = modelIdx >= 0 ? String(args[modelIdx + 1] || "").trim() : "";
  const apiProfileIdx = args.indexOf("--api-profile");
  let apiProfile = apiProfileIdx >= 0 ? String(args[apiProfileIdx + 1] || "optimized").trim() : "optimized";
  const targeted = args.includes("--targeted");
  const check = args.includes("--check");
  const stop = args.includes("--stop");
  const jsonOutput = args.includes("--json");
  const batchIdx = args.indexOf("--batch-file");
  const threadIdx = args.indexOf("--thread");
  const memoryIdx = args.indexOf("--memory");
  const legacyId = threadIdx >= 0 ? args[threadIdx + 1] : null;
  const memoryId = memoryIdx >= 0 ? args[memoryIdx + 1] : null;
  if (legacyId && memoryId && legacyId !== memoryId) throw new Error("--memory 与兼容参数 --thread 不能指向不同记忆体");
  const tid = memoryId || legacyId;
  if (!tid) throw new Error("未指定记忆体，请用 --memory <id> 或先创建记忆体");
  const memoryDir = path.join(getThreadDir(tid), "memory");

  if (miningBatchAction(args)) {
    const result = await handleMiningBatch(args, { threadId: tid });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  let dateSelection = null;
  if (batchIdx >= 0 && !targeted && !check) {
    dateSelection = JSON.parse(fs.readFileSync(path.resolve(args[batchIdx + 1]), "utf8"));
    const requested = [...new Set((dateSelection.dates || []).map(String))].sort();
    if (!requested.length || requested.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
      throw new Error("挖掘日期列表为空或格式无效");
    }
    const forceDates = new Set((dateSelection.forceDates || []).map(String));
    const stateStore = new MemoryStore({ memoryDir, threadId: tid });
    try {
      dateSelection.dates = requested.filter(date => forceDates.has(date) || !isCompleted({ [`day:${date}`]: stateStore.getDayState(date) }, date));
    } finally { stateStore.close(); }
    if (!dateSelection.dates.length) {
      console.log(JSON.stringify({ status: "already_completed", dates: requested }, null, 2));
      return;
    }
    if (dateSelection.mode === "api") { forceApi = true; forceSub = false; }
    if (dateSelection.mode === "subagent") { forceSub = true; forceApi = false; }
    if (dateSelection.apiProfile) apiProfile = normalizeMiningApiProfile(dateSelection.apiProfile);
    if (dateSelection.dates.length === 1) {
      targetDate = dateSelection.dates[0];
      force = force || forceDates.has(targetDate);
    } else {
      const config = getMemoryRuntimeConfig(tid);
      const mode = forceApi ? "api" : forceSub ? "subagent" : config.minerMode || "subagent";
      registerMiningProcess(tid, dateSelection.dates.join(","), mode);
      try {
        const file = processFile(tid);
        const state = JSON.parse(fs.readFileSync(file, "utf8"));
        fs.writeFileSync(file, JSON.stringify({ ...state, kind: "batch", dates: dateSelection.dates }, null, 2));
        const result = await runMiningSelection(dateSelection, { threadId: tid, mode, apiProfile, model });
        console.log(JSON.stringify(result, null, 2));
        if (result.status === "completed_with_failures" || result.status === "cancelled") process.exitCode = 1;
        return;
      } finally { clearMiningProcess(tid); }
    }
  }

  if (stop) {
    const result = stopMiningProcess(tid);
    console.log(jsonOutput ? JSON.stringify(result, null, 2) : (result.stopped ? `已请求停止 ${result.date} 的挖掘` : result.reason));
    if (!result.stopped && result.code !== "MINING_NOT_RUNNING") process.exitCode = 1;
    return;
  }

  let deepseekConfig;
  try {
    deepseekConfig = resolveApiConfig(tid, forceApi, forceSub, { diagnostic: check, model, apiProfile });
  } catch (error) {
    if (targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      const store = new MemoryStore({ memoryDir, threadId: tid });
      try {
        const current = store.getDayState(targetDate);
        const failedAt = new Date().toISOString();
        store.setDayState(targetDate, {
          status: "failed",
          messageCount: store.listMessages({ date: targetDate }).length,
          attempt: Number(current?.attempt || 0) + 1,
          errorCode: "MINING_CONFIG_INVALID",
          errorMessage: error.message,
          failedAt,
          nextRetryAt: null,
          updatedAt: failedAt,
        });
      } finally {
        store.close();
      }
    }
    throw error;
  }
  const modeLabel = deepseekConfig.apiKey ? `api (${deepseekConfig.baseUrl})` : "subagent";

  const miner = new MemoryMiner({
    memoryDir,
    threadId: tid,
    deepseekConfig,
    allowSubagentFallback: false,
    personaConfig: {
      aiName: getCfg("ai", tid),
      userName: getCfg("user", tid),
      userGender: getCfg("userGender", tid, "female"),
      relationshipTimeline: getCfg("relationshipTimeline", tid, []),
      purpose: getCfg("purpose", tid),
      scenario: getCfg("scenario", tid),
      runtime: getCfg("runtime", tid, "claude"),
    },
  });

  if (check) {
    const date = targetDate || miner._yesterday();
    const result = await miner.diagnose(date);
    console.log(jsonOutput ? JSON.stringify({ date, mode: deepseekConfig.apiKey || forceApi ? "api" : "subagent", ...result }, null, 2)
      : `挖掘自检 ${result.ok ? "通过" : "失败"}（${result.code}）\n${result.reason}\n\n实际返回：\n${result.actualResponse?.content || result.actualResponse?.body || "（无响应内容）"}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (targeted) {
    if (batchIdx < 0 || !args[batchIdx + 1]) throw new Error("精准补挖需要 --batch-file <json>");
    const payload = JSON.parse(fs.readFileSync(path.resolve(args[batchIdx + 1]), "utf8"));
    const date = String(payload.date || targetDate || "");
    const timestamps = new Set(Array.isArray(payload.timestamps) ? payload.timestamps.map(String) : []);
    if (!timestamps.size) throw new Error("精准补挖没有选中对话");
    const messages = miner.store.listMessages({ date }).filter(row => timestamps.has(row.timestamp));
    if (new Set(messages.map(row => row.timestamp)).size !== timestamps.size) throw new Error("部分所选对话已不存在，请刷新后重试");
    const result = await miner.mineTargeted(date, messages, { instruction: String(payload.instruction || "") });
    console.log(JSON.stringify({ status: "completed", date, feelingCount: result.feelings.length }));
  } else if (allMode) {
    const allDates = miner.store.listMessageDates();
    if (!allDates.length) { console.log("[stmem] SQLite messages 无数据"); process.exit(0); }
    const miningState = miner._readState();

    const bjToday = (() => {
      const bj = new Date(Date.now() + 8 * 3600 * 1000);
      return bj.toISOString().slice(0, 10);
    })();

    const pending = allDates.filter(d => {
      if (d >= bjToday) return false;
      const messages = miner.store.listMessages({ date: d });
      return shouldAttempt(miningState, d, messages) || requiresRemine(miningState, d, messages);
    });
    if (!pending.length) { console.log("[stmem] 所有日期已挖掘完毕"); process.exit(0); }

    if (pending.length > 1) {
      const mode = forceApi ? "api" : forceSub ? "subagent" : (getMemoryRuntimeConfig(tid).minerMode || "subagent");
      const forceDates = pending.filter(date => requiresRemine(
        miningState,
        date,
        miner.store.listMessages({ date }),
      ));
      miner.store.close();
      registerMiningProcess(tid, pending.join(","), mode);
      try {
        const file = processFile(tid);
        const state = JSON.parse(fs.readFileSync(file, "utf8"));
        fs.writeFileSync(file, JSON.stringify({ ...state, kind: "batch", dates: pending }, null, 2));
        const result = await runMiningSelection({ dates: pending, forceDates }, {
          threadId: tid, mode, apiProfile, model,
        });
        console.log(JSON.stringify(result, null, 2));
        if (result.status === "completed_with_failures" || result.status === "cancelled") process.exitCode = 1;
        return;
      } finally { clearMiningProcess(tid); }
    }

    console.log(`[stmem] 待挖掘: ${pending.length} 天 (${pending[0]} ~ ${pending[pending.length-1]}) (${modeLabel})`);
    let ok = 0, empty = 0, fail = 0;
    for (const d of pending) {
      try {
        console.log(`\n[stmem] --- ${d} ---`);
        registerMiningProcess(tid, d, modeLabel);
        const messages = miner.store.listMessages({ date: d });
        const result = await miner.mine(d, { force: force || requiresRemine(miningState, d, messages) });
        if (result.status === "locked") throw new Error(`${result.errorCode}: date is locked`);
        if (["completed", "already_completed"].includes(result.status)) ok++;
        else if (result.status === "completed_empty") empty++;
        else throw new Error(`unexpected status: ${result.status}`);
      } catch (e) {
        console.error(`[stmem] ${d} 失败: ${e.message}`);
        fail++;
      } finally {
        clearMiningProcess(tid);
      }
    }
    console.log(`\n[stmem] 完成: ${ok} 有结果, ${empty} 无需记录, ${fail} 失败`);
    if (fail) process.exitCode = 1;
  } else {
    console.log(`[stmem] mining ${targetDate || "昨天"} (${modeLabel})...`);
    try {
      registerMiningProcess(tid, targetDate || miner._yesterday(), modeLabel);
      const result = await miner.mine(targetDate, { force, overwriteProtected: args.includes("--overwrite-protected"), removeAnchors: args.includes("--remove-anchors") });
      if (result.status === "locked") throw new Error(`${result.errorCode}: date is locked`);
      console.log(`[stmem] ${result.status}.`);
    } finally {
      clearMiningProcess(tid);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { resolveApiConfig, stopMiningProcess };
