#!/usr/bin/env node
/**
 * SM Watcher — 后台轮询 archive，发现新天文件自动挖掘
 *
 * 策略:
 *   - 每 30s 扫一次 archive 目录
 *   - 发现昨天或更早的日期文件 && 未挖掘 → 跑 Miner (feelings + features)
 *   - 7 天未覆盖 → 触发周摘要 (claude -p)
 *   - 全写 log，不重复挖
 *
 * 用法:
 *   node scripts/watcher.js [--interval 30] [--once] [--thread <id>]
 *   --thread 省略时监视所有已配置线程
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");

const { loadConfig, getCfg, getThreadDir, listThreadIds } = require("../src/config");
const { runSubagent } = require("../src/services/subagent-runner");
const LOG_DIR = path.join(os.homedir(), ".stone_memory", "logs");

function log(msg) {
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, "watcher.log"), line + "\n", "utf8");
}

function beijingToday() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}

// ── 路径 helpers（全部接收 threadId） ──

function getArchiveDir(tid) {
  return path.join(getThreadDir(tid), "memory", "archive");
}

function getMinedDir(tid) {
  return path.join(getThreadDir(tid), "memory", "mined");
}

function getFeelingsDir(tid) {
  return path.join(getMinedDir(tid), "feelings");
}

function getFeelingsFile(tid) {
  return path.join(getFeelingsDir(tid), "days.jsonl");
}

function getFeaturesDir(tid) {
  return path.join(getMinedDir(tid), "features");
}

function getWeeksFile(tid) {
  return path.join(getFeelingsDir(tid), "weeks.jsonl");
}

function getMonthsFile(tid) {
  return path.join(getFeelingsDir(tid), "months.jsonl");
}

function getWeekCoverageFile(tid) {
  return path.join(getMinedDir(tid), "week-coverage.json");
}

function loadMinedDates(tid) {
  const stateFile = path.join(getMinedDir(tid), "state.json");
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const dates = new Set();
    for (const key of Object.keys(state)) {
      if (key.startsWith("mined:")) dates.add(key.slice(6));
    }
    return dates;
  } catch {
    return new Set();
  }
}

function loadFeelingDates(tid) {
  const dates = new Set();
  const ff = getFeelingsFile(tid);
  try {
    const raw = fs.readFileSync(ff, "utf8").split("\n").filter(Boolean);
    for (const line of raw) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "feeling") {
          const m = (obj.content || "").match(/^(\d+)月(\d+)日/);
          if (m) {
            let y = obj.createdAt ? new Date(obj.createdAt).getFullYear() : 0;
            if (!y || isNaN(y)) { const n = new Date(); y = parseInt(m[1]) > n.getMonth() + 1 ? n.getFullYear() - 1 : n.getFullYear(); }
            dates.add(`${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
          }
        }
      } catch {}
    }
  } catch {}
  return dates;
}

function loadWeekCoverage(tid) {
  const wf = getWeekCoverageFile(tid);
  try {
    return (JSON.parse(fs.readFileSync(wf, "utf8"))).ranges || [];
  } catch {
    return [];
  }
}

function saveWeekCoverage(tid, ranges) {
  fs.writeFileSync(getWeekCoverageFile(tid), JSON.stringify({ ranges }, null, 2), "utf8");
}

function scanArchiveDates(tid) {
  const dir = getArchiveDir(tid);
  const dates = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m) dates.push(m[1]);
    }
  } catch {}
  return dates.sort();
}

async function runMining(tid, dateStr) {
  const scriptPath = path.join(__dirname, "stmem-mine.js");
  const cmd = `${process.execPath} ${scriptPath} --thread ${tid} --date ${dateStr}`;
  log(`[${tid}] 开始挖掘 ${dateStr} ...`);

  try {
    const output = execSync(cmd, { encoding: "utf8", timeout: 600_000, cwd: path.dirname(__dirname), windowsHide: true });
    const lastLines = output.trim().split("\n").slice(-5).join(" | ");
    log(`[${tid}] 完成 ${dateStr}: ${lastLines}`);

    let feelingCount = 0, featureCount = 0;
    try {
      const ff = getFeelingsFile(tid);
      const lines = fs.readFileSync(ff, "utf8").split("\n").filter(Boolean);
      feelingCount = lines.filter(l => { try { return JSON.parse(l).type === "feeling"; } catch { return false; } }).length;
    } catch {}
    try {
      for (const cat of ["eat", "body", "sleep", "work", "relation", "habit", "location", "preference", "misc"]) {
        const cf = path.join(getFeaturesDir(tid), `${cat}.jsonl`);
        if (fs.existsSync(cf)) {
          featureCount += fs.readFileSync(cf, "utf8").split("\n").filter(Boolean).length;
        }
      }
    } catch {}
    log(`[${tid}] ${dateStr} 产出: ${feelingCount} feelings, ${featureCount} features`);
    return true;
  } catch (err) {
    log(`[${tid}] 挖掘 ${dateStr} 失败: ${err.message}`);
    return false;
  }
}

async function runWeeklySummary(tid, weekStart, weekEnd) {
  const opsFile = path.join(__dirname, "..", "operations", "memory-summary-operations.md");
  const prompt = `将 ${weekStart} 到 ${weekEnd} 这周的 feelings 提炼成一条中文周摘要（JSON: {"type":"feeling_week","weekStart":"${weekStart}","weekEnd":"${weekEnd}","content":"..."}），写入 ${getWeeksFile(tid)}。`;

  log(`[${tid}] 开始周摘要: ${weekStart} ~ ${weekEnd}`);
  try {
    const out = runSubagent(prompt, { opsFile, threadId: tid });
    log(`[${tid}] 周摘要完成: ${out.slice(0, 200)}`);
    return true;
  } catch (err) {
    const msg = err.stdout || err.stderr || err.message || String(err);
    log(`[${tid}] 周摘要失败: ${msg.slice(0, 300)}`);
    return false;
  }
}

function detectThreadFormat(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const firstLine = raw.split("\n").filter(Boolean)[0] || "";
    const obj = JSON.parse(firstLine);
    if (obj.type === "message" || obj.response_item) return "codex";
    return "claude";
  } catch { return "claude"; }
}

function importThreadFile(tid, filePath, fileName) {
  const archiveDir = getArchiveDir(tid);
  const format = detectThreadFormat(filePath);
  const messages = [];
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n").filter(Boolean)) {
    try { messages.push(JSON.parse(line)); } catch {}
  }

  let imported = 0;
  const seen = new Set();
  const byDate = new Map();

  for (const msg of messages) {
    const ts = msg.timestamp;
    if (!ts) continue;
    const dateKey = ts.slice(0, 10);

    let text = "";
    const content = msg.message?.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const blocks = format === "codex"
        ? content.filter(b => b.type === "input_text" || b.type === "output_text")
        : content.filter(b => b.type === "text");
      text = blocks.map(b => b.text || "").join("\n");
    }
    if (!text.trim()) continue;

    const dedupKey = crypto.createHash("md5").update(ts + "|" + text).digest("hex");
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push({ timestamp: ts, type: msg.type || (format === "codex" ? "user" : "assistant"), text: text.slice(0, 2000) });
    imported++;
  }

  for (const [dateKey, msgs] of byDate) {
    msgs.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
    const archiveFile = path.join(archiveDir, `${dateKey}.jsonl`);
    const lines = msgs.map(m => JSON.stringify(m) + "\n").join("");
    fs.appendFileSync(archiveFile, lines, "utf8");
  }

  const doneDir = path.join(getThreadDir(tid), "memory", "import", "done");
  fs.mkdirSync(doneDir, { recursive: true });
  const donePath = path.join(doneDir, fileName.replace(".jsonl", `_${Date.now()}.jsonl`));
  fs.renameSync(filePath, donePath);

  log(`[${tid}] import: ${fileName} (${format}) → ${imported} messages, ${byDate.size} dates`);
  return imported;
}

async function checkImports(tid) {
  const importDir = path.join(getThreadDir(tid), "memory", "import");
  let files = [];
  try { files = fs.readdirSync(importDir).filter(f => f.endsWith(".jsonl")); } catch { return; }

  for (const f of files) {
    const fpath = path.join(importDir, f);
    if (!fs.statSync(fpath).isFile()) continue;
    try { importThreadFile(tid, fpath, f); } catch (err) {
      log(`[${tid}] import ${f} 失败: ${err.message}`);
    }
  }
}

async function syncFromThread(tid) {
  const syncScript = path.join(__dirname, "stmem-sync.js");
  if (!fs.existsSync(syncScript)) return;
  try {
    const out = execSync(`${process.execPath} ${syncScript} --thread ${tid}`, {
      encoding: "utf8", timeout: 120_000, cwd: path.dirname(__dirname), windowsHide: true,
    });
    const trimmed = out.trim();
    if (trimmed && !trimmed.includes("(no new messages)")) {
      log(`[${tid}] sync: ${trimmed.split("\n").pop()}`);
    }
  } catch {}
}

async function checkAndMine(tid) {
  const STOP = path.join(os.homedir(), ".stone_memory");

  if (!fs.existsSync(path.join(STOP, ".archive-off"))) {
    await syncFromThread(tid);
  }

  const archiveDates = scanArchiveDates(tid);
  if (!archiveDates.length) return;

  const minedDates = loadMinedDates(tid);
  const bjToday = beijingToday();

  await checkImports(tid);

  const minerOff = fs.existsSync(path.join(STOP, ".miner-off"));

  const pending = archiveDates.filter(d => d < bjToday && !minedDates.has(d));

  if (pending.length > 0 && !minerOff) {
    log(`[${tid}] 发现 ${pending.length} 天待挖掘: ${pending.join(", ")}`);
    for (const dateStr of pending) {
      await runMining(tid, dateStr);
    }
  }

  // 周摘要检查
  const feelingDates = loadFeelingDates(tid);
  const weekCovered = loadWeekCoverage(tid);
  const coveredDays = new Set();
  for (const range of weekCovered) {
    let d = new Date(range.start);
    const end = new Date(range.end);
    while (d <= end) {
      coveredDays.add(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
  }

  const uncovered = [...feelingDates].filter(d => !coveredDays.has(d)).sort();
  if (uncovered.length >= 7) {
    const ws = uncovered[0];
    const we = uncovered[6];
    log(`[${tid}] 周摘要: 未覆盖 ${uncovered.length} 天，合成 ${ws} ~ ${we}`);
    const ok = await runWeeklySummary(tid, ws, we);
    if (ok) {
      weekCovered.push({ start: ws, end: we });
      saveWeekCoverage(tid, weekCovered);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const intervalIdx = args.indexOf("--interval");
  const intervalSec = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) || 30 : 30;
  const once = args.includes("--once");
  const threadFlag = args.includes("--thread") ? args[args.indexOf("--thread") + 1] : null;

  const threadIds = threadFlag ? [threadFlag] : listThreadIds();
  if (!threadIds.length) {
    log("没有配置任何线程，请先运行 stmem init --thread <id>");
    process.exit(1);
  }

  for (const tid of threadIds) {
    fs.mkdirSync(getArchiveDir(tid), { recursive: true });
  }

  log(`===== SM Watcher 启动 =====`);
  log(`线程: ${threadIds.join(", ")}`);
  log(`轮询间隔: ${intervalSec}s`);

  while (true) {
    // 暂停标志检查
    if (fs.existsSync(path.join(os.homedir(), ".stone_memory", ".watcher-off"))) {
      log("watcher 已暂停（检测到 .watcher-off 标志），退出");
      process.exit(0);
    }
    for (const tid of threadIds) {
      try {
        await checkAndMine(tid);
      } catch (err) {
        log(`[${tid}] 轮询出错: ${err.message}`);
      }
    }
    if (once) break;
    await new Promise(r => setTimeout(r, intervalSec * 1000));
  }

  if (once) log("--once 模式，退出。");
}

// Windows 自愈：崩溃后自动重启（代替 systemd）
if (process.platform === "win32") {
  process.on("uncaughtException", (err) => {
    log(`FATAL: ${err.message}`);
    log("自愈: 10s 后自动重启...");
    setTimeout(() => {
      const { spawn } = require("child_process");
      const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true, stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      child.unref();
      process.exit(1);
    }, 10000).unref();
  });
}

main().catch(e => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
