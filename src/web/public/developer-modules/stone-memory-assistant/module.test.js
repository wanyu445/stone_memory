"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("module satisfies the detachable developer contract", () => {
  for (const file of ["module.json", "index.html", "app.js", "styles.css", "bootstrap.js"]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} must exist`);
  }
  const metadata = JSON.parse(read("module.json"));
  assert.equal(metadata.id, "stone-memory-assistant");
  assert.equal(metadata.name, "Stone Memory 小助理");
  assert.equal(metadata.contributor, "@不知道昵称");
  const html = read("index.html");
  assert.match(html, /\/developer-kit\/runtime\.js/);
  assert.match(html, /<stone-module-page\b/);
  assert.match(html, /\/developer-modules\/stone-memory-assistant\/app\.js/);
  assert.doesNotMatch(html, /aion-pet/);
});

test("developer mode bootstrap exposes the demo for the current memory body", () => {
  const bootstrap = read("bootstrap.js");
  assert.match(bootstrap, /data-developer-module/);
  assert.match(bootstrap, /Demo · 测试功能/);
  assert.match(bootstrap, /贡献人：@不知道昵称/);
  assert.match(bootstrap, /\.workspace/);
  assert.match(bootstrap, /dataset\.threadId/);
  assert.match(bootstrap, /\/developer-modules\/\$\{MODULE_ID\}\/\?threadId=/);
});

test("module consumes theme variables without persisting assistant or business state", () => {
  const css = read("styles.css");
  const app = read("app.js");
  assert.match(css, /--stone-theme-accent/);
  assert.match(css, /--stone-theme-surface/);
  assert.match(css, /--stone-theme-radius/);
  assert.match(css, /--stone-theme-shadow/);
  assert.doesNotMatch(app, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(app, /\.apiKey\b|\[\s*["']apiKey["']\s*\]/);
  assert.doesNotMatch(app, /setInterval/);
});

test("guide has eight steps, skip controls, and never opens automatically", () => {
  const html = read("index.html");
  const app = read("app.js");
  for (const id of ["assistant-revisit-guide", "assistant-guide-progress", "assistant-guide-step-title", "assistant-guide-step-copy", "assistant-guide-prev", "assistant-guide-next", "assistant-guide-restart", "assistant-guide-skip"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.equal([...app.matchAll(/\{ title: \(\) =>/g)].length, 8);
  assert.doesNotMatch(app, /hasSeenOnboarding|if \([^)]*\) openGuide/);
  assert.match(app, /assistant-revisit-guide/);
  assert.match(app, /switchPanelTab\("chat", \{ focus: !state\.mobileMode \}\)/);
  assert.match(app, /这个问题藏得有点深啦/);
  assert.match(app, /这个问题我暂时还没有学会呢/);
});

test("floating assistant panel has three accessible, independently scrolling views", () => {
  const html = read("index.html");
  const css = read("styles.css");
  const app = read("app.js");
  assert.equal([...html.matchAll(/data-assistant-tab=/g)].length, 3);
  for (const view of ["chat", "log", "guide"]) {
    assert.match(html, new RegExp(`id="assistant-tab-${view}"[\\s\\S]*aria-controls="assistant-view-${view}"`));
    assert.match(html, new RegExp(`id="assistant-view-${view}"[\\s\\S]*data-assistant-view="${view}"`));
  }
  assert.match(css, /\.assistant-widget\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.assistant-panel\s*\{[^}]*max-height:/);
  assert.match(css, /\.assistant-view\s*\{[^}]*height:\s*100%/);
  assert.match(css, /\.assistant-view-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /event\.key === "ArrowRight"/);
  assert.match(app, /restoreFocus/);
  assert.match(app, /messages\.scrollTop = messages\.scrollHeight/);
  assert.doesNotMatch(app, /scrollIntoView/);
});

test("mobile shell uses a blocking backdrop and near-full visual viewport panel", () => {
  const html = read("index.html");
  const css = read("styles.css");
  assert.match(html, /id="assistant-backdrop"[^>]*aria-hidden="true"[^>]*hidden/);
  assert.match(html, /id="assistant-panel"[^>]*role="dialog"[^>]*tabindex="-1"/);
  assert.match(css, /body\.assistant-mobile \.assistant-panel/);
  assert.match(css, /--assistant-visual-height/);
  assert.match(css, /100dvh/);
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /body\.assistant-mobile-panel-open/);
});

test("mobile launcher interaction is stateful without changing desktop hover behavior", () => {
  const app = read("app.js");
  assert.match(app, /logic\.mobileLauncherAction/);
  assert.match(app, /logic\.MOBILE_TAP_WINDOW_MS/);
  assert.match(app, /INTERACTION_BUBBLES\[state\.interactionIndex\][\s\S]*再点一下和我说话/);
  assert.match(app, /if \(!state\.mobileMode\) playInteraction\(\)/);
  assert.match(app, /window\.addEventListener\("orientationchange"/);
  assert.match(app, /document\.body\.classList\.toggle\("assistant-mobile"/);
  assert.match(app, /document\.body\.classList\.add\("assistant-mobile-panel-open"/);
  assert.match(app, /window\.scrollTo\(0, scrollY\)/);
});

test("mobile panel follows the visual viewport without forcing the software keyboard", () => {
  const css = read("styles.css");
  const app = read("app.js");
  assert.match(app, /function updateVisualViewportMetrics\(\)/);
  assert.match(app, /window\.visualViewport/);
  assert.match(app, /viewport\?\.height \|\| window\.innerHeight/);
  assert.match(app, /visualViewport\?\.addEventListener\("resize", updateVisualViewportMetrics\)/);
  assert.match(app, /visualViewport\?\.addEventListener\("scroll", updateVisualViewportMetrics\)/);
  assert.match(app, /switchPanelTab\(tab, \{ focus: tab === "chat" && !state\.mobileMode \}\)/);
  assert.match(app, /if \(state\.mobileMode\) panel\.focus\(\{ preventScroll: true \}\)/);
  assert.match(css, /body\.assistant-mobile \.assistant-form input[^}]*font-size:\s*16px/);
  assert.match(css, /body\.assistant-mobile \.quick-actions[^}]*overflow-x:\s*auto/);
});

test("mobile modal traps focus and keeps background content inert", () => {
  const app = read("app.js");
  assert.match(app, /function trapMobilePanelFocus\(event\)/);
  assert.match(app, /event\.key !== "Tab"/);
  assert.match(app, /panel\.setAttribute\("aria-modal", "true"\)/);
  assert.match(app, /node\.inert = inert/);
  assert.match(app, /launcher\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(app, /launcher\.removeAttribute\("aria-hidden"\)/);
  assert.doesNotMatch(app, /popstate|history\.pushState/);
});

test("selected Codex Pet package and all nine atlas states are present", () => {
  const pet = JSON.parse(read(path.join("assets", "mochabuding", "pet.json")));
  const notice = read(path.join("assets", "mochabuding", "NOTICE.md"));
  const app = read("app.js");
  assert.equal(pet.id, "mochabuding");
  assert.equal(pet.displayName, "抹茶布丁");
  assert.equal(pet.spritesheetPath, "spritesheet.webp");
  assert.equal(fs.existsSync(path.join(root, "assets", "mochabuding", pet.spritesheetPath)), true);
  assert.match(notice, /@不知道昵称/);
  assert.match(notice, /AGPL-3\.0-only/);
  assert.match(notice, /1536 × 1872 px/);
  assert.match(notice, /192 × 208 px/);
  for (const state of ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"]) {
    assert.match(app, new RegExp(`(?:\\"${state}\\"|${state}): \\{ row:`));
  }
  assert.doesNotMatch(app, /assets\/aion/);
  assert.doesNotMatch(app, /chono-hina/);
});

test("desktop assistant identity and hover interaction preserve task-state priority", () => {
  const html = read("index.html");
  const app = read("app.js");
  assert.match(html, /id="assistant-nickname"/);
  assert.match(html, /id="assistant-launcher-label"/);
  for (const line of ["我在呢", "今天也要好好整理记忆呀", "让我看看有什么待处理", "来和我说说要做什么吧", "今天的能量补充完毕"]) {
    assert.match(app, new RegExp(line));
  }
  assert.match(app, /launcher\.addEventListener\("mouseenter", \(\) => \{ if \(!state\.mobileMode\) playInteraction\(\); \}\)/);
  assert.match(app, /launcher\.addEventListener\("mouseleave", \(\) => \{ if \(!state\.mobileMode\) restoreInteraction/);
  assert.match(app, /PHASE_PRIORITY\[state\.phase\] === PHASE_PRIORITY\.idle/);
  assert.match(app, /nicknameForThread\(stoneModule\.threadId\)/);
});

test("browser adapter only references existing Stone Memory API families", () => {
  const app = read("app.js");
  const endpoints = [...app.matchAll(/\/api\/libraries\/:threadId\/([a-z/-]+)/g)].map(match => match[1]);
  assert.ok(endpoints.length > 0);
  assert.deepEqual([...new Set(endpoints)].sort(), [
    "feelings",
    "mining/start",
    "mining/status",
    "mining/stop",
    "overview"
  ]);
  assert.doesNotMatch(app, /\/timeline\b/);
  assert.doesNotMatch(app, /\/settings\b|\/rebuild\b/);
  assert.doesNotMatch(app, /apiKey|apiProvider|baseUrl|\bmodel\b/);
  assert.match(app, /placeholder: "请选择通道"/);
  assert.match(app, /logic\.validateMiningPlan\(plan, latest\)/);
});

test("maintenance flow covers explicit today mining and safe rebuild guidance", () => {
  const html = read("index.html");
  const app = read("app.js");
  const logic = read("logic.js");
  assert.match(html, /data-command="整理昨天"/);
  assert.match(logic, /type: "mine_today"/);
  assert.match(app, /command\.type === "mine_today"/);
  assert.match(app, /今天尚未结束/);
  assert.match(app, /对话：\$\{messageCount\} 条/);
  assert.match(app, /forceDates: \[\]/);
  assert.match(app, /if \(automatic\)[\s\S]*showRebuildGuidance/);
  assert.match(app, /维护 → 重建上下文/);
  assert.match(app, /避免把密钥、本机路径等设置读取到浏览器/);
  assert.match(app, /loadSpriteAssets\(\);\s*renderGuideStep\(\);\s*await refreshContext\(\);\s*} catch/);
});

test("write confirmations, mining start, and stop fail closed on stale state", () => {
  const app = read("app.js");
  assert.match(app, /confirmationSequence/);
  assert.match(app, /pendingConfirmation/);
  assert.match(app, /invalidatePendingConfirmation\(\)/);
  assert.match(app, /runExclusiveWrite/);
  assert.match(app, /if \(state\.writeInFlight\) throw new Error/);
  assert.match(app, /const latest = await api\(threadPath\("\/api\/libraries\/:threadId\/mining\/status"\)/);
  assert.match(app, /logic\.validateMiningPlan\(plan, latest\)/);
  assert.match(app, /const expectedJobId = state\.mining\.job\.id/);
  assert.match(app, /logic\.canStopJob\(latest, expectedJobId\)/);
});

test("polling and temporary phases ignore stale callbacks", () => {
  const app = read("app.js");
  assert.match(app, /state\.pollTimer = 0;\s*state\.pollGeneration \+= 1/);
  assert.match(app, /state\.pollTimer = 0;\s*pollMining\(generation\)/);
  assert.match(app, /if \(generation !== state\.pollGeneration\) return/);
  assert.match(app, /state\.automaticJobId === job\.id/);
  assert.match(app, /state\.phaseVersion === version/);
  assert.doesNotMatch(app, /setTimeout\(\(\) => setPhase\("idle"\)/);
});

test("visible assistant identity uses only the stable nickname", () => {
  const html = read("index.html");
  const app = read("app.js");
  assert.doesNotMatch(html, /抹茶布丁/);
  assert.doesNotMatch(app, /抹茶布丁/);
  assert.match(html, /id="assistant-panel-title">Stone Memory 小助理/);
  assert.match(app, /assistant-launcher-label"\)\.textContent = nickname/);
});

test("work log is bounded, grouped, expandable, and does not persist session actions", () => {
  const html = read("index.html");
  const css = read("styles.css");
  const app = read("app.js");
  for (const id of ["assistant-log-refresh", "assistant-log-list"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /logic\.mergeLogs\(systemLogs, state\.sessionLogs, 30\)/);
  assert.match(app, /state\.logsDirty/);
  assert.match(app, /signature === state\.logSignature/);
  assert.match(app, /state\.openLogIds/);
  assert.match(app, /previousScrollTop/);
  assert.match(app, /document\.createElement\("details"\)/);
  assert.match(css, /\.assistant-log-date\s*\{[^}]*position:\s*sticky/);
  assert.match(css, /\.assistant-view-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*sessionLogs|localStorage\.getItem\([^)]*sessionLogs/);
});

test("open panels suppress external bubbles and errors use the safe mapper", () => {
  const app = read("app.js");
  assert.match(app, /if \(!\$\("#assistant-panel"\)\.hidden\) \{\s*hideBubble\(\);\s*return;/);
  assert.match(app, /return logic\.friendlyErrorMessage\(error\)/);
  assert.doesNotMatch(app, /error\?\.message/);
});

test("manual tasks explain real paths and only return to the current workbench", () => {
  const html = read("index.html");
  const app = read("app.js");
  for (const task of ["trim", "import", "remine", "summary"]) assert.match(html, new RegExp(`data-manual-task="${task}"`));
  for (const pathText of ["维护 → 重建上下文 → 原文 → 裁剪对话 / 工具链", "维护 → 对话导入", "维护 → 记忆挖掘 → 选择日期 → 精准补挖", "记忆档案 → 摘要"]) assert.match(app, new RegExp(pathText));
  assert.match(app, /stoneModule\.returnToDeveloperMode\(\)/);
  assert.match(app, /还不能精确打开内部子页面/);
});

test("missing or invalid thread state can hide every interactive module surface", () => {
  const html = read("index.html");
  const app = read("app.js");
  for (const id of ["assistant-unavailable", "assistant-dashboard", "assistant-guide", "assistant-widget"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /\$\("#assistant-unavailable"\)\.hidden = false/);
  assert.match(app, /\$\("#assistant-dashboard"\)\.hidden = true/);
  assert.match(app, /\$\("#assistant-guide"\)\.hidden = true/);
  assert.match(app, /\$\("#assistant-widget"\)\.hidden = true/);
});
