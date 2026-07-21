const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

const state = {
  libraries: [], step: 1, imports: [],
  form: { libraryName: "", threadId: "", ai: "", user: "", userGender: "unspecified", runtime: "codex", purpose: "accompany", sessionDir: "", minerMode: "subagent", apiProvider: "deepseek", apiKey: "", baseUrl: "", windowDays: 3, keepToolPairs: 30, automaticFullMining: true, automaticMemoryMaintenance: true },
};

function stoneSvg(className = "hero-stone") {
  return `<svg class="${className}" viewBox="0 0 320 260" role="img" aria-label="一块生着青苔、头顶开着小花的石头">
    <defs><linearGradient id="rock" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#aab7a1"/><stop offset="1" stop-color="#718173"/></linearGradient><linearGradient id="moss" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#91b078"/><stop offset="1" stop-color="#5f8055"/></linearGradient></defs>
    <path d="M72 213c-3-31 7-79 27-108 15-22 37-34 67-31 35 3 61 25 73 55 13 32 14 62 7 84z" fill="url(#rock)" stroke="#667666" stroke-width="4"/>
    <path d="M89 151c12-5 19-21 34-24 18-4 24 14 41 8 18-6 26-28 44-24 13 3 19 15 25 27-7-36-31-62-66-65-31-3-53 10-69 33-10 15-17 30-21 47z" fill="url(#moss)"/>
    <circle cx="127" cy="112" r="8" fill="#b8ce98"/><circle cx="210" cy="137" r="7" fill="#9fbe83"/><circle cx="105" cy="177" r="5" fill="#617764" opacity=".45"/>
    <path d="M163 76c0-22 3-37 13-51" fill="none" stroke="#5d8056" stroke-width="5" stroke-linecap="round"/>
    <path d="M175 38c-17-4-24-14-19-26 15 1 24 10 19 26z" fill="#7da46d"/>
    <g transform="translate(178 21)"><ellipse rx="13" ry="8" transform="rotate(0) translate(13 0)" fill="#f4d5c4"/><ellipse rx="13" ry="8" transform="rotate(72) translate(13 0)" fill="#f0c7b4"/><ellipse rx="13" ry="8" transform="rotate(144) translate(13 0)" fill="#f4d5c4"/><ellipse rx="13" ry="8" transform="rotate(216) translate(13 0)" fill="#f0c7b4"/><ellipse rx="13" ry="8" transform="rotate(288) translate(13 0)" fill="#f4d5c4"/><circle r="7" fill="#d6a84e"/></g>
    <path d="M41 214c18-10 38-7 57-5 38 4 76-1 114 0 25 1 45 4 68 13-35 17-79 20-119 19-47-1-87-7-120-27z" fill="#a4b78e" opacity=".5"/>
  </svg>`;
}

function brand() { return `<div class="brand">${stoneSvg("brand-mark")}<div>Stone Memory<small>磐石记忆</small></div></div>`; }
function escapeHtml(value) { const el = document.createElement("div"); el.textContent = value ?? ""; return el.innerHTML; }
function showToast(message, type = "") { toast.textContent = message; toast.className = `toast show ${type}`; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.className = "toast", 3200); }
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function loadLibraries() {
  const data = await api("/api/libraries"); state.libraries = data.libraries;
}

function welcome() {
  app.innerHTML = `<section class="welcome"><div class="welcome-content">${stoneSvg()}<h1>Stone Memory</h1><p class="cn-title">磐石记忆</p><blockquote>“蒲苇韧如丝，磐石无转移”</blockquote><button class="primary" id="create">点击创建</button></div></section>`;
  document.querySelector("#create").onclick = () => { state.step = 1; wizard(); };
}

function topbar(extra = "") { return `<header class="topbar shell">${brand()}${extra}</header>`; }
function progress() { return `<div class="progress" aria-label="创建进度">${[1,2,3].map(n => `<span class="${n <= state.step ? "active" : ""}"></span>`).join("")}</div>`; }

function field(name, label, hint, attrs = "", full = false) {
  return `<div class="field ${full ? "full" : ""}"><label for="${name}">${label}</label><input id="${name}" name="${name}" value="${escapeHtml(state.form[name])}" ${attrs}><small>${hint}</small><small class="field-error" id="${name}-error"></small></div>`;
}

