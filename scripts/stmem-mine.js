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
 *   stmem mine [--thread <id>] --subagent     # 临时走 subagent
 *   stmem mine [--thread <id>] --targeted --batch-file <json>
 */
const fs = require("fs");
const path = require("path");
const { MemoryMiner } = require("../src/services/memory-miner");
const { getCfg, getThreadDir, listThreadIds, loadConfig } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { shouldAttempt } = require("../src/services/mining-state");

function resolveApiConfig(tid, forceApi, forceSub) {
  if (forceSub) return {};  // 强制 subagent

  const tc = loadConfig()[tid] || {};
  const mode = forceApi ? "api" : (tc.minerMode || "subagent");
  if (mode !== "api") return {};

  const provider = tc.apiProvider || "deepseek";
  const globalKeys = loadConfig().apiKeys || {};
  const cred = globalKeys[provider];
  if (!cred || !cred.key) {
    console.warn(`[stmem] 线程 ${tid} 配置了 api 模式但未找到 ${provider} 的 key，回退 subagent`);
    return {};
  }

  return {
    apiKey: cred.key,
    baseUrl: cred.baseUrl || "https://api.deepseek.com",
    model: cred.model || "deepseek-chat",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf("--date");
  const targetDate = dateIdx >= 0 ? args[dateIdx + 1] : "";
  const allMode = args.includes("--all");
  const forceApi = args.includes("--api");
  const forceSub = args.includes("--subagent");
  const force = args.includes("--force");
  const targeted = args.includes("--targeted");
  const batchIdx = args.indexOf("--batch-file");
  const threadIdx = args.indexOf("--thread");
  const tid = threadIdx >= 0 ? args[threadIdx + 1] : listThreadIds()[0];
  if (!tid) throw new Error("未指定线程，请用 --thread <id> 或先 stmem init");
  const memoryDir = path.join(getThreadDir(tid), "memory");

  const deepseekConfig = resolveApiConfig(tid, forceApi, forceSub);
  const modeLabel = deepseekConfig.apiKey ? `api (${deepseekConfig.baseUrl})` : "subagent";

  const miner = new MemoryMiner({
    memoryDir,
    threadId: tid,
    deepseekConfig,
    personaConfig: {
      aiName: getCfg("ai", tid),
      userName: getCfg("user", tid),
      userGender: getCfg("userGender", tid, "female"),
      purpose: getCfg("purpose", tid),
    },
  });

  if (targeted) {
    if (batchIdx < 0 || !args[batchIdx + 1]) throw new Error("精准补挖需要 --batch-file <json>");
    const payload = JSON.parse(fs.readFileSync(path.resolve(args[batchIdx + 1]), "utf8"));
    const date = String(payload.date || targetDate || "");
    const timestamps = new Set(Array.isArray(payload.timestamps) ? payload.timestamps.map(String) : []);
    if (!timestamps.size) throw new Error("精准补挖没有选中对话");
    const messages = miner.store.listMessages({ date }).filter(row => timestamps.has(row.timestamp));
    if (messages.length !== timestamps.size) throw new Error("部分所选对话已不存在，请刷新后重试");
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

    const pending = allDates.filter(d => d < bjToday && shouldAttempt(miningState, d, miner.store.listMessages({ date: d })));
    if (!pending.length) { console.log("[stmem] 所有日期已挖掘完毕"); process.exit(0); }

    console.log(`[stmem] 待挖掘: ${pending.length} 天 (${pending[0]} ~ ${pending[pending.length-1]}) (${modeLabel})`);
    let ok = 0, empty = 0, fail = 0;
    for (const d of pending) {
      try {
        console.log(`\n[stmem] --- ${d} ---`);
        const result = await miner.mine(d, { force });
        if (result.status === "locked") throw new Error(`${result.errorCode}: date is locked`);
        if (["completed", "already_completed"].includes(result.status)) ok++;
        else if (result.status === "completed_empty") empty++;
        else throw new Error(`unexpected status: ${result.status}`);
      } catch (e) {
        console.error(`[stmem] ${d} 失败: ${e.message}`);
        fail++;
      }
    }
    console.log(`\n[stmem] 完成: ${ok} 有结果, ${empty} 无需记录, ${fail} 失败`);
    if (fail) process.exitCode = 1;
  } else {
    console.log(`[stmem] mining ${targetDate || "昨天"} (${modeLabel})...`);
    const result = await miner.mine(targetDate, { force });
    if (result.status === "locked") throw new Error(`${result.errorCode}: date is locked`);
    console.log(`[stmem] ${result.status}.`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
