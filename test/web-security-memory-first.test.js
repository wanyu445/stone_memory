const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const stmem = path.join(root, "bin", "stmem");

function run(home, args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [stmem, ...args], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
}

test("Memory-first remote Web hides Binding paths and cannot name server files", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-web-security-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const created = run(home, ["memory", "create", "--name", "安全记忆"]);
  assert.equal(created.status, 0, created.stderr);
  const memoryId = JSON.parse(created.stdout).memory.memoryId;

  const settings = path.join(home, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({
    label: "安全记忆", purpose: "coding", ai: "A", user: "U",
    miner: { mode: "subagent", apiProfile: null },
  }));
  for (const apply of [false, true]) {
    const result = run(home, ["memory", "settings", "--memory", memoryId, "--batch-file", settings, ...(apply ? ["--apply"] : ["--validate"])]);
    assert.equal(result.status, 0, result.stderr);
  }

  const sessionRoot = path.join(home, "private-sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, "rollout-external-safe.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: "external-safe", base_instructions: "test" } }) + "\n");
  const binding = path.join(home, "binding.json");
  fs.writeFileSync(binding, JSON.stringify({
    provider: "codex", externalThreadId: "external-safe", sessionRoot, mode: "primary",
  }));
  const bound = run(home, ["binding", "add", "--memory", memoryId, "--batch-file", binding, "--apply"]);
  assert.equal(bound.status, 0, bound.stderr);

  const rotated = run(home, ["web", "auth", "rotate", "--json"]);
  assert.equal(rotated.status, 0, rotated.stderr);
  const token = JSON.parse(rotated.stdout).token;
  const serverPath = path.join(root, "src", "web", "server.js");
  const script = `
    const http = require("http");
    const { startWebServer } = require(${JSON.stringify(serverPath)});
    const token = process.argv[1], memoryId = process.argv[2], localPath = process.argv[3];
    const call = (port, method, pathname, body) => new Promise((resolve, reject) => {
      const payload = body === undefined ? "" : JSON.stringify(body);
      const req = http.request({
        host: "127.0.0.1", port, method, path: pathname,
        headers: { host: "192.168.1.20:" + port, authorization: "Bearer " + token, "content-type": "application/json" },
      }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(payload);
    });
    (async () => {
      const server = await startWebServer({ host: "0.0.0.0", port: 0 });
      const port = server.address().port;
      const settings = await call(port, "GET", "/api/libraries/" + encodeURIComponent(memoryId) + "/settings");
      const binding = await call(port, "POST", "/api/libraries/" + encodeURIComponent(memoryId) + "/bindings", {
        provider: "codex", externalThreadId: "remote-thread", threadFile: localPath, apply: true,
      });
      const probe = await call(port, "POST", "/api/session-file/check", {
        threadId: "external-safe", sessionDir: localPath,
      });
      const draft = await call(port, "POST", "/api/libraries", { libraryName: "远程草稿" });
      await new Promise(resolve => server.close(resolve));
      console.log(JSON.stringify({ settings, binding, probe, draft }));
    })().catch(error => { console.error(error.stack); process.exit(1); });
  `;
  const child = spawnSync(process.execPath, ["-e", script, token, memoryId, sessionRoot], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.settings.status, 200);
  const publicSettings = JSON.parse(result.settings.body);
  assert.equal(publicSettings.memoryId, memoryId);
  assert.equal(publicSettings.sessionDir, "");
  assert.equal(result.settings.body.includes(sessionRoot), false);
  assert.equal(result.binding.status, 400);
  assert.match(result.binding.body, /不能为 Binding 指定服务器本地来源路径/);
  assert.equal(result.probe.status, 400);
  assert.match(result.probe.body, /不能探测服务器本地线程文件目录/);
  assert.equal(result.draft.status, 201, result.draft.body);
  assert.match(JSON.parse(result.draft.body).library.memoryId, /^[0-9a-f-]{36}$/);
});