function syncForm() {
  document.querySelectorAll("[name]").forEach(input => {
    if (input.type === "checkbox") state.form[input.name] = input.checked;
    else state.form[input.name] = input.value;
  });
}

function wizard() {
  app.innerHTML = `<section class="wizard-page">${topbar(`<button class="ghost" id="exit-wizard">返回</button>`)}<div class="wizard-wrap">${progress()}<div class="panel" id="wizard-panel"></div></div></section>`;
  document.querySelector("#exit-wizard").onclick = () => state.libraries.length ? lobby() : welcome();
  if (state.step === 1) basicStep();
  if (state.step === 2) importStep();
  if (state.step === 3) finishStep();
}

function basicStep() {
  const panel = document.querySelector("#wizard-panel");
  panel.innerHTML = `<p class="eyebrow">第一步 · 建立记忆</p><h1>给这段记忆起一个名字</h1><p class="lead">记忆库名字属于你；对应线程名只负责连接真实对话。</p>
    <form id="basic-form"><div class="field-grid">
      ${field("libraryName", "记忆库名字", "以后在 Stone Memory 控制台中显示的名字。", "required autocomplete=off", true)}
      ${field("threadId", "对应线程名", "Claude 或 Codex 中真实线程的标识；创建后不建议修改。", "required autocomplete=off", true)}
      ${field("ai", "AI 名字", "这段记忆属于哪位 AI。", "required")}
      ${field("user", "用户名字", "AI 在记忆中如何称呼你。", "required")}
      <div class="field"><label for="runtime">对话来源</label><select id="runtime" name="runtime"><option value="codex" ${state.form.runtime === "codex" ? "selected" : ""}>Codex</option><option value="claude" ${state.form.runtime === "claude" ? "selected" : ""}>Claude</option></select><small>用于绑定正确的线程文件格式。</small></div>
      <div class="field"><label for="purpose">记忆用途</label><select id="purpose" name="purpose"><option value="accompany">陪伴</option><option value="coding">编程</option><option value="study">学习</option></select><small>只影响运行目录与默认提示。</small></div>
      <div class="field"><label for="minerMode">记忆挖掘方式</label><select id="minerMode" name="minerMode"><option value="subagent" ${state.form.minerMode === "subagent" ? "selected" : ""}>本地 Subagent</option><option value="api" ${state.form.minerMode === "api" ? "selected" : ""}>API</option></select><small>以后可以在设置中调整。</small></div>
      <div class="field"><label for="userGender">用户性别</label><select id="userGender" name="userGender"><option value="unspecified">不指定</option><option value="female">女性</option><option value="male">男性</option></select><small>帮助摘要保持正确的人称。</small></div>
      <div id="runtime-fields" class="field full"></div>
      <details class="field full"><summary class="clickable">高级重建设置</summary><div class="field-grid" style="margin-top:16px">${field("windowDays", "默认保留对话天数", "线程重建默认保留最近多少天的原始对话。", "type=number min=1 max=365")}${field("keepToolPairs", "默认保留工具链组数", "线程重建默认保留最近多少组完整工具调用。", "type=number min=0 max=500")}</div></details>
      <div id="api-fields" class="field full"></div>
    </div><div class="wizard-actions"><span></span><button class="primary" type="submit">继续导入对话</button></div></form>`;
  const renderConditional = () => {
    syncForm();
    const runtimeTarget = document.querySelector("#runtime-fields");
    runtimeTarget.innerHTML = state.form.runtime === "claude"
      ? field("sessionDir", "线程文件目录", "Claude 项目线程 JSONL 所在目录，必须填写绝对路径。", "required placeholder=/home/you/.claude/projects/...")
      : `<label>线程文件目录</label><input value="由系统自动使用 ~/.codex/sessions" disabled><small>Codex 的 session 路径固定，无需手动填写。</small>`;
    const target = document.querySelector("#api-fields");
    target.innerHTML = state.form.minerMode === "api" ? `<div class="field-grid">${field("apiProvider", "API 厂商", "例如 deepseek、openai 或 anthropic。", "required")}${field("apiKey", "API Key", "只保存在本机配置中，不返回给浏览器。", "required type=password")}${field("baseUrl", "Base URL（可选）", "留空时使用厂商默认地址。", "", true)}</div>` : "";
  };
  document.querySelector("#minerMode").onchange = renderConditional;
  document.querySelector("#runtime").onchange = renderConditional;
  renderConditional();
  document.querySelector("#basic-form").onsubmit = event => {
    event.preventDefault(); syncForm();
    let ok = true;
    for (const name of ["libraryName", "threadId", "ai", "user"]) if (!String(state.form[name] || "").trim()) { document.querySelector(`#${name}-error`).textContent = "请填写这一项"; ok = false; }
    if (state.form.runtime === "claude" && !String(state.form.sessionDir || "").trim()) { document.querySelector("#sessionDir-error").textContent = "Claude 必须填写线程文件目录"; ok = false; }
    if (ok) { state.step = 2; wizard(); }
  };
}

