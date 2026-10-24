#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("node:child_process");
const { startWebServer } = require("../src/web/server");
const { loadConfig } = require("../src/config");
const { saveConfig } = require("../src/services/thread-setup");
const { readManagedPid, startManagedProcess, stopManagedProcess } = require("../src/services/managed-local-process");
const { isLoopbackHost, configuredAuth } = require("../src/security/web-auth");
const { webSecurityStatus, rotateWebApiToken, ensureLegacyWebAuth, claimBootstrapToken, clearBootstrapToken, listWebDevices, revokeWebDevice, clearWebDevices } = require("../src/services/web-security");

const STONE = path.join(os.homedir(), ".stone_memory");
const PID_FILE = path.join(STONE, "web.pid");
const LOG_FILE = path.join(STONE, "web.log");
const WATCH_SCRIPT = path.join(__dirname, "stmem-web-watch.js");
const MARKER = ["stmem-web-watch.js", "stmem-web.js", "stmem web"];
const TOKEN_ROTATION_NOTICE = "新 Token 可用于多个设备登录；此前的旧 Token 及其设备会话将失效。";
const invokedThroughCli = path.basename(process.argv[1] || "") === "stmem";
const args = process.argv.slice(invokedThroughCli ? 3 : 2);
const actions = new Set(["start", "stop", "restart", "status", "config", "dev", "serve", "auth", "lan"]);
const action = actions.has(args[0]) ? args.shift() : "serve";
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

function webConfig({ persistFlags = false } = {}) {
  const config = loadConfig();
  const current = config.web || {};
  const rawPort = value("--port");
  const port = rawPort == null ? Number(current.port) || 4173 : Number(rawPort);
  const host = value("--host") || current.host || "127.0.0.1";
  const publicUrl = value("--url") || current.publicUrl || "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Web 端口必须是 1～65535 的整数");
  if (!String(host).trim()) throw new Error("Web 监听地址不能为空");
  if (publicUrl) {
    const parsed = new URL(publicUrl);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("前端访问地址必须使用 http 或 https");
  }
  const next = { host: String(host).trim(), port, publicUrl: String(publicUrl).trim() };
  if (persistFlags && (value("--host") != null || rawPort != null || value("--url") != null)) {
    if ((!isLoopbackHost(next.host) || next.publicUrl) && !configuredAuth(config)) {
      throw new Error("非 loopback Web 监听必须先执行 stmem web auth rotate 配置 Web API Token");
    }
    config.web = { ...next, ...(current.auth ? { auth: current.auth } : {}) };
    saveConfig(config);
  }
  return next;
}

function assertNetworkAuth(config) {
  if ((!isLoopbackHost(config.host) || config.publicUrl) && !configuredAuth(loadConfig())) {
    const migration = ensureLegacyWebAuth();
    if (migration.migrated) console.warn("已为旧版远程 Web 配置自动启用访问保护。请执行 stmem web auth claim 领取一次性登录 Token。");
  }
}

function warnInsecureNetworkHttp(config) {
  if (!isLoopbackHost(config.host) && !/^https:/i.test(config.publicUrl || "")) {
    console.warn("安全警告：当前 Web API 在非 loopback HTTP 上运行。访问令牌和浏览器会话可能被网络监听；建议使用 HTTPS、可信反向代理或 VPN。");
  }
}

function remindBootstrapToken() {
  if (webSecurityStatus().bootstrapPending) {
    console.warn("旧版远程 Web 的一次性登录 Token 正在等待领取。请执行 stmem web auth claim。");
  }
}

