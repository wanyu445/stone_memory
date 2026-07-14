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
 */
const fs = require("fs");
const path = require("path");
const { MemoryArchive } = require("../src/services/memory-archive");
const { MemoryMiner } = require("../src/services/memory-miner");
const { getCfg, getThreadDir, listThreadIds, loadConfig } = require("../src/config");

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
  const threadIdx = args.indexOf("--thread");
  const tid = threadIdx >= 0 ? args[threadIdx + 1] : listThreadIds()[0];
  if (!tid) throw new Error("未指定线程，请用 --thread <id> 或先 stmem init");
  const memoryDir = path.join(getThreadDir(tid), "memory");

  const deepseekConfig = resolveApiConfig(tid, forceApi, forceSub);
  const modeLabel = deepseekConfig.apiKey ? `api (${deepseekConfig.baseUrl})` : "subagent";

  const archive = new MemoryArchive(memoryDir);
  const miner = new MemoryMiner({
    memoryDir,
    threadId: tid,
    archive,
    deepseekConfig,
    personaConfig: {
      aiName: getCfg("ai", tid),
      userName: getCfg("user", tid),
      userGender: getCfg("userGender", tid, "female"),
      purpose: getCfg("purpose", tid),
    },
  });

  if (allMode) {
    const archiveDir = path.join(memoryDir, "archive");
    let allDates = [];
    try {
      allDates = fs.readdirSync(archiveDir)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .map(f => f.replace(".jsonl", ""))
        .sort();
    } catch {}
    if (!allDates.length) { console.log("[stmem] archive 目录无数据"); process.exit(0); }

    const stateFile = path.join(memoryDir, "mined", "state.json");
    let minedDates = new Set();
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      for (const key of Object.keys(state)) {
        if (key.startsWith("mined:")) minedDates.add(key.slice(6));
      }
    } catch {}

    const bjToday = (() => {
      const bj = new Date(Date.now() + 8 * 3600 * 1000);
      return bj.toISOString().slice(0, 10);
    })();

    const pending = allDates.filter(d => d < bjToday && !minedDates.has(d));
    if (!pending.length) { console.log("[stmem] 所有日期已挖掘完毕"); process.exit(0); }

    console.log(`[stmem] 待挖掘: ${pending.length} 天 (${pending[0]} ~ ${pending[pending.length-1]}) (${modeLabel})`);
    let ok = 0, fail = 0;
    for (const d of pending) {
      try {
        console.log(`\n[stmem] --- ${d} ---`);
        await miner.mine(d);
        ok++;
      } catch (e) {
        console.error(`[stmem] ${d} 失败: ${e.message}`);
        fail++;
      }
    }
    console.log(`\n[stmem] 完成: ${ok} 成功, ${fail} 失败`);
  } else {
    console.log(`[stmem] mining ${targetDate || "昨天"} (${modeLabel})...`);
    await miner.mine(targetDate);
    console.log("[stmem] done.");
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