function importStep() {
  const panel = document.querySelector("#wizard-panel");
  panel.innerHTML = `<p class="eyebrow">第二步 · 导入对话</p><h1>把过去带进来</h1><p class="lead">支持 Claude、Codex 线程文件、JSON、JSONL 和 SQLite。上传后不会立即写入，你可以先检查识别结果。</p>
    <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="上传对话文件"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 002 2h10a2 2 0 002-2v-4"/></svg><strong>把文件拖到这里</strong><p>或者点击打开文件资源管理器</p><button class="secondary" type="button">选择文件</button><input id="file-input" type="file" accept=".json,.jsonl,.db,.sqlite,.sqlite3" multiple hidden></div>
    <div class="import-list" id="import-list"></div>
    <div class="wizard-actions"><button class="ghost" id="back">上一步</button><button class="primary" id="next">${state.imports.length ? "确认识别结果" : "暂不导入"}</button></div>`;
  const input = document.querySelector("#file-input"), zone = document.querySelector("#dropzone");
  zone.onclick = event => { if (event.target.tagName !== "INPUT") input.click(); };
  zone.onkeydown = event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); input.click(); } };
  zone.ondragover = event => { event.preventDefault(); zone.classList.add("dragging"); };
  zone.ondragleave = () => zone.classList.remove("dragging");
  zone.ondrop = event => { event.preventDefault(); zone.classList.remove("dragging"); uploadFiles(event.dataTransfer.files); };
  input.onchange = () => uploadFiles(input.files);
  document.querySelector("#back").onclick = () => { state.step = 1; wizard(); };
  document.querySelector("#next").onclick = () => { state.step = 3; wizard(); };
  renderImports();
}

async function uploadFiles(files) {
  for (const file of [...files]) {
    showToast(`正在识别 ${file.name}…`);
    try {
      const data = await api("/api/imports/preview", { method: "POST", headers: { "x-file-name": encodeURIComponent(file.name) }, body: file });
      state.imports.push(data); renderImports(); showToast(`${file.name} 识别完成`);
    } catch (error) { showToast(error.message, "error"); }
  }
}

function renderImports() {
  const list = document.querySelector("#import-list"); if (!list) return;
  list.innerHTML = state.imports.map((item, index) => `<article class="import-card" data-index="${index}"><div class="import-head"><div><strong>${escapeHtml(item.filename)}</strong><div class="import-meta">原始记录 ${item.totalRows} 条 · 将导入纯对话 ${item.valid} 条 · 自动过滤 ${item.invalid} 条 · ${item.firstDate || "-"} 至 ${item.lastDate || "-"}</div></div></div>${previewTable(item)}<div class="pager"><button class="ghost prev" ${item.page <= 1 ? "disabled" : ""}>上一页</button><span>${item.page} / ${item.totalPages}</span><button class="ghost next" ${item.page >= item.totalPages ? "disabled" : ""}>下一页</button></div></article>`).join("");
  list.querySelectorAll(".import-card").forEach(card => {
    const index = Number(card.dataset.index), item = state.imports[index];
    card.querySelector(".prev").onclick = () => loadImportPage(index, item.page - 1);
    card.querySelector(".next").onclick = () => loadImportPage(index, item.page + 1);
  });
  const next = document.querySelector("#next"); if (next) next.textContent = state.imports.length ? "确认识别结果" : "暂不导入";
}

function previewTable(item) {
  return `<div class="table-scroll"><table><thead><tr><th>时间戳</th><th>角色</th><th>Context</th></tr></thead><tbody>${item.rows.map(row => `<tr><td>${escapeHtml(row.timestamp)}</td><td>${escapeHtml(row.role)}</td><td class="context">${escapeHtml(row.context)}</td></tr>`).join("")}</tbody></table></div>`;
}