function runAuthCommand() {
  const subcommand = args.shift() || "status";
  if (subcommand === "status") {
    console.log(JSON.stringify(webSecurityStatus(), null, 2));
    return;
  }
  if (subcommand === "rotate") {
    const result = rotateWebApiToken();
    if (args.includes("--json")) console.log(JSON.stringify({ ...result, notice:TOKEN_ROTATION_NOTICE }));
    else {
      console.log(`Web API Token 已生成。${TOKEN_ROTATION_NOTICE}请立即保存，之后无法再次查看：`);
      console.log(result.token);
    }
    return;
  }
  if (subcommand === "claim") {
    const token = claimBootstrapToken();
    if (!token) throw new Error("没有待领取的旧版 Web 迁移 Token；如需新 Token，请执行 stmem web auth rotate");
    if (args.includes("--json")) console.log(JSON.stringify({ claimed:true, token }));
    else {
      console.log("旧版 Web 访问已完成安全迁移。登录 Token 只显示这一次：");
      console.log(token);
    }
    return;
  }
  if (subcommand === "devices") {
    const devices = listWebDevices();
    console.log(args.includes("--json") ? JSON.stringify({ devices }) : JSON.stringify({ devices }, null, 2));
    return;
  }
  if (subcommand === "revoke") {
    const deviceId = value("--device");
    if (!deviceId) throw new Error("请指定 --device <设备ID>");
    const revoked = revokeWebDevice(deviceId);
    console.log(args.includes("--json") ? JSON.stringify({ revoked, deviceId }) : (revoked ? `已撤销设备 ${deviceId}` : "没有找到这个设备"));
    return;
  }
  if (subcommand === "clear") {
    clearWebDevices();
    console.log(args.includes("--json") ? JSON.stringify({ cleared:true }) : "已撤销全部 Web 登录设备");
    return;
  }
  throw new Error("用法：stmem web auth status | rotate | claim | devices | revoke --device <ID> | clear [--json]");
}

function localNetworkUrls(port) {
  const addresses = [];
  for (const rows of Object.values(os.networkInterfaces())) {
    for (const row of rows || []) {
      if (row.family !== "IPv4" || row.internal || !row.address) continue;
      addresses.push(`http://${row.address}:${port}`);
    }
  }
  return [...new Set(addresses)].sort();
}

function restartAfterAccessChange() {
  const existing = readManagedPid(PID_FILE, MARKER);
  if (existing) stopManagedProcess({ pidFile: PID_FILE, marker: MARKER });
  return startBackground();
}