test("Web auth stores only a verifier and token rotation invalidates old sessions", () => {
  const { createWebAuth, hashToken, isRemoteRequest } = require("../src/security/web-auth");
  let verifier = hashToken("stmem_old_token");
  const configProvider = () => ({ web: { auth: { tokenVerifier: verifier, tokenVersion: 1 } } });
  let now = 1_000;
  const auth = createWebAuth({ host: "0.0.0.0", configProvider, now: () => now });
  const request = (headers = {}, method = "GET") => ({
    method, headers, socket: { remoteAddress: "127.0.0.1", encrypted: false },
  });
  assert.equal(auth.authenticate(request({ authorization: "Bearer stmem_old_token" })).kind, "bearer");
  const cookie = auth.unlock("stmem_old_token", request());
  const session = cookie.split(";")[0];
  assert.equal(auth.authenticate(request({ cookie: session })).kind, "session");
  const secondDeviceCookie = auth.unlock("stmem_old_token", request()).split(";")[0];
  assert.equal(auth.authenticate(request({ cookie: secondDeviceCookie })).kind, "session");
  verifier = hashToken("stmem_new_token");
  assert.throws(() => auth.authenticate(request({ authorization: "Bearer stmem_old_token" })), /访问令牌/);
  assert.throws(() => auth.authenticate(request({ cookie: session })), /访问令牌/);
  assert.equal(auth.authenticate(request({ authorization: "Bearer stmem_new_token" })).kind, "bearer");
  assert.equal(isRemoteRequest({ socket:{ remoteAddress:"127.0.0.1" }, headers:{ host:"localhost:4173" } }), false);
  assert.equal(isRemoteRequest({ socket:{ remoteAddress:"127.0.0.1" }, headers:{ host:"192.168.1.20:4173" } }), true);
  assert.equal(isRemoteRequest({ socket:{ remoteAddress:"192.168.1.30" }, headers:{ host:"localhost:4173" } }), true);
});

test("HTTPS reverse proxies keep same-origin login and Secure device cookies", () => {
  const { createWebAuth, hashToken } = require("../src/security/web-auth");
  const verifier = hashToken("stmem_proxy_token");
  const auth = createWebAuth({
    host:"127.0.0.1",
    configProvider:() => ({ web:{ auth:{ tokenVerifier:verifier, tokenVersion:1 } } }),
  });
  const request = (method, headers) => ({ method, headers, socket:{ remoteAddress:"127.0.0.1", encrypted:false } });
  const unlockRequest = request("POST", { host:"stone.example.ts.net", origin:"https://stone.example.ts.net", "user-agent":"Mobile" });
  const cookie = auth.unlock("stmem_proxy_token", unlockRequest);
  assert.match(cookie, /; Secure$/);
  const principal = auth.authenticate(request("POST", { host:"stone.example.ts.net", origin:"https://stone.example.ts.net", cookie:cookie.split(";")[0] }));
  assert.doesNotThrow(() => auth.assertSameOrigin(unlockRequest, principal));

  const unconfigured = createWebAuth({ host:"127.0.0.1", configProvider:() => ({ web:{} }) });
  const proxyRequest = request("GET", { host:"stone.example.ts.net" });
  assert.equal(unconfigured.status(proxyRequest).authenticationRequired, true);
  assert.throws(() => unconfigured.authenticate(proxyRequest), /需要先配置/);
});

test("first remote proxy visit migrates a legacy loopback Web install into the login flow", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-proxy-upgrade-"));
  t.after(() => fs.rmSync(home, { recursive:true, force:true }));
  const stone = path.join(home, ".stone_memory");
  fs.mkdirSync(stone, { recursive:true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({ web:{ host:"127.0.0.1", port:4173 } }), { mode:0o600 });
  const serverPath = path.join(root, "src", "web", "server.js");
  const script = `
    const http=require("http");
    const {startWebServer}=require(${JSON.stringify(serverPath)});
    (async()=>{const server=await startWebServer({host:"127.0.0.1",port:0});const port=server.address().port;
      const body=await new Promise((resolve,reject)=>{const req=http.request({host:"127.0.0.1",port,path:"/api/auth/status",headers:{host:"memory.example.ts.net"}},res=>{const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve(Buffer.concat(chunks).toString("utf8")));});req.on("error",reject);req.end();});
      await new Promise(resolve=>server.close(resolve));console.log(body);
    })().catch(error=>{console.error(error.stack);process.exit(1)});`;
  const child = spawnSync(process.execPath, ["-e", script], { cwd:root, env:{ ...process.env, HOME:home, USERPROFILE:home }, encoding:"utf8", timeout:20_000 });
  assert.equal(child.status, 0, child.stderr);
  const status = JSON.parse(child.stdout);
  assert.deepEqual(status, { authenticationRequired:true, enabled:true, bootstrapPending:true });
  assert.match(JSON.parse(fs.readFileSync(path.join(stone, "stmem.json"), "utf8")).web.auth.tokenVerifier, /^sha256:/u);
  assert.equal(fs.existsSync(path.join(stone, "web-auth-bootstrap")), true);
});