async function loadImportPage(index, page) {
  try { state.imports[index] = await api(`/api/imports/${state.imports[index].token}?page=${page}`); renderImports(); }
  catch (error) { showToast(error.message, "error"); }
}

function finishStep() {
  const panel = document.querySelector("#wizard-panel");
  panel.innerHTML = `<p class="eyebrow">第三步 · 开始生长</p><h1>一切准备好了</h1><p class="lead">确认自动化选项。以后都可以在记忆库设置中修改。</p>
    <div class="summary-box"><dl><dt>记忆库名字</dt><dd>${escapeHtml(state.form.libraryName)}</dd><dt>对应线程名</dt><dd>${escapeHtml(state.form.threadId)}</dd><dt>对话来源</dt><dd>${escapeHtml(state.form.runtime)}</dd><dt>待导入</dt><dd>${state.imports.reduce((sum, item) => sum + item.valid, 0)} 条对话</dd></dl></div>
    <label class="check-card"><input type="checkbox" name="automaticFullMining" ${state.form.automaticFullMining ? "checked" : ""}><span><strong>自动挖掘全量对话</strong>创建后对尚未处理的历史日期生成 feelings 和 features。</span></label>
    <label class="check-card"><input type="checkbox" name="automaticMemoryMaintenance" ${state.form.automaticMemoryMaintenance ? "checked" : ""}><span><strong>自动执行记忆挖掘 / 压缩</strong>持续监听新对话，并在记忆超过容量阈值后按规则压缩。</span></label>
    <div class="wizard-actions"><button class="ghost" id="back">上一步</button><button class="primary" id="finish">创建我的记忆</button></div>`;
  document.querySelector("#back").onclick = () => { syncForm(); state.step = 2; wizard(); };
  document.querySelector("#finish").onclick = createLibrary;
}