function runLanCommand() {
  const subcommand = args.shift() || "status";
  const json = args.includes("--json");
  if (subcommand === "status") {
    const config = webConfig();
    const result = {
      enabled: !isLoopbackHost(config.host),
      running: Boolean(readManagedPid(PID_FILE, MARKER)),
      host: config.host,
      port: config.port,
      authentication: webSecurityStatus(),
      urls: !isLoopbackHost(config.host) ? localNetworkUrls(config.port) : [],
    };
    console.log(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "enable") {
    const auth = rotateWebApiToken();
    const config = loadConfig();
    const port = Number(config.web?.port) || 4173;
    config.web = { ...(config.web || {}), host:"0.0.0.0", port, publicUrl:"", auth:config.web.auth };
    saveConfig(config);
    const processResult = restartAfterAccessChange();
    const result = { enabled:true, running:true, pid:processResult.pid, host:"0.0.0.0", port, urls:localNetworkUrls(port), token:auth.token, notice:TOKEN_ROTATION_NOTICE };
    if (json) console.log(JSON.stringify(result));
    else {
      console.log("Stone Memory 局域网访问已开启。");
      for (const url of result.urls) console.log(`访问地址：${url}`);
      if (!result.urls.length) console.log(`访问地址：请使用这台设备的局域网 IPv4 地址和端口 ${port}`);
      console.log(`登录 Token 只显示这一次，请立即保存。${TOKEN_ROTATION_NOTICE}`);
      console.log(result.token);
      console.warn("安全提示：当前为局域网 HTTP，请只在可信网络中使用。");
    }
    return;
  }
  if (subcommand === "disable") {
    const config = loadConfig();
    const port = Number(config.web?.port) || 4173;
    const nextWeb = { ...(config.web || {}), host:"127.0.0.1", port, publicUrl:"" };
    delete nextWeb.auth;
    config.web = nextWeb;
    saveConfig(config);
    clearBootstrapToken();
    clearWebDevices();
    const processResult = restartAfterAccessChange();
    const result = { enabled:false, running:true, pid:processResult.pid, host:"127.0.0.1", port, url:`http://127.0.0.1:${port}` };
    console.log(json ? JSON.stringify(result) : `Stone Memory 局域网访问已关闭；仅本机可访问：${result.url}`);
    return;
  }
  throw new Error("用法：stmem web lan enable | disable | status [--json]");
}

function startBackground() {
  const config = webConfig({ persistFlags: true });
  assertNetworkAuth(config);
  warnInsecureNetworkHttp(config);
  return startManagedProcess({
    script: WATCH_SCRIPT,
    pidFile: PID_FILE,
    marker: MARKER,
    args: ["--host", config.host, "--port", String(config.port)],
    logFile: LOG_FILE,
  });
}

async function serve() {
  const config = webConfig();
  assertNetworkAuth(config);
  warnInsecureNetworkHttp(config);
  const watchChild = args.includes("--watch-child");
  if (!watchChild) {
    const existing = readManagedPid(PID_FILE, MARKER);
    if (existing && existing !== process.pid) throw new Error(`Stone Memory 前端已运行 (pid ${existing})`);
    fs.mkdirSync(STONE, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
    const cleanup = () => {
      try {
        if (Number(fs.readFileSync(PID_FILE, "utf8")) === process.pid) fs.rmSync(PID_FILE, { force: true });
      } catch {}
    };
    process.once("exit", cleanup);
  }
  const server = await startWebServer({ host: config.host, port: config.port });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const address = server.address();
  console.log(`Stone Memory 前端已启动：http://${address.address}:${address.port}`);
  if (config.publicUrl) console.log(`前端访问地址：${config.publicUrl}`);
  console.log("按 Ctrl+C 停止。");
}

function startDevelopmentServer() {
  const config = webConfig({ persistFlags: true });
  assertNetworkAuth(config);
  warnInsecureNetworkHttp(config);
  const existing = readManagedPid(PID_FILE, MARKER);
  if (existing) throw new Error(`后台 Web 正在运行 (pid ${existing})；请先执行 stmem web stop，再启动 dev`);
  console.log(`Stone Memory dev：http://${config.host}:${config.port}`);
  console.log("后端 JS 变化会自动重启；HTML/CSS/前端 JS 无需重启，刷新浏览器即可读取最新文件。");
  const child = spawn(process.execPath, [WATCH_SCRIPT, "--foreground", "--host", config.host, "--port", String(config.port)], {
    stdio: "inherit",
    env: process.env,
  });
  return new Promise((resolve, reject) => {
    let stopping = false;
    const forward = signal => {
      stopping = true;
      if (!child.killed) child.kill(signal);
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      if (code && !stopping) reject(new Error(`Stone Memory dev 退出（${signal || `code ${code}`}）`));
      else resolve();
    });
  });
}

async function main() {
  if (action === "auth") return runAuthCommand();
  if (action === "lan") return runLanCommand();
  if (action === "serve") return serve();
  if (action === "dev") return startDevelopmentServer();
  if (action === "config") {
    const config = webConfig({ persistFlags: true });
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (action === "status") {
    const pid = readManagedPid(PID_FILE, MARKER);
    const config = webConfig();
    console.log(`Stone Memory 前端：${pid ? `运行中 (pid ${pid})` : "未运行"}`);
    console.log(`监听 ${config.host}:${config.port}${config.publicUrl ? ` · 访问 ${config.publicUrl}` : ""}`);
    remindBootstrapToken();
    return;
  }
  if (action === "stop" || action === "restart") {
    const result = stopManagedProcess({ pidFile: PID_FILE, marker: MARKER });
    console.log(result.stopped ? `Stone Memory 前端已停止 (pid ${result.pid})` : "Stone Memory 前端原本未运行");
  }
  if (action === "start" || action === "restart") {
    const result = startBackground();
    console.log(result.started ? `Stone Memory 前端已启动 (pid ${result.pid})` : `Stone Memory 前端已在运行 (pid ${result.pid})`);
    remindBootstrapToken();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