test("browser device sessions survive Web restarts without storing cookie secrets", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-device-"));
  t.after(() => fs.rmSync(home, { recursive:true, force:true }));
  const file = path.join(home, ".stone_memory", "web-sessions.json");
  const { createWebSessionStore, DEVICE_TTL_MS } = require("../src/services/web-security");
  const { createWebAuth, hashToken } = require("../src/security/web-auth");
  let now = 10_000;
  const verifier = hashToken("stmem_device_token");
  const configProvider = () => ({ web:{ auth:{ tokenVerifier:verifier, tokenVersion:1 } } });
  const request = headers => ({ method:"GET", headers, socket:{ remoteAddress:"192.168.1.30", encrypted:false } });
  const firstStore = createWebSessionStore({ file, trustedRoot:home, now:() => now });
  const firstAuth = createWebAuth({ host:"0.0.0.0", configProvider, now:() => now, sessionStore:firstStore });
  const cookie = firstAuth.unlock("stmem_device_token", request({ "user-agent":"Mobile Browser" })).split(";")[0];
  const secondCookie = firstAuth.unlock("stmem_device_token", request({ "user-agent":"Desktop Browser" })).split(";")[0];
  const credential = cookie.split("=")[1];
  assert.equal(firstStore.list().length, 2);
  assert.equal(fs.readFileSync(file, "utf8").includes(credential), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const restartedAuth = createWebAuth({
    host:"0.0.0.0", configProvider, now:() => now,
    sessionStore:createWebSessionStore({ file, trustedRoot:home, now:() => now }),
  });
  assert.equal(restartedAuth.authenticate(request({ cookie })).kind, "session");
  assert.equal(restartedAuth.authenticate(request({ cookie:secondCookie })).kind, "session");
  now += DEVICE_TTL_MS + 1;
  assert.throws(() => restartedAuth.authenticate(request({ cookie })), /访问令牌/);
});

test("Web frontend contains an authenticated unlock gate and never asks for an existing API key again", () => {
  const app = fs.readFileSync(path.join(root, "src", "web", "public", "app.js"), "utf8");
  const cli = fs.readFileSync(path.join(root, "scripts", "stmem-web.js"), "utf8");
  assert.match(app, /\/api\/auth\/status/);
  assert.match(app, /\/api\/auth\/unlock/);
  assert.match(app, /\/api\/web-access/);
  assert.match(app, /成功后会记住这台设备 30 天/);
  assert.match(cli, /Web API Token 已生成。\$\{TOKEN_ROTATION_NOTICE\}/);
  assert.match(cli, /const TOKEN_ROTATION_NOTICE = "新 Token 可用于多个设备登录；此前的旧 Token 及其设备会话将失效。"/);
  assert.match(app, /if \(!status\.authenticationRequired\) return startStoneMemory\(\)/);
  assert.match(app, /try \{ return await startStoneMemory\(\); \}/);
  assert.match(app, /error\.status === 401 \|\| error\.status === 503/);
  assert.match(app, /config\.hasApiKey \? `placeholder="已配置；留空保持不变"` : "required"/);
  assert.match(cli, /subcommand === "enable"/);
  assert.match(cli, /host:"0\.0\.0\.0"/);
  assert.match(cli, /subcommand === "disable"/);
  assert.match(cli, /stmem web auth claim/);
});

test("LAN status is read-only and defaults to loopback", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-lan-status-"));
  t.after(() => fs.rmSync(home, { recursive:true, force:true }));
  const result = run(home, ["web", "lan", "status", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.enabled, false);
  assert.equal(status.host, "127.0.0.1");
  assert.deepEqual(status.urls, []);
});

test("legacy non-loopback Web config migrates without exposing its bootstrap token", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-upgrade-"));
  t.after(() => fs.rmSync(home, { recursive:true, force:true }));
  const stone = path.join(home, ".stone_memory"), configFile = path.join(stone, "stmem.json");
  fs.mkdirSync(stone, { recursive:true });
  fs.writeFileSync(configFile, JSON.stringify({ web:{ host:"0.0.0.0", port:4173 } }), { mode:0o600 });
  const service = path.join(root, "src", "services", "web-security.js");
  const migrated = spawnSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(service)}).ensureLegacyWebAuth()))`], {
    cwd:root, env:{ ...process.env, HOME:home, USERPROFILE:home }, encoding:"utf8",
  });
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(JSON.parse(migrated.stdout).migrated, true);
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.match(config.web.auth.tokenVerifier, /^sha256:/);
  assert.equal(JSON.stringify(config).includes("stmem_"), false);
  const bootstrap = path.join(stone, "web-auth-bootstrap");
  if (process.platform !== "win32") assert.equal(fs.statSync(bootstrap).mode & 0o777, 0o600);
  const claimed = run(home, ["web", "auth", "claim", "--json"]);
  assert.equal(claimed.status, 0, claimed.stderr);
  assert.match(JSON.parse(claimed.stdout).token, /^stmem_/);
  assert.equal(fs.existsSync(bootstrap), false);
  const claimedAgain = run(home, ["web", "auth", "claim", "--json"]);
  assert.notEqual(claimedAgain.status, 0);
});