async function createLibrary() {
  syncForm(); const button = document.querySelector("#finish"); button.disabled = true; button.textContent = "正在安放记忆…";
  try {
    const result = await api("/api/libraries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...state.form, importTokens: state.imports.map(item => item.token) }) });
    await loadLibraries(); state.imports = []; showToast(`“${result.library.label}”已经开始生长`); openLibrary(result.library.threadId);
  } catch (error) { showToast(error.message, "error"); button.disabled = false; button.textContent = "创建我的记忆"; }
}

function lobby() {
  app.innerHTML = `<section class="lobby">${topbar()}<div class="shell"><div class="lobby-head"><h1>你的记忆库</h1><p>每一块石头，都守着一段不会轻易转移的记忆。</p></div><div class="library-grid">${state.libraries.map(library => `<button class="library-card" data-id="${escapeHtml(library.threadId)}">${stoneSvg("mini-stone")}<h2>${escapeHtml(library.libraryName)}</h2><p>${library.lastMinedAt ? "记忆正在生长" : "等待第一次记忆挖掘"}</p><div class="library-stats"><span>${library.counts.feelings} 条摘要</span><span>${library.counts.features} 条特征</span></div></button>`).join("")}<button class="new-card" id="new-library"><div><span>＋</span><strong>创建新的记忆库</strong></div></button></div></div></section>`;
  document.querySelectorAll(".library-card").forEach(card => card.onclick = () => openLibrary(card.dataset.id));
  document.querySelector("#new-library").onclick = () => { state.step = 1; state.imports = []; wizard(); };
}

async function openLibrary(threadId) {
  try { const data = await api(`/api/libraries/${encodeURIComponent(threadId)}/overview`); workspace(data); }
  catch (error) { showToast(error.message, "error"); }
}

function workspace(data) {
  const counts = data.counts;
  app.innerHTML = `<section class="workspace"><div class="shell workspace-grid"><aside class="sidebar"><a class="back-link" href="#">← 返回记忆库</a><h2 class="side-title">${escapeHtml(data.libraryName)}</h2><nav class="side-nav" aria-label="记忆库导航"><button class="active" data-view="overview">概览</button><button disabled title="即将接入">记忆</button><button disabled title="即将接入">时间轴</button><button data-view="rebuild">线程重建</button><button data-view="settings">设置</button></nav></aside><main id="workspace-main"><div class="dashboard-head"><div><p class="eyebrow">Stone Memory</p><h1>${escapeHtml(data.libraryName)}</h1><div class="status-line"><span class="status-dot"></span>${data.attention ? escapeHtml(data.attention) : "记忆运行正常"}</div></div>${stoneSvg("mini-stone")}</div>
    <div class="stats-grid"><div class="stat"><strong>${counts.daily}</strong><span>完整摘要</span></div><div class="stat"><strong>${counts.coarse}</strong><span>精简摘要</span></div><div class="stat"><strong>${counts.hidden}</strong><span>已隐藏</span></div><div class="stat"><strong>${counts.features}</strong><span>记忆特征</span></div></div>
    <section class="section-card"><h2>最近记住的事</h2>${data.recent.length ? data.recent.map(item => `<article class="memory-row"><div class="memory-time">${escapeHtml(item.sourceDate)} ${escapeHtml(item.eventTime || "")}</div><p>${escapeHtml(item.content)}</p><span class="badge">importance ${item.importance}</span><span class="badge">${escapeHtml(item.summaryMode)}</span></article>`).join("") : `<div class="empty">还没有摘要。导入对话后，第一次挖掘会让记忆在这里出现。</div>`}</section></main></div></section>`;
  document.querySelector(".back-link").onclick = event => { event.preventDefault(); lobby(); };
  document.querySelector('[data-view="rebuild"]').onclick = () => renderRebuild(data);
  document.querySelector('[data-view="settings"]').onclick = () => renderSettings(data);
  document.querySelector('[data-view="overview"]').onclick = () => workspace(data);
}

async function renderSettings(library) {
  document.querySelectorAll(".side-nav button").forEach(button => button.classList.toggle("active", button.dataset.view === "settings"));
  const main = document.querySelector("#workspace-main");
  main.innerHTML = `<div class="dashboard-head"><div><p class="eyebrow">记忆库配置</p><h1>设置</h1><p class="lead">这里展示并编辑创建记忆库时填写的 init 配置。</p></div></div><section class="section-card"><div class="empty">正在读取设置…</div></section>`;
  try {
    const config = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`);
    const card = main.querySelector(".section-card");
    card.innerHTML = `<form id="settings-form"><div class="field-grid">
      <div class="field full"><label for="setting-libraryName">记忆库名字</label><input id="setting-libraryName" name="libraryName" value="${escapeHtml(config.libraryName)}" required><small>控制台和记忆库大厅显示的名称；不能与其他记忆库重名。</small></div>
      <div class="field full"><label for="setting-threadId">对应线程名</label><input id="setting-threadId" value="${escapeHtml(config.threadId)}" disabled><small>底层绑定标识，创建后不可修改。</small></div>
      <div class="field"><label for="setting-ai">AI 名字</label><input id="setting-ai" name="ai" value="${escapeHtml(config.ai)}" required></div>
      <div class="field"><label for="setting-user">用户名字</label><input id="setting-user" name="user" value="${escapeHtml(config.user)}" required></div>
      <div class="field"><label for="setting-gender">用户性别</label><select id="setting-gender" name="userGender"><option value="unspecified" ${config.userGender === "unspecified" ? "selected" : ""}>不指定</option><option value="female" ${config.userGender === "female" ? "selected" : ""}>女性</option><option value="male" ${config.userGender === "male" ? "selected" : ""}>男性</option></select></div>
      <div class="field"><label for="setting-miner">挖掘方式</label><select id="setting-miner" name="minerMode"><option value="subagent" ${config.minerMode === "subagent" ? "selected" : ""}>本地 Subagent</option><option value="api" ${config.minerMode === "api" ? "selected" : ""}>API</option></select></div>
      <div class="field"><label>运行时</label><input value="${escapeHtml(config.runtime)}" disabled><small>涉及目录迁移，暂不在设置页修改。</small></div>
      <div class="field"><label>用途</label><input value="${escapeHtml(config.purpose)}" disabled><small>涉及目录迁移，暂不在设置页修改。</small></div>
      <div class="field full"><label for="setting-session">线程文件目录</label><input id="setting-session" name="sessionDir" value="${escapeHtml(config.sessionDir)}" ${config.runtime === "codex" ? "disabled" : "required"}><small>${config.runtime === "codex" ? "Codex 固定使用 ~/.codex/sessions。" : "Claude 活动线程 JSONL 所在目录，必须是绝对路径。"}</small></div>
      <div id="setting-api-fields" class="field full"></div>
      <div class="field"><label for="setting-window">默认保留对话天数</label><input id="setting-window" name="windowDays" type="number" min="1" max="365" value="${config.windowDays}"></div>
      <div class="field"><label for="setting-tools">默认保留工具链组数</label><input id="setting-tools" name="keepToolPairs" type="number" min="0" max="500" value="${config.keepToolPairs}"></div>
      <label class="check-card full"><input type="checkbox" name="automaticFullMining" ${config.automaticFullMining ? "checked" : ""}><span><strong>自动挖掘全量对话</strong>处理尚未挖掘的历史日期。</span></label>
      <label class="check-card full"><input type="checkbox" name="automaticMemoryMaintenance" ${config.automaticMemoryMaintenance ? "checked" : ""}><span><strong>自动执行记忆挖掘 / 压缩</strong>监听新对话并在超过水位后压缩。</span></label>
    </div><div class="wizard-actions"><span></span><button class="primary" type="submit">保存设置</button></div></form>`;
    const miner = card.querySelector("#setting-miner"), apiFields = card.querySelector("#setting-api-fields");
    const renderApiSettings = () => {
      apiFields.innerHTML = miner.value === "api" ? `<div class="field-grid"><div class="field"><label for="setting-provider">API 厂商</label><input id="setting-provider" name="apiProvider" value="${escapeHtml(config.apiProvider || "deepseek")}" required></div><div class="field"><label for="setting-key">API Key</label><div class="secret-input"><input id="setting-key" name="apiKey" type="password" value="${escapeHtml(config.apiKey || "")}" required><button type="button" id="toggle-key" aria-label="显示 API Key" title="显示 API Key"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.7"/></svg></button></div><small>Key 只在本机页面显示和保存。</small></div><div class="field full"><label for="setting-base">Base URL</label><input id="setting-base" name="baseUrl" value="${escapeHtml(config.baseUrl || "")}"></div></div>` : "";
      const toggle = apiFields.querySelector("#toggle-key"), keyInput = apiFields.querySelector("#setting-key");
      if (toggle) toggle.onclick = () => { const visible = keyInput.type === "text"; keyInput.type = visible ? "password" : "text"; toggle.setAttribute("aria-label", visible ? "显示 API Key" : "隐藏 API Key"); toggle.title = visible ? "显示 API Key" : "隐藏 API Key"; };
    };
    miner.onchange = renderApiSettings; renderApiSettings();
    card.querySelector("#settings-form").onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget, button = form.querySelector("button[type=submit]");
      const values = Object.fromEntries(new FormData(form).entries());
      values.windowDays = Number(values.windowDays); values.keepToolPairs = Number(values.keepToolPairs);
      values.automaticFullMining = form.elements.automaticFullMining.checked;
      values.automaticMemoryMaintenance = form.elements.automaticMemoryMaintenance.checked;
      button.disabled = true; button.textContent = "正在保存…";
      try {
        const result = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
        library.libraryName = result.config.libraryName;
        document.querySelector(".side-title").textContent = result.config.libraryName;
        await loadLibraries(); showToast("设置已保存");
      } catch (error) { showToast(error.message, "error"); }
      button.disabled = false; button.textContent = "保存设置";
    };
  } catch (error) { main.querySelector(".section-card").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

const rebuildState = { windowDays: 3, toolPairs: 30, page: 1, toolPage: 1, tab: "messages", excludedMessages: new Set(), excludedTools: new Set(), preview: null };

async function renderRebuild(library) {
  document.querySelectorAll(".side-nav button").forEach(button => button.classList.toggle("active", button.dataset.view === "rebuild"));
  const main = document.querySelector("#workspace-main");
  main.innerHTML = `<div class="dashboard-head"><div><p class="eyebrow">线程生命周期</p><h1>线程重建</h1><p class="lead">直接重建、检查线程，或者在需要时精确裁剪近期对话。</p></div></div><section class="section-card"><div class="action-grid"><button class="action-card" id="quick-rebuild"><strong>一键线程重建</strong><span>使用设置中的默认天数和工具链数量，直接执行 rebuild --apply。</span></button><button class="action-card" id="check-thread"><strong>检查 / 修复线程</strong><span>检查 Claude UUID 或 Codex session、工具调用配对；发现问题后自动修复并复查。</span></button><button class="action-card" id="open-trim"><strong>裁剪对话</strong><span>展开近期对话和工具链，取消勾选后永久裁剪并重建。</span></button></div><div id="integrity"></div></section>`;
  try { const config = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`); rebuildState.windowDays = config.windowDays; rebuildState.toolPairs = config.keepToolPairs; } catch {}
  document.querySelector("#quick-rebuild").onclick = event => quickRebuild(library, event.currentTarget);
  document.querySelector("#check-thread").onclick = () => checkAndRepair(library);
  document.querySelector("#open-trim").onclick = () => renderTrimWorkbench(library);
  await showIntegrity(library, false);
}

async function renderTrimWorkbench(library) {
  const main = document.querySelector("#workspace-main");
  main.innerHTML = `<div class="dashboard-head"><div><p class="eyebrow">永久裁剪</p><h1>选择保留的对话</h1><p class="lead">默认全部保留；取消勾选的内容会永久消失。</p></div><button class="ghost" id="back-rebuild">返回</button></div><section class="section-card"><div class="rebuild-controls"><div class="field"><label for="window-days">保留最近对话</label><input id="window-days" type="number" min="1" max="365" value="${rebuildState.windowDays}"><small>天</small></div><div class="field"><label for="tool-pairs">保留工具调用</label><input id="tool-pairs" type="number" min="0" max="500" value="${rebuildState.toolPairs}"><small>组</small></div><button class="secondary" id="refresh-plan">更新预览</button></div><div class="tab-row"><button data-tab="messages" class="active">近期对话</button><button data-tab="tools">工具链</button></div><div id="selection-list"><div class="empty">正在读取活动线程…</div></div><div class="integrity warning">取消勾选的内容会从活动线程、archive 和既有 full 重建源中永久删除，无法恢复。已有摘要不会自动修改；如需移除摘要，请在记忆页将其设为 hidden。</div><div class="rebuild-footer"><div id="selection-summary"></div><div class="actions"><button class="primary" id="apply-rebuild">永久裁剪并重建</button></div></div></section>`;
  document.querySelector("#back-rebuild").onclick = () => renderRebuild(library);
  document.querySelector("#refresh-plan").onclick = () => { rebuildState.windowDays = Number(document.querySelector("#window-days").value) || 3; rebuildState.toolPairs = Math.max(0, Number(document.querySelector("#tool-pairs").value) || 0); rebuildState.page = 1; rebuildState.toolPage = 1; loadRebuildPreview(library); };
  document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => { rebuildState.tab = button.dataset.tab; document.querySelectorAll("[data-tab]").forEach(item => item.classList.toggle("active", item === button)); renderRebuildRows(library); });
  document.querySelector("#apply-rebuild").onclick = () => applyRebuild(library);
  await loadRebuildPreview(library);
}

async function quickRebuild(library, button) {
  button.disabled = true; const original = button.innerHTML; button.innerHTML = `<strong>正在重建线程…</strong><span>请保持本地服务运行。</span>`;
  try {
    await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rebuild/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ windowDays: rebuildState.windowDays, toolPairs: rebuildState.toolPairs, excludedMessages: [], excludedTools: [] }) });
    showToast("线程重建完成"); await showIntegrity(library, false);
  } catch (error) { showToast(error.message, "error"); }
  button.disabled = false; button.innerHTML = original;
}

async function loadRebuildPreview(library) {
  const target = document.querySelector("#selection-list"); if (!target) return;
  target.innerHTML = `<div class="empty">正在生成预览…</div>`;
  try {
    rebuildState.preview = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rebuild/preview?windowDays=${rebuildState.windowDays}&toolPairs=${rebuildState.toolPairs}&page=${rebuildState.page}&toolPage=${rebuildState.toolPage}`);
    renderRebuildRows(library);
  } catch (error) { target.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

function renderRebuildRows(library) {
  const target = document.querySelector("#selection-list"), data = rebuildState.preview; if (!target || !data) return;
  const collection = rebuildState.tab === "messages" ? data.items : data.tools;
  target.innerHTML = collection.rows.length ? collection.rows.map(row => rebuildState.tab === "messages"
    ? `<label class="select-row"><input type="checkbox" data-kind="message" data-id="${row.id}" ${rebuildState.excludedMessages.has(row.id) ? "" : "checked"}><time>${escapeHtml(row.timestamp.replace("T", " ").slice(0,16))}</time><span class="role">${escapeHtml(row.role)}</span><span class="context">${escapeHtml(row.context)}</span></label>`
    : `<label class="select-row tool-row"><input type="checkbox" data-kind="tool" data-id="${row.id}" ${rebuildState.excludedTools.has(row.id) ? "" : "checked"}><time>${escapeHtml(row.timestamp.replace("T", " ").slice(0,16))}</time><span class="role">${escapeHtml(row.name)}</span><span class="context">${escapeHtml(row.context)}${row.output ? `\n→ ${escapeHtml(row.output)}` : ""}</span></label>`).join("") : `<div class="empty">这个范围内没有${rebuildState.tab === "messages" ? "对话" : "完整工具链"}。</div>`;
  target.querySelectorAll("input[type=checkbox]").forEach(input => input.onchange = () => {
    const set = input.dataset.kind === "message" ? rebuildState.excludedMessages : rebuildState.excludedTools;
    input.checked ? set.delete(input.dataset.id) : set.add(input.dataset.id); updateSelectionSummary();
  });
  target.insertAdjacentHTML("beforeend", `<div class="pager"><button class="ghost" id="rebuild-prev" ${collection.page <= 1 ? "disabled" : ""}>上一页</button><span>${collection.page} / ${collection.totalPages}</span><button class="ghost" id="rebuild-next" ${collection.page >= collection.totalPages ? "disabled" : ""}>下一页</button></div>`);
  document.querySelector("#rebuild-prev").onclick = () => changeRebuildPage(library, -1);
  document.querySelector("#rebuild-next").onclick = () => changeRebuildPage(library, 1);
  updateSelectionSummary();
}

function changeRebuildPage(library, delta) { if (rebuildState.tab === "messages") rebuildState.page += delta; else rebuildState.toolPage += delta; loadRebuildPreview(library); }
function updateSelectionSummary() { const el = document.querySelector("#selection-summary"); if (el) el.textContent = `已排除 ${rebuildState.excludedMessages.size} 条对话、${rebuildState.excludedTools.size} 组工具链`; }

async function showIntegrity(library, repair) {
  const target = document.querySelector("#integrity"); if (!target) return;
  try {
    const result = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rebuild/${repair ? "repair" : "check"}`, { method: repair ? "POST" : "GET" });
    const report = repair ? result.after : result;
    target.className = `integrity ${report.healthy ? "" : "warning"}`;
    target.textContent = repair ? result.message : (report.healthy ? "活动线程结构完整。" : `发现 ${report.issues} 项结构问题，可以尝试自动修复。`);
    return result;
  } catch (error) { target.className = "integrity warning"; target.textContent = error.message; }
}

async function checkAndRepair(library) {
  const check = await showIntegrity(library, false); if (!check || check.healthy) { showToast("线程结构完整"); return; }
  const button = document.querySelector("#check-thread"), original = button.innerHTML; button.disabled = true; button.innerHTML = `<strong>正在备份并修复…</strong><span>修复后会自动重新检查。</span>`;
  await showIntegrity(library, true); button.disabled = false; button.innerHTML = original;
}

async function applyRebuild(library) {
  const button = document.querySelector("#apply-rebuild"); button.disabled = true; button.textContent = "正在重建线程…";
  try {
    const result = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rebuild/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ windowDays: rebuildState.windowDays, toolPairs: rebuildState.toolPairs, excludedMessages: [...rebuildState.excludedMessages], excludedTools: [...rebuildState.excludedTools] }) });
    showToast(rebuildState.excludedMessages.size || rebuildState.excludedTools.size ? "已永久裁剪所选内容并完成重建" : "线程重建完成，并已通过结构复查"); await showIntegrity(library, false);
  } catch (error) { showToast(error.message, "error"); }
  button.disabled = false; button.textContent = "永久裁剪并重建";
}

loadLibraries().then(() => state.libraries.length ? lobby() : welcome()).catch(error => { app.innerHTML = `<section class="welcome"><div class="welcome-content"><h1>Stone Memory</h1><p class="lead">本地服务暂时无法读取记忆库。</p><button class="primary" onclick="location.reload()">重新加载</button></div></section>`; showToast(error.message, "error"); });
