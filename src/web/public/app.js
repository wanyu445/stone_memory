const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

const state = {
  libraries: [], step: 1, imports: [],
  form: { libraryName: "", threadId: "", ai: "", user: "", userGender: "unspecified", runtime: "codex", purpose: "accompany", sessionDir: "", minerMode: "subagent", apiProvider: "deepseek", apiKey: "", baseUrl: "", windowDays: 3, keepToolPairs: 30, automaticFullMining: true, automaticMemoryMaintenance: true },
};

function resetCreateForm() {
  state.step = 1; state.imports = [];
  state.form = { libraryName: "", threadId: "", ai: "", user: "", userGender: "unspecified", runtime: "codex", purpose: "accompany", sessionDir: "", minerMode: "subagent", apiProvider: "deepseek", apiKey: "", baseUrl: "", windowDays: 3, keepToolPairs: 30, automaticFullMining: true, automaticMemoryMaintenance: true };
}

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
function formatTokens(value) { const n=Number(value); if(!Number.isFinite(n))return "—"; if(n>=1e6)return `${(n/1e6).toFixed(n%1e6?1:0)}m`; if(n>=1e3)return `${(n/1e3).toFixed(n%1e3?1:0)}k`; return String(n); }
function formatBytes(value) { const n=Number(value); if(!Number.isFinite(n))return "—"; if(n>=1024*1024)return `${(n/1024/1024).toFixed(2)} MB`; if(n>=1024)return `${(n/1024).toFixed(1)} KB`; return `${n} B`; }
function formatBeijingTime(value) {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return String(value || "—");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
function formatChineseDate(value) { const parts=String(value||"").split("-").map(Number);return parts.length===3&&parts.every(Number.isFinite)?`${parts[1]}月${parts[2]}日`:String(value||""); }
function formatContextUsage(usage) { if(!usage)return "暂无数据"; return usage.maxTokens?`${formatTokens(usage.usedTokens)} / ${formatTokens(usage.maxTokens)} tokens`:`${formatTokens(usage.usedTokens)} tokens`; }
function contextUsageHint(data) { const usage=data.contextUsage;if(!usage)return data.automaticFullMining?"等待线程产生下一条模型 usage":"开启自动挖掘全量对话后实时统计";const percent=usage.percent==null?"":`${usage.percent.toFixed(1)}% · `;return `${percent}最近一次模型调用${usage.maxTokens?"":" · 可在设置中填写窗口上限"}`; }
function calendarPageForDate(calendar, date) {
  if (!calendar?.month || !date) return calendar?.page || 1;
  const [currentYear,currentMonth]=calendar.month.split("-").map(Number),[targetYear,targetMonth]=date.slice(0,7).split("-").map(Number);
  return calendar.page+(currentYear-targetYear)*12+(currentMonth-targetMonth);
}
function miningCalendarData(rows,page=1) {
  if(!rows.length)return {page:1,totalPages:1,month:null,leadingBlanks:0,days:[]};
  const byDate=new Map(rows.map(row=>[row.date,row])),dates=[...byDate.keys()].sort(),first=dates[0].slice(0,7),last=dates.at(-1).slice(0,7);
  const [fy,fm]=first.split("-").map(Number),[ly,lm]=last.split("-").map(Number),totalPages=(ly-fy)*12+lm-fm+1,current=Math.min(Math.max(1,Number(page)||1),totalPages);
  const value=new Date(Date.UTC(ly,lm-current,1)),year=value.getUTCFullYear(),monthIndex=value.getUTCMonth(),month=`${year}-${String(monthIndex+1).padStart(2,"0")}`,count=new Date(Date.UTC(year,monthIndex+1,0)).getUTCDate();
  return {page:current,totalPages,month,leadingBlanks:new Date(Date.UTC(year,monthIndex,1)).getUTCDay(),days:Array.from({length:count},(_,index)=>{const date=`${month}-${String(index+1).padStart(2,"0")}`;return {date,row:byDate.get(date)||null};})};
}
function conversationRole(role, library) { return role==="user"?(library.user||"用户"):role==="assistant"?(library.ai||"AI"):role; }
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
  document.querySelector("#create").onclick = () => { resetCreateForm(); wizard(); };
}

function topbar(extra = "") { return `<header class="topbar shell">${brand()}${extra}</header>`; }
function progress() { return `<div class="progress" aria-label="创建进度">${[1,2,3].map(n => `<span class="${n <= state.step ? "active" : ""}"></span>`).join("")}</div>`; }

function field(name, label, hint, attrs = "", full = false) {
  return `<div class="field ${full ? "full" : ""}"><label for="${name}">${label}</label><input id="${name}" name="${name}" value="${escapeHtml(state.form[name])}" ${attrs}><small>${hint}</small><small class="field-error" id="${name}-error"></small></div>`;
}

function pagination({ page = 1, totalPages = 1 } = {}) {
  const current = Math.min(Math.max(1, Number(page) || 1), Math.max(1, Number(totalPages) || 1));
  const total = Math.max(1, Number(totalPages) || 1);
  return `<div class="pager" data-pagination><button class="ghost" data-page-action="prev" ${current <= 1 ? "disabled" : ""}>上一页</button><label>第 <input data-page-input type="number" min="1" max="${total}" value="${current}" aria-label="页码"> / ${total} 页</label><button class="ghost" data-page-action="go">跳转</button><button class="ghost" data-page-action="next" ${current >= total ? "disabled" : ""}>下一页</button></div>`;
}

function bindPagination(container, page, totalPages, onPage) {
  const pager = container?.querySelector("[data-pagination]"); if (!pager) return;
  const input = pager.querySelector("[data-page-input]");
  const go = requested => onPage(Math.min(Math.max(1, Number(requested) || 1), Math.max(1, totalPages)));
  pager.querySelector('[data-page-action="prev"]').onclick = () => go(page - 1);
  pager.querySelector('[data-page-action="next"]').onclick = () => go(page + 1);
  pager.querySelector('[data-page-action="go"]').onclick = () => go(input.value);
  input.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); go(input.value); } };
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
  panel.innerHTML = `<p class="eyebrow">第一步 · 建立记忆</p><h1>给这段记忆起一个名字</h1><p class="lead">记忆体名字属于你；绑定线程负责连接真实对话。</p>
    <form id="basic-form"><div class="field-grid">
      ${field("libraryName", "记忆体名字", "以后在 Stone Memory 控制台中显示的名字。", "required autocomplete=off", true)}
      ${field("threadId", "绑定线程", "Claude 或 Codex 中真实线程的标识；创建后不可修改。", "required autocomplete=off", true)}
      ${field("ai", "AI 名字", "这段记忆属于哪位 AI。", "required")}
      ${field("user", "用户名字", "AI 在记忆中如何称呼你。", "required")}
      <div class="field"><label for="runtime">对话来源</label><select id="runtime" name="runtime"><option value="codex" ${state.form.runtime === "codex" ? "selected" : ""}>Codex</option><option value="claude" ${state.form.runtime === "claude" ? "selected" : ""}>Claude</option></select><small>用于绑定正确的线程文件格式。</small></div>
      <div class="field"><label for="purpose">记忆用途</label><select id="purpose" name="purpose"><option value="accompany" ${state.form.purpose === "accompany" ? "selected" : ""}>陪伴</option><option value="coding" ${state.form.purpose === "coding" ? "selected" : ""}>编程</option><option value="study" ${state.form.purpose === "study" ? "selected" : ""}>学习</option></select><small>只影响运行目录与默认提示。</small></div>
      <div class="field"><label for="minerMode">记忆挖掘方式</label><select id="minerMode" name="minerMode"><option value="subagent" ${state.form.minerMode === "subagent" ? "selected" : ""}>本地 Subagent</option><option value="api" ${state.form.minerMode === "api" ? "selected" : ""}>API</option></select><small>以后可以在设置中调整。</small></div>
      <div class="field"><label for="userGender">用户性别</label><select id="userGender" name="userGender"><option value="unspecified" ${state.form.userGender === "unspecified" ? "selected" : ""}>不指定</option><option value="female" ${state.form.userGender === "female" ? "selected" : ""}>女性</option><option value="male" ${state.form.userGender === "male" ? "selected" : ""}>男性</option></select><small>帮助摘要保持正确的人称。</small></div>
      <div id="runtime-fields" class="field full"></div>
      <details class="field full"><summary class="clickable">高级重建设置</summary><div class="field-grid" style="margin-top:16px">${field("windowDays", "默认保留对话天数", "线程重建默认保留最近多少天的原始对话。", "type=number min=1 max=365")}${field("keepToolPairs", "默认保留工具链组数", "线程重建默认保留最近多少组完整工具调用。", "type=number min=0 max=500")}</div></details>
      <div id="api-fields" class="field full"></div>
    </div><div class="wizard-actions"><span></span><button class="primary" type="submit">继续导入对话</button></div></form>`;
  const renderConditional = () => {
    syncForm();
    const runtimeTarget = document.querySelector("#runtime-fields");
    runtimeTarget.innerHTML = field("sessionDir", "线程文件搜索目录", `${state.form.runtime === "codex" ? "Codex sessions" : "Claude 项目线程"}所在的目录；Stone Memory 会递归查找日期子目录中的对应 JSONL。`, `required placeholder=${state.form.runtime === "codex" ? "C:\\Users\\you\\.codex\\sessions" : "/home/you/.claude/projects/..."}`);
    const target = document.querySelector("#api-fields");
    target.innerHTML = state.form.minerMode === "api" ? `<div class="field-grid">${field("apiProvider", "API 厂商", "例如 deepseek、openai 或 anthropic。", "required")}${field("apiKey", "API Key", "只保存在本机配置中，不返回给浏览器。", "required type=password")}${field("baseUrl", "Base URL（可选）", "留空时使用厂商默认地址。", "", true)}</div>` : "";
  };
  document.querySelector("#minerMode").onchange = renderConditional;
  document.querySelector("#runtime").onchange = renderConditional;
  renderConditional();
  document.querySelector("#basic-form").onsubmit = async event => {
    event.preventDefault(); syncForm();
    let ok = true;
    for (const name of ["libraryName", "threadId", "ai", "user"]) if (!String(state.form[name] || "").trim()) { document.querySelector(`#${name}-error`).textContent = "请填写这一项"; ok = false; }
    if (!String(state.form.sessionDir || "").trim()) { document.querySelector("#sessionDir-error").textContent = "请填写线程文件搜索目录"; ok = false; }
    if (!ok) return;
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true; button.textContent = "正在查找线程文件…";
    try {
      await api("/api/session-file/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: state.form.threadId, sessionDir: state.form.sessionDir }) });
      state.step = 2; wizard();
    } catch (error) {
      document.querySelector("#sessionDir-error").textContent = error.message;
      showToast(error.message, "error");
      button.disabled = false; button.textContent = "继续导入对话";
    }
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
  list.innerHTML = state.imports.map((item, index) => `<article class="import-card" data-index="${index}"><div class="import-head"><div><strong>${escapeHtml(item.filename)}</strong><div class="import-meta">原始记录 ${item.totalRows} 条 · 将导入纯对话 ${item.valid} 条 · 自动过滤 ${item.invalid} 条 · ${item.firstDate || "-"} 至 ${item.lastDate || "-"}</div></div></div>${previewTable(item)}${pagination(item)}</article>`).join("");
  list.querySelectorAll(".import-card").forEach(card => {
    const index = Number(card.dataset.index), item = state.imports[index];
    bindPagination(card, item.page, item.totalPages, page => loadImportPage(index, page));
  });
  const next = document.querySelector("#next"); if (next) next.textContent = state.imports.length ? "确认识别结果" : "暂不导入";
}

function previewTable(item) {
  return `<div class="table-scroll"><table><thead><tr><th>时间戳</th><th>角色</th><th>Context</th></tr></thead><tbody>${item.rows.map(row => `<tr><td>${escapeHtml(formatBeijingTime(row.timestamp))}</td><td>${escapeHtml(row.role)}</td><td class="context">${escapeHtml(row.context)}</td></tr>`).join("")}</tbody></table></div>`;
}

async function loadImportPage(index, page) {
  try { state.imports[index] = await api(`/api/imports/${state.imports[index].token}?page=${page}`); renderImports(); }
  catch (error) { showToast(error.message, "error"); }
}

function finishStep() {
  const panel = document.querySelector("#wizard-panel");
  panel.innerHTML = `<p class="eyebrow">第三步 · 开始生长</p><h1>一切准备好了</h1><p class="lead">确认自动化选项。以后都可以在记忆体设置中修改。</p>
    <div class="summary-box"><dl><dt>记忆体名字</dt><dd>${escapeHtml(state.form.libraryName)}</dd><dt>绑定线程</dt><dd>${escapeHtml(state.form.threadId)}</dd><dt>对话来源</dt><dd>${escapeHtml(state.form.runtime)}</dd><dt>待导入</dt><dd>${state.imports.reduce((sum, item) => sum + item.valid, 0)} 条对话</dd></dl></div>
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
  app.innerHTML = `<section class="lobby">${topbar()}<div class="shell"><div class="lobby-head"><h1>你的记忆体</h1><p>每一块石头，都守着一段不会轻易转移的记忆。</p></div><div class="library-grid">${state.libraries.map(library => `<button class="library-card" data-id="${escapeHtml(library.threadId)}">${stoneSvg("mini-stone")}<h2>${escapeHtml(library.libraryName)}</h2><p>${library.lastMinedAt ? "记忆正在生长" : "等待第一次记忆挖掘"}</p><div class="library-stats"><span>${library.counts.feelings} 条摘要</span><span>${library.counts.features} 条特征</span></div></button>`).join("")}<button class="new-card" id="new-library"><div><span>＋</span><strong>创建新的记忆体</strong></div></button></div></div></section>`;
  document.querySelectorAll(".library-card").forEach(card => card.onclick = () => openLibrary(card.dataset.id));
  document.querySelector("#new-library").onclick = () => { resetCreateForm(); wizard(); };
}

async function openLibrary(threadId) {
  try { const data = await api(`/api/libraries/${encodeURIComponent(threadId)}/overview`); workspace(data); }
  catch (error) { showToast(error.message, "error"); }
}

function workspace(data) {
  const counts = data.counts, rebuild=data.rebuild;
  app.innerHTML = `<section class="workspace"><div class="shell workspace-grid"><aside class="sidebar"><a class="back-link" href="#">← 返回记忆体</a><h2 class="side-title">${escapeHtml(data.libraryName)}</h2><nav class="side-nav" aria-label="记忆体导航"><button class="active" data-view="overview">概览</button><button data-view="maintenance">维护</button><button data-view="archive">记忆档案</button><button data-view="settings">设置</button></nav></aside><main id="workspace-main"><div class="dashboard-head"><div><p class="eyebrow">Stone Memory</p><h1>${escapeHtml(data.libraryName)}</h1><div class="status-line"><span class="status-dot"></span>${data.attention ? escapeHtml(data.attention) : "记忆运行正常"}</div></div>${stoneSvg("mini-stone")}</div>
    ${rebuild?`<section class="section-card"><h2>当前线程已插入内容</h2><div class="overview-grid"><div><span>人设 / 规则</span><strong>${rebuild.injectedRules||0} 份</strong><small>${(rebuild.injectedRuleNames||[]).map(escapeHtml).join("、")||"无"}</small></div><div><span>原文对话</span><strong>${(rebuild.recentMessages||0)+(rebuild.retainedMessages||0)} 条</strong><small>近期 ${rebuild.recentMessages||0} 条（${rebuild.windowDays} 个活跃日） · 锚点实际注入 ${rebuild.retainedMessages||0} 条（${rebuild.retainAnchors||0} 个锚点）</small></div><div><span>摘要</span><strong>${rebuild.injectedFeelings||0} 条</strong><small>仅统计本次实际写入线程的摘要</small></div><div><span>工具链</span><strong>${rebuild.preservedToolPairs||0} 组</strong><small>上次 rebuild 的保留结果</small></div></div></section>`:`<section class="section-card"><h2>当前线程已插入内容</h2><div class="overview-empty-guide"><p>当前还没有线程注入报告。请前往【维护】，先通过【对话导入】补充记录、在【记忆挖掘】中生成摘要，再通过【线程重建】将人设、摘要与近期对话写入当前线程，完成记忆体构建。</p><button class="secondary" id="overview-maintenance">前往维护 →</button></div></section>`}
    <section class="section-card"><h2>线程与记忆状态</h2><div class="overview-grid"><div><span>当前上下文窗口</span><strong>${formatContextUsage(data.contextUsage)}</strong><small>${contextUsageHint(data)}</small></div><div><span>最近重建</span><strong>${rebuild?escapeHtml(formatBeijingTime(rebuild.completedAt)):"暂无记录"}</strong><small>${rebuild?`${escapeHtml(rebuild.runtime)} · ${escapeHtml(rebuild.trigger||"cli")} · 北京时间`:"等待第一次正式 rebuild"}</small></div><div><span>上次挖掘</span><strong>${data.lastMinedAt?escapeHtml(formatBeijingTime(data.lastMinedAt)):"尚未挖掘"}</strong><small>待挖掘 ${data.pendingMiningDays||0} 天</small></div><div><span>自动化</span><strong>${data.automaticFullMining||data.automaticMemoryMaintenance?"已配置":"已关闭"}</strong><small>全量挖掘 ${data.automaticFullMining?"开":"关"} · 日常维护 ${data.automaticMemoryMaintenance?"开":"关"}</small></div></div></section>
    <section class="section-card"><h2>最近生成摘要</h2>${data.recent.length ? data.recent.map(item => `<article class="memory-row"><div class="memory-time">${escapeHtml(item.sourceDate)} ${escapeHtml(item.eventTime || "")}</div><p>${escapeHtml(item.content)}</p><span class="badge">importance ${item.importance}</span><span class="badge">${escapeHtml(item.summaryMode)}</span></article>`).join("") : `<div class="empty">还没有摘要。导入对话后，第一次挖掘会让记忆在这里出现。</div>`}</section></main></div></section>`;
  document.querySelector(".back-link").onclick = event => { event.preventDefault(); lobby(); };
  document.querySelector('[data-view="maintenance"]').onclick = () => renderMaintenance(data);
  document.querySelector('[data-view="archive"]').onclick = () => renderMemoryHub(data);
  document.querySelector('[data-view="settings"]').onclick = () => renderSettings(data);
  document.querySelector('[data-view="overview"]').onclick = () => workspace(data);
  document.querySelector("#overview-maintenance")?.addEventListener("click",()=>renderMaintenance(data));
}

function renderMemoryHub(library) {
  document.querySelectorAll(".side-nav button").forEach(button => button.classList.toggle("active", button.dataset.view === "archive"));
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`<div class="dashboard-head"><div><p class="eyebrow">可解释记忆</p><h1>记忆档案</h1><p class="lead">查看 AI 会读到的规则、摘要、特征和时间脉络。</p></div></div><section class="memory-entry-grid"><button data-section="rules"><strong>人设 / 规则</strong><span>导入、编辑并控制 rebuild 是否注入</span></button><button data-section="feelings"><strong>摘要</strong><span>查看完整、精简和隐藏记忆</span></button><button data-section="features"><strong>特征库</strong><span>按类别查看长期记忆特征</span></button><button data-section="conversations"><strong>全量对话</strong><span>搜索关键词，或按日期回看纯对话 archive</span></button><button data-section="timeline"><strong>时间轴</strong><span>查看词频、重要摘要与记忆生命周期</span></button></section>`;
  main.querySelectorAll("[data-section]").forEach(button=>button.onclick=()=>button.dataset.section==="conversations"?renderConversations(library):button.dataset.section==="timeline"?renderTimeline(library):renderMemorySection(library,button.dataset.section));
}

const timelineColors=["#397052","#c47686","#6d76a8"];
const relationLabels={forming:"正在形成",experimental:"短期试验",established:"稳定存在",post_plateau:"平台后回调",retired:"已退出",revived:"重新活跃"};
const shapeLabels={continuous:"连续型",episodic:"阶段型",episodic_pair:"阶段复现配对",paired_experiment:"试验性配对",retired_pair:"已退出配对"};

function timelineSvg(report) {
  const rows=report||[],dates=rows[0]?.timeline?.map(point=>point.date)||[];
  if(!dates.length)return '<div class="empty">这个范围内还没有可绘制的数据。</div>';
  const width=960,height=330,left=48,right=22,top=26,bottom=48,plotWidth=width-left-right,plotHeight=height-top-bottom;
  const max=Math.max(1,...rows.flatMap(row=>row.timeline.map(point=>Number(point.occurrenceCount)||0)));
  const x=index=>left+(dates.length===1?plotWidth/2:index*plotWidth/(dates.length-1));
  const y=value=>top+plotHeight-(Number(value)||0)*plotHeight/max;
  const dateIndex=new Map(dates.map((date,index)=>[date,index]));
  const grid=[0,.25,.5,.75,1].map(rate=>`<g><line x1="${left}" y1="${top+plotHeight*(1-rate)}" x2="${width-right}" y2="${top+plotHeight*(1-rate)}"/><text x="${left-9}" y="${top+plotHeight*(1-rate)+4}">${Math.round(max*rate)}</text></g>`).join("");
  const curves=rows.map((row,index)=>{
    const points=row.timeline.map((point,pointIndex)=>`${x(pointIndex)},${y(point.occurrenceCount)}`).join(" ");
    const color=timelineColors[index%timelineColors.length];
    return `<polyline class="timeline-line" points="${points}" style="--series:${color}"></polyline>`;
  }).join("");
  const feelingPoints=rows.flatMap((row,index)=>row.feelings.map(feeling=>{
    const pointIndex=dateIndex.get(feeling.sourceDate);if(pointIndex===undefined)return "";
    const daily=row.timeline[pointIndex],color=timelineColors[index%timelineColors.length],radius=4+Math.max(0,Number(feeling.importance)||0)*.8;
    const classes=["timeline-feeling-dot",feeling.retainAnchor&&"retain",feeling.eventAnchor&&"event",`mode-${feeling.summaryMode}`].filter(Boolean).join(" ");
    return `<circle class="${classes}" data-feeling-id="${escapeHtml(feeling.id)}" cx="${x(pointIndex)}" cy="${y(daily?.occurrenceCount)+index*5}" r="${radius}" style="--series:${color}"><title>${escapeHtml(`${feeling.sourceDate} · importance ${feeling.importance} · ${feeling.content}`)}</title></circle>`;
  })).join("");
  const labelIndexes=[0,Math.floor((dates.length-1)/2),dates.length-1].filter((value,index,array)=>array.indexOf(value)===index);
  const labels=labelIndexes.map(index=>`<text class="timeline-date-label" x="${x(index)}" y="${height-16}" text-anchor="${index===0?"start":index===dates.length-1?"end":"middle"}">${dates[index]}</text>`).join("");
  return `<div class="timeline-chart-scroll"><svg class="timeline-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="关键词时间曲线"><g class="timeline-grid">${grid}</g>${curves}${feelingPoints}${labels}</svg></div>`;
}

function timelineInterpretation(data,row) {
  const lifecycle=data.relation?.terms?.find(item=>item.normalizedTerm===row.normalizedTerm);
  if(lifecycle){const confidence={high:"高",medium:"中",low:"低"}[lifecycle.confidence]||lifecycle.confidence||"—",signature=lifecycle.signature?.term?` · 主要共同签名：${lifecycle.signature.term}`:"";return `${relationLabels[lifecycle.state]||lifecycle.state} · ${shapeLabels[lifecycle.shape]||lifecycle.shape} · 置信度 ${confidence}${signature}`;}
  const workGroups=(data.work?.groups||[]).filter(group=>group.members?.some(member=>member.normalizedTerm===row.normalizedTerm||member.term===row.term));
  if(workGroups.length)return `进入 ${workGroups.length} 个项目证据节点 · ${workGroups.map(group=>group.state).filter(Boolean).join("、")||"局部项目证据"}`;
  return row.categories.length?`当前按 ${row.categories.join(" / ")} 特征解释`:"尚未进入特征库，暂只展示真实命中";
}

async function renderTimeline(library,{terms="",from="",to=""}={}) {
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`<div class="dashboard-head"><div><p class="eyebrow">Temporal evidence</p><h1>时间轴</h1><p class="lead">把关键词曲线、对应摘要与生命周期证据放在同一条时间线上查看。</p></div><button class="ghost" id="back-memory">返回</button></div><section class="section-card timeline-query-card"><form id="timeline-query"><div class="timeline-term-field"><label for="timeline-terms">关键词</label><input id="timeline-terms" value="${escapeHtml(terms)}" placeholder="输入 1～3 个词，用逗号分隔"></div><div><label for="timeline-from">开始日期</label><input id="timeline-from" type="date" value="${escapeHtml(from)}"></div><div><label for="timeline-to">结束日期</label><input id="timeline-to" type="date" value="${escapeHtml(to)}"></div><button class="primary">生成时间轴</button></form><p class="timeline-query-note">曲线展示真实对话词频；摘要点负责说明这些词在记忆中留下了什么。时间轴仅解释，不会自动修改摘要。</p></section><div id="timeline-results"></div>`;
  main.querySelector("#back-memory").onclick=()=>renderMemoryHub(library);
  main.querySelector("#timeline-query").onsubmit=event=>{event.preventDefault();const nextTerms=main.querySelector("#timeline-terms").value.trim(),nextFrom=main.querySelector("#timeline-from").value,nextTo=main.querySelector("#timeline-to").value;if(!nextTerms)return showToast("请输入至少一个关键词","error");renderTimeline(library,{terms:nextTerms,from:nextFrom,to:nextTo});};
  if(!terms)return;
  const target=main.querySelector("#timeline-results");target.innerHTML='<section class="section-card"><div class="empty">正在构建时间轴…</div></section>';
  try{
    const params=new URLSearchParams({terms});if(from)params.set("from",from);if(to)params.set("to",to);
    const data=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/timeline?${params}`),rows=data.report||[];
    const legends=rows.map((row,index)=>`<span><i style="--series:${timelineColors[index%timelineColors.length]}"></i>${escapeHtml(row.term)}</span>`).join("");
    const stats=rows.map(row=>`<article class="timeline-stat"><div><strong>${escapeHtml(row.term)}</strong><span>${row.categories.map(category=>`<b>${escapeHtml(category)}</b>`).join("")||"<b>未分类</b>"}</span></div><dl><div><dt>首次出现</dt><dd>${escapeHtml(row.firstSeen||"—")}</dd></div><div><dt>最近出现</dt><dd>${escapeHtml(row.lastSeen||"—")}</dd></div><div><dt>活跃天数</dt><dd>${row.activeDays}</dd></div><div><dt>真实出现</dt><dd>${row.occurrenceCount} 次</dd></div></dl><p>${escapeHtml(timelineInterpretation(data,row))}</p></article>`).join("");
    const intersections=(data.intersections||[]).map(item=>{
      const key=[...item.terms].sort().join("\u0000"),pair=(data.relation?.pairs||[]).find(candidate=>[...candidate.terms].sort().join("\u0000")===key);
      const pairText=pair?`<em>${relationLabels[pair.state]||pair.state} · ${shapeLabels[pair.shape]||pair.shape} · 跨 ${pair.evidence.spanDays||0} 天</em>`:"";
      return `<article><div><strong>${item.terms.map(escapeHtml).join(" × ")}</strong>${pairText}</div><span>同日 ${item.sameDayCount} · 同消息 ${item.sameMessageCount} · 同摘要 ${item.sameFeelingCount}</span></article>`;
    }).join("");
    const feelings=[...new Map(rows.flatMap(row=>row.feelings).map(feeling=>[feeling.id,feeling])).values()].sort((a,b)=>(a.sourceDate||"").localeCompare(b.sourceDate||"")||(a.eventTime||"").localeCompare(b.eventTime||""));
    const feelingsHtml=feelings.length?feelings.map(feeling=>`<article class="timeline-feeling-card mode-${escapeHtml(feeling.summaryMode)}" id="timeline-feeling-${escapeHtml(feeling.id)}"><div><time>${escapeHtml(feeling.sourceDate||"")}</time><span class="badge">importance ${feeling.importance}</span><span class="badge">${escapeHtml(feeling.summaryMode)}</span>${feeling.retainAnchor?'<span class="badge">原文锚点</span>':""}${feeling.eventAnchor?'<span class="badge">事件锚点</span>':""}</div><p>${escapeHtml(feeling.content)}</p></article>`).join(""):'<div class="empty">这些关键词暂时没有命中摘要。</div>';
    target.innerHTML=`<section class="section-card timeline-visual"><div class="section-title-row"><div><p class="eyebrow">词频与记忆点</p><h2>${escapeHtml(rows.map(row=>row.term).join(" × "))}</h2></div><div class="timeline-legend">${legends}</div></div>${timelineSvg(rows)}</section><section class="timeline-stat-grid">${stats}</section>${intersections?`<section class="section-card timeline-intersections"><h2>共同事件证据</h2>${intersections}</section>`:""}<section class="section-card timeline-feelings"><h2>对应摘要</h2><p class="timeline-query-note">点击曲线上的圆点可以跳到对应摘要；点越大，importance 越高。</p>${feelingsHtml}</section>`;
    target.querySelectorAll("[data-feeling-id]").forEach(dot=>dot.onclick=()=>{const card=target.querySelector(`#timeline-feeling-${CSS.escape(dot.dataset.feelingId)}`);card?.scrollIntoView({behavior:"smooth",block:"center"});card?.classList.add("focused");setTimeout(()=>card?.classList.remove("focused"),1400);});
  }catch(error){target.innerHTML=`<section class="section-card"><div class="empty">${escapeHtml(error.message)}</div></section>`;}
}

async function renderConversations(library,{search="",date="",focus="",page=1,calendarPage=1}={}) {
  const main=document.querySelector("#workspace-main");main.innerHTML=`<div class="dashboard-head conversation-heading"><div class="conversation-title-block"><p class="eyebrow">SQLite archive</p><h1>全量对话</h1><div id="conversation-calendar" class="conversation-calendar-slot"></div></div><button class="ghost" id="back-memory">返回</button></div><section class="section-card" id="conversation-content"><div class="empty">正在读取…</div></section>`;main.querySelector("#back-memory").onclick=()=>renderMemoryHub(library);
  const params=new URLSearchParams({page:String(page),calendarPage:String(calendarPage)});if(search)params.set("search",search);if(date)params.set("date",date);if(focus)params.set("focus",focus);const data=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/conversations?${params}`),card=main.querySelector("#conversation-content"),calendar=data.calendar;
  const calendarHtml=calendar.days.length?`<div class="activity-calendar"><div class="calendar-head"><button class="calendar-arrow" id="newer-month" aria-label="更新的月份" ${calendar.page<=1?"disabled":""}>‹</button><div><strong>${calendar.month.replace("-"," 年 ")} 月</strong><span>聊天留下的小苔痕</span></div><button class="calendar-arrow" id="older-month" aria-label="更早的月份" ${calendar.page>=calendar.totalPages?"disabled":""}>›</button></div><div class="calendar-weekdays">${["日","一","二","三","四","五","六"].map(day=>`<span>${day}</span>`).join("")}</div><div class="calendar-days">${Array.from({length:calendar.leadingBlanks},()=>'<span class="calendar-blank"></span>').join("")}${calendar.days.map(day=>`<button class="calendar-day level-${day.count===0?0:day.count<=100?1:day.count<200?2:3} ${day.date===date?"selected":""}" data-calendar-date="${day.date}" title="${day.date} · ${day.count} 条对话" aria-label="${day.date}，${day.count} 条对话"></button>`).join("")}</div></div>`:`<div class="empty">archive 中还没有纯对话。</div>`;
  const calendarSlot=main.querySelector("#conversation-calendar");calendarSlot.innerHTML=calendarHtml;
  card.innerHTML=`<div class="conversation-tools"><form id="conversation-search"><input placeholder="搜索关键词" value="${escapeHtml(search)}"><button class="secondary">搜索</button></form><div class="date-jump"><input id="conversation-date" type="date" value="${escapeHtml(date)}"><button class="secondary" id="open-date">按日期查看</button></div></div><div id="conversation-results"></div>`;
  calendarSlot.querySelectorAll("[data-calendar-date]").forEach(button=>button.onclick=()=>renderConversations(library,{date:button.dataset.calendarDate,calendarPage:calendar.page}));
  const switchMonth=nextCalendarPage=>renderConversations(library,{search,date,page:1,calendarPage:nextCalendarPage});
  calendarSlot.querySelector("#newer-month")?.addEventListener("click",()=>switchMonth(calendar.page-1));calendarSlot.querySelector("#older-month")?.addEventListener("click",()=>switchMonth(calendar.page+1));
  card.querySelector("#conversation-search").onsubmit=e=>{e.preventDefault();const q=e.currentTarget.querySelector("input").value.trim();renderConversations(library,{search:q,page:1,calendarPage:calendar.page});};card.querySelector("#open-date").onclick=()=>{const d=card.querySelector("#conversation-date").value;if(d)renderConversations(library,{date:d,page:1,calendarPage:calendarPageForDate(calendar,d)});};
  const target=card.querySelector("#conversation-results");if(data.mode==="calendar")return;
  const rows=data.rows;target.innerHTML=rows.rows.length?rows.rows.map(row=>`<article class="conversation-row ${focus===row.timestamp?"focused":""}" data-timestamp="${escapeHtml(row.timestamp)}" data-source-date="${escapeHtml(row.sourceDate)}"><time>${escapeHtml(formatBeijingTime(row.timestamp))}</time><span class="role">${escapeHtml(conversationRole(row.role,library))}</span><p>${escapeHtml(row.text)}</p>${data.mode==="search"?'<button class="ghost jump-conversation">跳转到当天对话</button>':''}</article>`).join(""):`<div class="empty">没有匹配的对话。</div>`;target.insertAdjacentHTML("beforeend",pagination(rows));target.querySelectorAll(".jump-conversation").forEach(b=>b.onclick=()=>{const row=b.closest("article"),targetDate=row.dataset.sourceDate;renderConversations(library,{date:targetDate,focus:row.dataset.timestamp,calendarPage:calendarPageForDate(calendar,targetDate)});});bindPagination(target,rows.page,rows.totalPages,nextPage=>renderConversations(library,{search,date,page:nextPage,calendarPage:calendar.page}));if(focus)setTimeout(()=>target.querySelector(".focused")?.scrollIntoView({block:"center"}),0);
}

async function renderMemorySection(library, section, page=1, search="", category="", mode="", importance="", sort="desc", retainAnchor=false, eventAnchor=false, date="") {
  const main=document.querySelector("#workspace-main"), titles={rules:"人设 / 规则",feelings:"摘要",features:"特征库"};
  main.innerHTML=`<div class="dashboard-head"><div><p class="eyebrow">记忆</p><h1>${titles[section]}</h1>${section==="feelings"?'<p class="lead memory-anchor-guide">选择【原文锚点】，将在线程中注入该摘要对应原文；选择【事件锚点】，则该摘要不受衰减模型影响；选择【隐藏摘要】，线程重建时该摘要将不注入线程。</p>':""}</div><button class="ghost" id="back-memory">返回</button></div><section class="section-card" id="memory-content"><div class="empty">正在读取…</div></section>`;
  main.querySelector("#back-memory").onclick=()=>renderMemoryHub(library);
  const card=main.querySelector("#memory-content");
  if(section==="rules") {
    const data=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rules`);
    card.innerHTML=`<div class="memory-toolbar"><label class="secondary">导入 Markdown<input id="rule-upload" type="file" accept=".md,text/markdown" hidden></label></div>${data.rows.length?data.rows.map(row=>`<article class="rule-card"><div><strong>${escapeHtml(row.name)}</strong><span class="badge">${row.injected?"已注入":"已停用"}</span></div><textarea>${escapeHtml(row.content)}</textarea><div class="rule-actions"><button class="secondary" data-save="${escapeHtml(row.name)}">保存</button><button class="ghost" data-toggle="${escapeHtml(row.name)}" data-enabled="${row.injected}">${row.injected?"停止注入":"恢复注入"}</button><button class="danger-link" data-delete="${escapeHtml(row.name)}">删除</button></div></article>`).join(""):`<div class="empty">还没有规则文档。</div>`}`;
    card.querySelector("#rule-upload").onchange=async e=>{const f=e.target.files[0];if(!f)return;await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rules`,{method:"POST",headers:{"x-file-name":encodeURIComponent(f.name)},body:f});showToast("规则已导入");renderMemorySection(library,"rules");};
    card.querySelectorAll("[data-save]").forEach(b=>b.onclick=async()=>{const name=b.dataset.save,content=b.closest("article").querySelector("textarea").value;await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rules`,{method:"PUT",headers:{"x-file-name":encodeURIComponent(name)},body:content});showToast("规则已保存");});
    card.querySelectorAll("[data-toggle]").forEach(b=>b.onclick=async()=>{await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rules/${encodeURIComponent(b.dataset.toggle)}/${b.dataset.enabled==="true"?"disable":"enable"}`,{method:"POST"});renderMemorySection(library,"rules");});
    card.querySelectorAll("[data-delete]").forEach(b=>b.onclick=async()=>{if(!confirm(`确认删除 ${b.dataset.delete}？`))return;await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rules/${encodeURIComponent(b.dataset.delete)}`,{method:"DELETE"});renderMemorySection(library,"rules");});
    return;
  }
  const params=new URLSearchParams({page:String(page),search,category,mode,importance,sort,date});if(retainAnchor)params.set("retainAnchor","1");if(eventAnchor)params.set("eventAnchor","1");
  const data=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/${section}?${params}`), rows=data.rows;
  const filters=section==="features"?`<select id="category-filter"><option value="">全部类别</option>${data.categories.map(c=>`<option ${c===category?"selected":""}>${escapeHtml(c)}</option>`).join("")}</select>`:`<select id="mode-filter"><option value="">全部状态</option>${["daily","coarse","hidden"].map(v=>`<option ${v===mode?"selected":""}>${v}</option>`).join("")}</select><select id="importance-filter"><option value="">全部 importance</option>${[1,2,3,4,5].map(v=>`<option ${String(v)===importance?"selected":""}>${v}</option>`).join("")}</select>`;
  const feelingControls=section==="feelings"?`<div class="memory-subtoolbar"><div class="filter-chips" aria-label="锚点筛选"><button class="filter-chip ${retainAnchor?"active":""}" id="retain-filter" aria-pressed="${retainAnchor}">原文锚点</button><button class="filter-chip ${eventAnchor?"active":""}" id="event-filter" aria-pressed="${eventAnchor}">事件锚点</button></div><div class="summary-date-tools"><input id="summary-date" type="date" value="${escapeHtml(date)}"><button class="ghost" id="clear-summary-date" ${date?"":"disabled"}>清除日期</button><label class="sort-control">日期顺序<select id="sort-filter"><option value="desc" ${sort==="desc"?"selected":""}>最新优先</option><option value="asc" ${sort==="asc"?"selected":""}>最早优先</option></select></label></div></div>`:"";
  card.innerHTML=`<div class="memory-toolbar"><input id="memory-search" placeholder="搜索摘要内容" value="${escapeHtml(search)}">${filters}<button class="secondary" id="memory-filter">筛选</button></div>${feelingControls}${rows.rows.length?rows.rows.map((row,index)=>section==="feelings"?feelingCard(row,index,"seq"):`<article class="memory-row"><div class="memory-time">${escapeHtml(row.source_date||"")}</div><p>${escapeHtml(row.content)}</p><span class="badge">importance ${row.importance}</span><span class="badge">${escapeHtml(row.category||"misc")}</span></article>`).join(""):`<div class="empty">没有匹配内容。</div>`}${pagination(rows)}<div id="feeling-editor"></div>`;
  const applyFilters=(nextRetain=retainAnchor,nextEvent=eventAnchor,nextDate=card.querySelector("#summary-date")?.value||"")=>renderMemorySection(library,section,1,card.querySelector("#memory-search").value,card.querySelector("#category-filter")?.value||"",card.querySelector("#mode-filter")?.value||"",card.querySelector("#importance-filter")?.value||"",card.querySelector("#sort-filter")?.value||sort,nextRetain,nextEvent,nextDate);
  card.querySelector("#memory-filter").onclick=()=>applyFilters();
  card.querySelector("#memory-search").onkeydown=event=>{if(event.key==="Enter"){event.preventDefault();applyFilters();}};
  if(section==="feelings"){card.querySelector("#retain-filter").onclick=()=>applyFilters(!retainAnchor,eventAnchor);card.querySelector("#event-filter").onclick=()=>applyFilters(retainAnchor,!eventAnchor);card.querySelector("#sort-filter").onchange=()=>applyFilters();card.querySelector("#summary-date").onchange=()=>applyFilters();card.querySelector("#clear-summary-date").onclick=()=>applyFilters(retainAnchor,eventAnchor,"");}
  bindPagination(card,rows.page,rows.totalPages,nextPage=>renderMemorySection(library,section,nextPage,search,category,mode,importance,sort,retainAnchor,eventAnchor,date));
  if(section==="feelings")bindFeelingCards(card,library,rows.rows,card.querySelector("#feeling-editor"),()=>renderMemorySection(library,section,page,search,category,mode,importance,sort,retainAnchor,eventAnchor,date));
}

function feelingCard(row,index,sequence="seq") {
  const number=sequence==="daySeq"?(row.daySeq||index+1):(row.seq||index+1),content=row.summary_mode==="coarse"&&row.coarse_summary?row.coarse_summary:row.content;
  return `<article class="memory-row feeling-card ${(row.eventAnchor||row.retainAnchor)?"anchored":""} ${row.summary_mode==="hidden"?"is-hidden":""}"><div class="memory-time">第 ${number} 条 · importance ${row.importance}</div><p>${escapeHtml(content)}</p><div class="feeling-quick-actions"><button class="ghost edit-feeling" data-index="${index}">查看 / 编辑</button><label><input class="quick-retain" type="checkbox" data-index="${index}" ${row.retainAnchor?"checked":""}>原文锚点</label><label><input class="quick-event" type="checkbox" data-index="${index}" ${row.eventAnchor?"checked":""}>事件锚点</label><label><input class="quick-hidden" type="checkbox" data-index="${index}" ${row.summary_mode==="hidden"?"checked":""}>隐藏摘要</label></div></article>`;
}

function bindFeelingCards(container,library,rows,editorTarget,refresh) {
  const refreshWithoutJump=async()=>{const scrollY=window.scrollY;await refresh();requestAnimationFrame(()=>window.scrollTo({top:scrollY,left:0,behavior:"auto"}));};
  container.querySelectorAll(".edit-feeling").forEach(button=>button.onclick=()=>renderFeelingEditor(library,rows[Number(button.dataset.index)],editorTarget,refreshWithoutJump));
  container.querySelectorAll(".quick-event").forEach(input=>input.onchange=async()=>{
    const row=rows[Number(input.dataset.index)],enabled=input.checked;input.disabled=true;
    try{await setFeelingAnchor(library,row,"event",enabled);showToast(enabled?"已设置事件锚点":"已移除事件锚点");await refreshWithoutJump();}
    catch(error){input.checked=!enabled;input.disabled=false;showToast(error.message,"error");}
  });
  container.querySelectorAll(".quick-hidden").forEach(input=>input.onchange=async()=>{
    const row=rows[Number(input.dataset.index)],hidden=input.checked;
    if(hidden&&(row.eventAnchor||row.retainAnchor)&&!confirm("这条摘要已有锚点。隐藏后摘要本身不注入，但锚点保护仍可能生效，确认继续吗？")){input.checked=false;return;}
    input.disabled=true;
    try{await api(`/api/libraries/${encodeURIComponent(library.threadId)}/feelings/update`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:row.id,summaryMode:hidden?"hidden":(row.coarse_summary?"coarse":"daily")})});showToast(hidden?"摘要已隐藏":"摘要已恢复");await refreshWithoutJump();}
    catch(error){input.checked=!hidden;input.disabled=false;showToast(error.message,"error");}
  });
  container.querySelectorAll(".quick-retain").forEach(input=>input.onchange=async()=>{
    const row=rows[Number(input.dataset.index)],enabled=input.checked;
    if(!enabled){
      input.disabled=true;
      try{
        if(!await removeRetainAnchor(library,row)){input.checked=true;input.disabled=false;return;}
        showToast("已移除原文锚点");await refreshWithoutJump();
      }catch(error){input.checked=true;input.disabled=false;showToast(error.message,"error");}
      return;
    }
    input.disabled=true;
    renderRetainSelector(library,row,editorTarget,refreshWithoutJump,()=>{input.checked=false;input.disabled=false;});
  });
}

function setFeelingAnchor(library,row,type,enabled,range={}) {
  return api(`/api/libraries/${encodeURIComponent(library.threadId)}/feelings/anchor`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:row.id,type,enabled,...range})});
}

async function removeRetainAnchor(library,row) {
  if(!confirm("是否确认取消原文锚点？取消后，线程重建将不再为这条摘要注入对应原文。"))return false;
  await setFeelingAnchor(library,row,"retain",false);
  row.retainAnchor=false;
  return true;
}

async function renderRetainSelector(library,row,target,refresh,onCancel=()=>{}) {
  target.innerHTML=`<div class="editor-overlay"><div class="editor-panel retain-selector"><button class="ghost editor-close">关闭</button><h2>确认原文锚点</h2><p class="lead">系统已按摘要时间勾选可能对应的连续对话。你可以补选或取消；最终会保存第一条到最后一条之间的完整原文范围。</p><div class="retain-feeling">${escapeHtml(row.content)}</div><div id="retain-message-list"><div class="empty">正在查找对应原文…</div></div><div class="wizard-actions"><span id="retain-count"></span><button class="primary" id="confirm-retain" disabled>确认并设置原文锚点</button></div></div></div>`;
  target.querySelector(".editor-close").onclick=()=>{target.innerHTML="";onCancel();};
  try{
    const data=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/feelings/retain-preview?id=${encodeURIComponent(row.id)}`),list=target.querySelector("#retain-message-list"),selected=new Set(data.rows.filter(item=>item.selected).map(item=>item.timestamp));
    list.innerHTML=data.rows.length?`<div class="targeted-message-list retain-message-list">${data.rows.map((item,index)=>`<label class="select-row targeted-message ${item.selected?"matched":""}" data-retain-index="${index}"><input type="checkbox" value="${escapeHtml(item.timestamp)}" ${item.selected?"checked":""}><time>${escapeHtml(formatBeijingTime(item.timestamp))}</time><span class="role">${escapeHtml(conversationRole(item.type,library))}</span><span class="context">${escapeHtml(item.text)}</span></label>`).join("")}</div>`:'<div class="empty">这一天没有可供锚定的纯对话。</div>';
    const inputs=[...list.querySelectorAll("input[type=checkbox]")],count=target.querySelector("#retain-count"),confirmButton=target.querySelector("#confirm-retain");let lastIndex=null;
    const update=()=>{count.textContent=`已选择 ${selected.size} 条对话`;confirmButton.disabled=!selected.size;};
    inputs.forEach((input,index)=>input.onclick=event=>{
      if(event.shiftKey&&lastIndex!==null){
        const [start,end]=[lastIndex,index].sort((a,b)=>a-b),checked=input.checked;
        for(let i=start;i<=end;i++){inputs[i].checked=checked;checked?selected.add(inputs[i].value):selected.delete(inputs[i].value);}
      }else input.checked?selected.add(input.value):selected.delete(input.value);
      lastIndex=index;update();
    });
    list.querySelector(".matched")?.scrollIntoView({block:"center"});
    confirmButton.onclick=async()=>{
      const chosen=data.rows.filter(item=>selected.has(item.timestamp));
      if(!chosen.length)return;
      const first=chosen[0],last=chosen.at(-1),lastIndexInDay=data.rows.findIndex(item=>item.timestamp===last.timestamp),next=data.rows[lastIndexInDay+1];
      const endUtc=next?.timestamp||new Date(new Date(last.timestamp).getTime()+1).toISOString();
      confirmButton.disabled=true;confirmButton.textContent="正在保存…";
      try{await setFeelingAnchor(library,row,"retain",true,{startUtc:first.timestamp,endUtc});row.retainAnchor=true;showToast("已设置原文锚点");await refresh();}
      catch(error){showToast(error.message,"error");confirmButton.disabled=false;confirmButton.textContent="确认并设置原文锚点";}
    };
    update();
  }catch(error){target.querySelector("#retain-message-list").innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`;}
}

function renderFeelingEditor(library,row,target,refresh) {
  target.innerHTML=`<div class="editor-overlay"><div class="editor-panel"><button class="ghost editor-close">关闭</button><h2>编辑摘要</h2><div class="field"><label>完整原始摘要（永久保留）</label><textarea disabled>${escapeHtml(row.content)}</textarea></div><div class="field"><label>注入状态</label><select id="edit-mode">${["daily","coarse","hidden"].map(v=>`<option ${row.summary_mode===v?"selected":""}>${v}</option>`).join("")}</select></div><div class="field"><label>精简文本</label><textarea id="edit-coarse">${escapeHtml(row.coarse_summary||row.content)}</textarea><small>切换为 coarse 时必须保留原摘要开头的完整日期和对应时间。</small></div><div class="field"><label>核心词（最多3个，用逗号分隔）</label><input id="edit-terms" value="${escapeHtml((()=>{try{return JSON.parse(row.coarse_terms||'[]').join(', ')}catch{return ''}})())}"></div><label class="check-card"><input id="event-anchor" type="checkbox" ${row.eventAnchor?"checked":""}><span><strong>事件锚点</strong>保护长期关键事件。</span></label><label class="check-card"><input id="retain-anchor" type="checkbox" ${row.retainAnchor?"checked":""}><span><strong>原文锚点</strong>rebuild 时保留对应真实对话。</span></label><div class="integrity warning" id="anchor-warning" hidden>hidden 会停止摘要注入，但锚点仍可能保护事件或原文，请确认这是你想要的组合。</div><div class="wizard-actions"><span></span><button class="primary" id="save-feeling">保存并立即生效</button></div></div></div>`;
  target.querySelector(".editor-close").onclick=()=>target.innerHTML="";
  const warn=()=>target.querySelector("#anchor-warning").hidden=!(target.querySelector("#edit-mode").value==="hidden"&&(target.querySelector("#event-anchor").checked||target.querySelector("#retain-anchor").checked)); target.querySelectorAll("select,input[type=checkbox]").forEach(el=>el.onchange=warn);warn();
  target.querySelector("#save-feeling").onclick=async()=>{const button=target.querySelector("#save-feeling"),mode=target.querySelector("#edit-mode").value;button.disabled=true;try{const update={id:row.id,summaryMode:mode};if(mode==="coarse"){update.coarseSummary=target.querySelector("#edit-coarse").value;update.coreTerms=target.querySelector("#edit-terms").value.split(/[,，]/).map(v=>v.trim()).filter(Boolean);}await api(`/api/libraries/${encodeURIComponent(library.threadId)}/feelings/update`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(update)});await setFeelingAnchor(library,row,"event",target.querySelector("#event-anchor").checked);const retainInput=target.querySelector("#retain-anchor"),retainEnabled=retainInput.checked;if(!retainEnabled&&row.retainAnchor){if(!await removeRetainAnchor(library,row)){retainInput.checked=true;button.disabled=false;return;}}else if(retainEnabled&&row.retainAnchor)await setFeelingAnchor(library,row,"retain",true);if(retainEnabled&&!row.retainAnchor){showToast("摘要已保存，请确认要注入的原文范围");renderRetainSelector(library,row,target,refresh);return;}showToast("摘要已保存，下次 rebuild 立即使用");refresh();}catch(error){showToast(error.message,"error");button.disabled=false;}};
}

async function renderSettings(library) {
  document.querySelectorAll(".side-nav button").forEach(button => button.classList.toggle("active", button.dataset.view === "settings"));
  const main = document.querySelector("#workspace-main");
  main.innerHTML = `<div class="dashboard-head"><div><p class="eyebrow">记忆体配置</p><h1>设置</h1><p class="lead">这里展示并编辑创建记忆体时填写的 init 配置。</p></div></div><section class="section-card"><div class="empty">正在读取设置…</div></section>`;
  try {
    const config = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`);
    const card = main.querySelector(".section-card");
    card.innerHTML = `<form id="settings-form"><div class="field-grid">
      <div class="field full"><label for="setting-libraryName">记忆体名字</label><input id="setting-libraryName" name="libraryName" value="${escapeHtml(config.libraryName)}" required><small>控制台和记忆体大厅显示的名称；不能与其他记忆体重名。</small></div>
      <div class="field full"><label for="setting-threadId">绑定线程</label><input id="setting-threadId" value="${escapeHtml(config.threadId)}" disabled><small>真实线程的绑定标识，创建后不可修改。</small></div>
      <div class="field"><label for="setting-ai">AI 名字</label><input id="setting-ai" name="ai" value="${escapeHtml(config.ai)}" required></div>
      <div class="field"><label for="setting-user">用户名字</label><input id="setting-user" name="user" value="${escapeHtml(config.user)}" required></div>
      <div class="field"><label for="setting-gender">用户性别</label><select id="setting-gender" name="userGender"><option value="unspecified" ${config.userGender === "unspecified" ? "selected" : ""}>不指定</option><option value="female" ${config.userGender === "female" ? "selected" : ""}>女性</option><option value="male" ${config.userGender === "male" ? "selected" : ""}>男性</option></select></div>
      <div class="field"><label for="setting-miner">挖掘方式</label><select id="setting-miner" name="minerMode"><option value="subagent" ${config.minerMode === "subagent" ? "selected" : ""}>本地 Subagent</option><option value="api" ${config.minerMode === "api" ? "selected" : ""}>API</option></select></div>
      <div class="field"><label>运行时</label><input value="${escapeHtml(config.runtime)}" disabled><small>涉及目录迁移，暂不在设置页修改。</small></div>
      <div class="field"><label>用途</label><input value="${escapeHtml(config.purpose)}" disabled><small>涉及目录迁移，暂不在设置页修改。</small></div>
      <div class="field full"><label for="setting-session">线程文件搜索目录</label><input id="setting-session" name="sessionDir" value="${escapeHtml(config.sessionDir)}" required><small>Stone Memory 会从这里递归查找绑定线程的 JSONL，支持 Codex 的 sessions/年/月/日目录。</small></div>
      <div id="setting-api-fields" class="field full"></div>
      <div class="field"><label for="setting-window">默认保留对话天数</label><input id="setting-window" name="windowDays" type="number" min="1" max="365" value="${config.windowDays}"></div>
      <div class="field"><label for="setting-tools">默认保留工具链组数</label><input id="setting-tools" name="keepToolPairs" type="number" min="0" max="500" value="${config.keepToolPairs}"></div>
      <div class="field full"><label for="setting-context-window">上下文窗口上限（tokens，可选）</label><input id="setting-context-window" name="contextWindowTokens" type="number" min="1000" step="1000" value="${config.contextWindowTokens||""}" placeholder="例如 1000000"><small>Claude 建议填写；Codex 通常能自动识别。手动值优先。</small></div>
      <label class="check-card full"><input type="checkbox" name="automaticFullMining" ${config.automaticFullMining ? "checked" : ""}><span><strong>自动挖掘全量对话</strong>处理 SQLite archive 中所有尚未挖掘的历史日期。</span></label>
      <label class="check-card full"><input type="checkbox" name="automaticMemoryMaintenance" ${config.automaticMemoryMaintenance ? "checked" : ""}><span><strong>自动执行记忆挖掘 / 压缩</strong>监听创建后的新对话，并按已配置水位执行压缩。</span></label>
      <div class="integrity full">纯对话 archive 保存在本地共享 SQLite 的 messages 表；memory/archive/full 才是按天保存的原始线程文件备份。</div>
    </div><div class="wizard-actions"><button class="danger-button" id="delete-library" type="button">删除记忆体</button><button class="primary" type="submit">保存设置</button></div></form>`;
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
      values.windowDays = Number(values.windowDays); values.keepToolPairs = Number(values.keepToolPairs); values.contextWindowTokens = values.contextWindowTokens ? Number(values.contextWindowTokens) : 0;
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
    card.querySelector("#delete-library").onclick = async () => {
      if (!window.confirm("确认要删除吗？删除后无法恢复")) return;
      const button = card.querySelector("#delete-library"); button.disabled = true; button.textContent = "正在删除…";
      try {
        await api(`/api/libraries/${encodeURIComponent(library.threadId)}`, { method: "DELETE" });
        await loadLibraries(); showToast("记忆体已删除"); state.libraries.length ? lobby() : welcome();
      } catch (error) { showToast(error.message, "error"); button.disabled = false; button.textContent = "删除记忆体"; }
    };
  } catch (error) { main.querySelector(".section-card").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

const rebuildState = { windowDays: 3, toolPairs: 30, watermark: false, page: 1, toolPage: 1, tab: "messages", excludedMessages: new Set(), excludedTools: new Set(), preview: null };
const miningUi={threadId:null,selected:new Set(),page:1,reportPage:1,reportFilter:"all",monthPage:1,selectedDate:null,mode:null,timer:null,targetedSelected:new Set(),targetedLastIndex:null};
const compressionUi={mode:"subagent",afterDays:90};

function renderMaintenance(library) {
  document.querySelectorAll(".side-nav button").forEach(button => button.classList.toggle("active", button.dataset.view === "maintenance"));
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`<div class="dashboard-head"><div><p class="eyebrow">Lifecycle workspace</p><h1>维护</h1><p class="lead">导入、挖掘并整理记忆，维护当前对话线程。</p></div></div><section class="maintenance-grid"><button class="maintenance-card" id="open-import"><span><strong>对话导入</strong><small>导入新的线程文件或历史记录，并预览纯对话识别结果</small></span><i aria-hidden="true">→</i></button><button class="maintenance-card" id="open-mining"><span><strong>记忆挖掘</strong><small>从已有对话中挖掘摘要与长期特征</small></span><i aria-hidden="true">→</i></button><button class="maintenance-card" id="open-compression"><span><strong>记忆压缩</strong><small>根据时间曲线与生命周期证据，逐步精简旧摘要</small></span><i aria-hidden="true">→</i></button><button class="maintenance-card" id="open-rebuild"><span><strong>线程重建</strong><small>重建近期上下文、裁剪对话并检查线程完整性</small></span><i aria-hidden="true">→</i></button></section>`;
  main.querySelector("#open-import").onclick=()=>renderConversationImport(library);
  main.querySelector("#open-mining").onclick=()=>renderMining(library);
  main.querySelector("#open-compression").onclick=()=>renderCompression(library);
  main.querySelector("#open-rebuild").onclick=()=>renderRebuild(library);
}

async function renderCompression(library,kind="compact",report=null) {
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`<div class="dashboard-head"><div><p class="eyebrow">Memory lifecycle</p><h1>记忆压缩</h1><p class="lead">先查看系统建议，再决定是否精简或隐藏；完整摘要内容始终保留在 SQLite 中。</p></div><button class="ghost" id="back-maintenance">返回维护</button></div><section class="compression-mode-grid"><button class="${kind==="compact"?"active":""}" data-compression-kind="compact"><strong>摘要精简</strong><span>将适合压缩的 daily 摘要改为 coarse，保留日期、事实与关键感受</span></button><button class="${kind==="hidden"?"active":""}" data-compression-kind="hidden"><strong>长期隐藏</strong><span>将长期沉寂的 coarse 摘要停止注入线程，不删除完整内容</span></button></section><section class="section-card compression-control"><div><p class="eyebrow">${kind==="compact"?"推荐窗口":"沉寂检查"}</p><h2>${kind==="compact"?"寻找低风险、高收益的一周":"检查长期不再出现的事实"}</h2><p>${kind==="compact"?"系统综合锚点、关系阶段、副核心与 importance 排序；预览不会调用模型。":"默认只检查核心词至少 90 天未再出现的 coarse 摘要；锚点和仍由 relation 接管的摘要受保护。"}</p></div>${kind==="compact"?`<label>执行通道<select id="compression-mode"><option value="subagent" ${compressionUi.mode==="subagent"?"selected":""}>Subagent</option><option value="api" ${compressionUi.mode==="api"?"selected":""}>API</option></select></label>`:`<label>沉寂阈值<div class="compact-number"><input id="hidden-days" type="number" min="1" max="3650" value="${compressionUi.afterDays}"><span>天</span></div></label>`}<button class="primary" id="preview-compression">生成压缩建议</button></section><div id="compression-report">${report?renderCompressionReport(kind,report):""}</div>`;
  main.querySelector("#back-maintenance").onclick=()=>renderMaintenance(library);
  main.querySelectorAll("[data-compression-kind]").forEach(button=>button.onclick=()=>renderCompression(library,button.dataset.compressionKind));
  main.querySelector("#compression-mode")?.addEventListener("change",event=>{compressionUi.mode=event.target.value;});
  main.querySelector("#hidden-days")?.addEventListener("change",event=>{compressionUi.afterDays=Math.max(1,Number(event.target.value)||90);});
  main.querySelector("#preview-compression").onclick=async()=>{
    const button=main.querySelector("#preview-compression"),afterDays=Number(main.querySelector("#hidden-days")?.value)||compressionUi.afterDays;
    compressionUi.afterDays=afterDays;compressionUi.mode=main.querySelector("#compression-mode")?.value||compressionUi.mode;
    button.disabled=true;button.textContent="正在分析…";
    try{const data=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/compression/preview?kind=${kind}&afterDays=${afterDays}`);renderCompression(library,kind,data);}
    catch(error){showToast(error.message,"error");button.disabled=false;button.textContent="生成压缩建议";}
  };
  if(report){
    const apply=main.querySelector("#apply-compression");
    if(apply)apply.onclick=async()=>{
      const compactReport=report.reports?.[0],afterDays=Number(main.querySelector("#hidden-days")?.value)||report.afterDays||90;
      if(!confirm(kind==="compact"?`确认精简 ${compactReport?.coarse||0} 条摘要？完整内容仍会保留。`:`确认隐藏 ${report.candidates||0} 条摘要？之后重建将不再注入这些摘要。`))return;
      apply.disabled=true;apply.textContent=kind==="compact"?"正在调用模型压缩…":"正在应用…";
      try{
        const result=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/compression/apply`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
          kind,mode:compressionUi.mode,
          from:compactReport?.from,to:compactReport?.to,afterDays,
        })});
        showToast(kind==="compact"?"摘要精简已完成":"长期隐藏已完成");renderCompression(library,kind,result);
      }catch(error){showToast(error.message,"error");apply.disabled=false;apply.textContent="确认执行";}
    };
    main.querySelector("#open-compression-feelings")?.addEventListener("click",()=>renderMemorySection(library,"feelings"));
  }
}

function renderCompressionReport(kind,data) {
  if(kind==="hidden"){
    const examples=(data.examples||[]).map(row=>`<article class="compression-example"><div><time>${escapeHtml(row.sourceDate||"")}</time><span class="badge">importance ${row.importance}</span></div><p>${escapeHtml(row.content||"")}</p><small>${escapeHtml((row.coreTerms||[]).join(" + "))} · ${escapeHtml(row.reason||"")}</small></article>`).join("");
    return `<section class="section-card compression-report-card"><div class="section-title-row"><div><p class="eyebrow">${data.apply?"Hidden 已执行":"Hidden dry-run"}</p><h2>${data.apply?`已隐藏 ${data.updated||0} 条摘要`:`${data.candidates||0} 条长期隐藏候选`}</h2></div><span class="badge">参考日期 ${escapeHtml(data.referenceDate||"—")}</span></div><div class="compression-metrics"><div><span>现有 coarse</span><strong>${data.coarseFeelings||0}</strong></div><div><span>隐藏候选</span><strong>${data.candidates||0}</strong></div><div><span>副核心库</span><strong>${escapeHtml(data.secondaryCategory||"无")}</strong></div><div><span>沉寂阈值</span><strong>${data.afterDays||90} 天</strong></div></div>${examples?`<h3>候选示例</h3>${examples}`:'<div class="empty">当前没有适合长期隐藏的摘要。</div>'}<div class="wizard-actions"><button class="ghost" id="open-compression-feelings">查看全部摘要</button>${data.candidates&&!data.apply?'<button class="primary" id="apply-compression">确认执行长期隐藏</button>':""}</div></section>`;
  }
  const row=data.reports?.[0];
  if(!row)return `<section class="section-card"><div class="empty">当前没有需要 coarse 的 daily 摘要。</div><div class="wizard-actions"><button class="ghost" id="open-compression-feelings">查看全部摘要</button></div></section>`;
  const routes=Object.entries(row.routes||{}).map(([route,count])=>`<span class="badge">${escapeHtml(route)} ${count}</span>`).join("");
  const examples=(row.coarseExamples||[]).map(item=>`<article class="compression-example"><div><time>${escapeHtml(item.sourceDate||"")}</time><span class="badge">${escapeHtml(item.route||"")}</span><span class="badge">importance ${item.importance}</span></div><p>${escapeHtml(item.content||"")}</p><small>${escapeHtml(item.reason||"")}</small></article>`).join("");
  return `<section class="section-card compression-report-card"><div class="section-title-row"><div><p class="eyebrow">${row.applied?"Compact 已执行":"Compact dry-run"}</p><h2>${escapeHtml(row.from)} ～ ${escapeHtml(row.to)}</h2></div><span class="badge">${row.applied?`已精简 ${row.updated||0} 条`:`推荐第 ${row.rank}/${row.eligibleWeeks} 周`}</span></div><div class="compression-metrics"><div><span>当前注入字符</span><strong>${data.currentChars||0}</strong></div><div><span>保留 keep</span><strong>${row.keep||0}</strong></div><div><span>建议 coarse</span><strong>${row.coarse||0}</strong></div><div><span>${row.applied?"实际减少":"预计减少"}</span><strong>${row.applied?row.actualSaving||0:Math.max(0,(row.windowCharacters?.before||0)-(row.windowCharacters?.estimatedAfter||0))}</strong></div></div><p class="compression-profile">主核心 relation · 副核心 ${escapeHtml(row.categoryProfile?.secondaryCategory||"无")}　${routes}</p><h3>建议精简示例</h3>${examples||'<div class="empty">没有 coarse 示例。</div>'}<div class="wizard-actions"><button class="ghost" id="open-compression-feelings">查看全部摘要</button>${row.applied?"":'<button class="primary" id="apply-compression">确认执行本周精简</button>'}</div></section>`;
}

function renderConversationImport(library) {
  state.imports=[];
  document.querySelectorAll(".side-nav button").forEach(button=>button.classList.toggle("active",button.dataset.view==="maintenance"));
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`<div class="dashboard-head"><div><p class="eyebrow">对话维护</p><h1>对话导入</h1><p class="lead">支持 Claude、Codex 线程文件、JSON、JSONL 和 SQLite；确认识别结果后再写入当前记忆体。</p></div><button class="ghost" id="back-maintenance">返回维护</button></div><section class="section-card"><div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="上传对话文件"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 002 2h10a2 2 0 002-2v-4"/></svg><strong>把文件拖到这里</strong><p>或者点击打开文件资源管理器</p><button class="secondary" type="button">选择文件</button><input id="file-input" type="file" accept=".json,.jsonl,.db,.sqlite,.sqlite3" multiple hidden></div><div class="import-list" id="import-list"></div><div class="wizard-actions"><span></span><button class="primary" id="apply-import" disabled>导入当前记忆体</button></div></section>`;
  const input=main.querySelector("#file-input"),zone=main.querySelector("#dropzone"),apply=main.querySelector("#apply-import");
  const receive=async files=>{await uploadFiles(files);apply.disabled=!state.imports.length;apply.textContent=state.imports.length?`导入 ${state.imports.length} 个文件`:"导入当前记忆体";};
  zone.onclick=event=>{if(event.target.tagName!=="INPUT")input.click();};
  zone.onkeydown=event=>{if(["Enter"," "].includes(event.key)){event.preventDefault();input.click();}};
  zone.ondragover=event=>{event.preventDefault();zone.classList.add("dragging");};
  zone.ondragleave=()=>zone.classList.remove("dragging");
  zone.ondrop=event=>{event.preventDefault();zone.classList.remove("dragging");receive(event.dataTransfer.files);};
  input.onchange=()=>receive(input.files);
  main.querySelector("#back-maintenance").onclick=()=>renderMaintenance(library);
  apply.onclick=async()=>{
    apply.disabled=true;apply.textContent="正在导入…";
    try{
      const result=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/imports`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({importTokens:state.imports.map(item=>item.token)})});
      state.imports=[];showToast(`已导入 ${result.imported} 条纯对话`);renderMaintenance(library);
    }catch(error){showToast(error.message,"error");apply.disabled=false;apply.textContent=`导入 ${state.imports.length} 个文件`;}
  };
  renderImports();
}

function miningStatusLabel(row){return row.status==="completed"?"已完成":row.status==="completed_empty"?"无需记录":row.status==="running"?"正在挖掘":row.status==="failed"?"失败":"尚未挖掘";}

async function renderMining(library,page=1) {
  if(miningUi.threadId!==library.threadId){miningUi.threadId=library.threadId;miningUi.selected.clear();miningUi.targetedSelected.clear();miningUi.targetedLastIndex=null;miningUi.page=1;miningUi.reportPage=1;miningUi.reportFilter="all";miningUi.monthPage=1;miningUi.selectedDate=null;miningUi.mode=null;}
  clearTimeout(miningUi.timer);miningUi.page=page;
  document.querySelectorAll(".side-nav button").forEach(button=>button.classList.toggle("active",button.dataset.view==="maintenance"));
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`<div class="dashboard-head"><div><p class="eyebrow">记忆维护</p><h1>记忆挖掘</h1><p class="lead">查看每天从对话中留下的摘要与特征。</p><p class="mining-first-run"><strong>第一次重建线程前需要挖掘全量对话；此后可通过“自动挖掘全量对话 / 自动执行记忆挖掘”让系统自行维护。</strong></p></div><button class="ghost" id="back-maintenance">返回维护</button></div><div id="mining-content"><section class="section-card"><div class="empty">正在读取挖掘结果…</div></section></div>`;
  main.querySelector("#back-maintenance").onclick=()=>{clearTimeout(miningUi.timer);renderMaintenance(library);};
  try{
    const [data,config]=await Promise.all([api(`/api/libraries/${encodeURIComponent(library.threadId)}/mining/status`),miningUi.mode?Promise.resolve(null):api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`)]);
    if(!miningUi.mode)miningUi.mode=config?.minerMode==="api"?"api":"subagent";
    const job=data.job,active=job&&["queued","running"].includes(job.status),matchesFilter=row=>miningUi.reportFilter==="pending"?!["completed","completed_empty","failed"].includes(row.status):miningUi.reportFilter==="completed"?["completed","completed_empty"].includes(row.status):miningUi.reportFilter==="failed"?row.status==="failed":true,reports=data.dates.filter(matchesFilter),reportPageSize=8,reportTotalPages=Math.max(1,Math.ceil(reports.length/reportPageSize));
    miningUi.reportPage=Math.min(Math.max(1,miningUi.reportPage),reportTotalPages);const reportRows=reports.slice((miningUi.reportPage-1)*reportPageSize,miningUi.reportPage*reportPageSize);
    if(!miningUi.selectedDate)miningUi.selectedDate=data.dates[0]?.date||null;
    const detail=miningUi.selectedDate?await api(`/api/libraries/${encodeURIComponent(library.threadId)}/mining/day?date=${miningUi.selectedDate}`):{feelings:[],features:[]};
    const progress=job?.dates?.length?Math.round((job.completed/job.dates.length)*100):0,calendar=miningCalendarData(data.dates,miningUi.monthPage);miningUi.monthPage=calendar.page;
    const jobHtml=job?`<div class="mining-progress ${job.status.includes("error")||job.status==="failed"?"has-errors":""}"><div class="mining-progress-head"><div><strong>${active?`正在挖掘 ${job.currentDate||"准备中"}`:job.status==="completed"?"本次挖掘已完成":"本次挖掘完成，部分日期失败"}</strong><span>${job.completed} / ${job.dates.length} 天 · ${job.mode==="api"?"API":"Subagent"}</span></div><b>${progress}%</b></div><div class="progress-track"><i style="width:${progress}%"></i></div>${job.results.some(row=>row.status==="failed")?`<details><summary>查看失败日期</summary>${job.results.filter(row=>row.status==="failed").map(row=>`<p>${escapeHtml(row.date)}：${escapeHtml(row.error)}</p>`).join("")}</details>`:""}</div>`:"";
    const dayClass=day=>!day.row?"mining-none":day.row.status==="failed"?"mining-failed":day.row.status==="running"?"mining-running":["completed","completed_empty"].includes(day.row.status)?(day.row.feelingCount>=10?"mining-deep":"mining-light"):"mining-pending";
    const calendarHtml=calendar.days.length?`<div class="mining-calendar"><div class="calendar-head"><button class="calendar-arrow" id="mining-newer" ${calendar.page<=1?"disabled":""}>‹</button><div><strong>${calendar.month.replace("-"," 年 ")} 月</strong><span>每天留下的记忆颜色</span></div><button class="calendar-arrow" id="mining-older" ${calendar.page>=calendar.totalPages?"disabled":""}>›</button></div><div class="calendar-weekdays">${["日","一","二","三","四","五","六"].map(day=>`<span>${day}</span>`).join("")}</div><div class="calendar-days">${Array.from({length:calendar.leadingBlanks},()=>'<span class="calendar-blank"></span>').join("")}${calendar.days.map(day=>`<button class="calendar-day ${dayClass(day)} ${day.date===miningUi.selectedDate?"selected":""}" data-mining-date="${day.date}" ${day.row?"":"disabled"} title="${day.date}${day.row?` · ${miningStatusLabel(day.row)} · ${day.row.feelingCount} 条摘要`:" · 无对话"}"></button>`).join("")}</div><div class="mining-legend"><span><i class="mining-none"></i>无对话</span><span><i class="mining-pending"></i>未挖掘</span><span><i class="mining-light"></i>&lt;10 摘要</span><span><i class="mining-deep"></i>≥10 摘要</span></div></div>`:"";
    const reportHtml=reports.length?`${reportRows.map(row=>{const actionable=!["completed","completed_empty"].includes(row.status);return `<article class="mining-report ${row.date===miningUi.selectedDate?"active":""} ${row.status==="failed"?"failed":""}"><label class="mining-report-check" title="${actionable?"选择这个日期进行挖掘":"这个日期已经完成挖掘"}"><input type="checkbox" value="${row.date}" ${miningUi.selected.has(row.date)?"checked":""} ${active||!actionable?"disabled":""}></label><button class="mining-report-open" data-report-date="${row.date}"><span><strong>${formatChineseDate(row.date)}</strong><small>${row.status==="failed"?`挖掘失败${row.errorMessage?` · ${escapeHtml(row.errorMessage)}`:""}`:row.status==="pending"?`尚未挖掘 · 共 ${row.messageCount} 条对话`:`共 ${row.messageCount} 条对话，挖掘出 ${row.feelingCount} 条摘要、${row.featureCount} 条特征`}</small></span><time>${row.updatedAt?escapeHtml(formatBeijingTime(row.updatedAt)):miningStatusLabel(row)}</time></button></article>`;}).join("")}${pagination({page:miningUi.reportPage,totalPages:reportTotalPages})}`:'<div class="empty">当前筛选下没有日期。</div>';
    const categories=[...new Set(detail.features.map(row=>row.category))].map(category=>`<span class="badge">${escapeHtml(category)} ${detail.features.filter(row=>row.category===category).length}</span>`).join("");
    const detailHtml=miningUi.selectedDate?`<section class="section-card mining-results"><div class="section-title-row"><div><p class="eyebrow">${formatChineseDate(miningUi.selectedDate)}</p><h2>当天挖出的摘要</h2></div><div class="mining-result-actions"><span>${categories}</span><button class="secondary" id="open-targeted" ${active?"disabled":""}>精准补挖</button></div></div><p class="memory-anchor-guide">选择【原文锚点】，将在线程中注入该摘要对应原文；选择【事件锚点】，则该摘要不受衰减模型影响；选择【隐藏摘要】，线程重建时该摘要将不注入线程。</p><div id="targeted-panel"></div>${detail.feelings.length?detail.feelings.map((row,index)=>feelingCard(row,index,"daySeq")).join(""):'<div class="empty">这一天尚未生成摘要，或本次挖掘没有需要记录的内容。</div>'}<div id="feeling-editor"></div></section>`:"";
    const content=main.querySelector("#mining-content");
    content.innerHTML=`${jobHtml}<section class="section-card mining-overview"><div class="mining-overview-grid">${calendarHtml}<div class="mining-report-list"><div class="section-title-row mining-report-title"><div><p class="eyebrow">按日管理</p><h2>每日挖掘状态</h2></div><div class="mining-status-filters">${[["all","全部"],["pending","待挖掘"],["completed","已完成"],["failed","失败"]].map(([value,label])=>`<button class="filter-chip ${miningUi.reportFilter===value?"active":""}" data-mining-filter="${value}">${label}</button>`).join("")}</div></div><div class="mining-report-actions"><select id="mining-mode" ${active?"disabled":""}><option value="subagent" ${miningUi.mode==="subagent"?"selected":""}>Subagent</option><option value="api" ${miningUi.mode==="api"?"selected":""}>API</option></select><button class="ghost" id="select-pending" ${active?"disabled":""}>全选未挖掘</button><button class="ghost" id="clear-dates" ${active?"disabled":""}>清空</button><span>已选 <strong id="selected-count">${miningUi.selected.size}</strong> 天</span><button class="primary" id="start-mining" ${active||!miningUi.selected.size?"disabled":""}>挖掘所选日期</button></div>${reportHtml}</div></div></section>${detailHtml}`;
    content.querySelectorAll("[data-mining-date],[data-report-date]").forEach(button=>button.onclick=()=>{miningUi.selectedDate=button.dataset.miningDate||button.dataset.reportDate;renderMining(library,miningUi.page);});
    bindPagination(content.querySelector(".mining-report-list"),miningUi.reportPage,reportTotalPages,next=>{miningUi.reportPage=next;renderMining(library,miningUi.page);});
    content.querySelector("#mining-newer")?.addEventListener("click",()=>{miningUi.monthPage=calendar.page-1;renderMining(library,miningUi.page);});content.querySelector("#mining-older")?.addEventListener("click",()=>{miningUi.monthPage=calendar.page+1;renderMining(library,miningUi.page);});
    content.querySelector("#open-targeted")?.addEventListener("click",()=>renderTargetedMining(library,miningUi.selectedDate));
    if(miningUi.selectedDate)bindFeelingCards(content,library,detail.feelings,content.querySelector("#feeling-editor"),()=>renderMining(library,miningUi.page));
    const reportList=content.querySelector(".mining-report-list");
    const updateCount=()=>{reportList.querySelector("#selected-count").textContent=miningUi.selected.size;reportList.querySelector("#start-mining").disabled=active||!miningUi.selected.size;};
    reportList.querySelectorAll('.mining-report-check input').forEach(input=>input.onchange=()=>{input.checked?miningUi.selected.add(input.value):miningUi.selected.delete(input.value);updateCount();});
    reportList.querySelectorAll("[data-mining-filter]").forEach(button=>button.onclick=()=>{miningUi.reportFilter=button.dataset.miningFilter;miningUi.reportPage=1;renderMining(library,miningUi.page);});
    reportList.querySelector("#mining-mode").onchange=e=>miningUi.mode=e.target.value;
    reportList.querySelector("#select-pending").onclick=()=>{data.dates.filter(row=>!["completed","completed_empty"].includes(row.status)).forEach(row=>miningUi.selected.add(row.date));renderMining(library,miningUi.page);};
    reportList.querySelector("#clear-dates").onclick=()=>{miningUi.selected.clear();renderMining(library,miningUi.page);};
    reportList.querySelector("#start-mining").onclick=async()=>{const button=reportList.querySelector("#start-mining");button.disabled=true;try{await api(`/api/libraries/${encodeURIComponent(library.threadId)}/mining/start`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mode:miningUi.mode,dates:[...miningUi.selected]})});miningUi.selected.clear();showToast("记忆挖掘已开始");renderMining(library,1);}catch(error){showToast(error.message,"error");button.disabled=false;}};
    if(active)miningUi.timer=setTimeout(()=>{if(document.querySelector("#mining-content"))renderMining(library,miningUi.page);},5000);
  }catch(error){main.querySelector("#mining-content").innerHTML=`<section class="section-card"><div class="empty">${escapeHtml(error.message)}</div></section>`;}
}

async function renderTargetedMining(library,date) {
  const panel=document.querySelector("#targeted-panel");if(!panel)return;
  miningUi.targetedSelected.clear();miningUi.targetedLastIndex=null;
  panel.innerHTML=`<div class="targeted-mining"><form class="targeted-search"><input name="search" placeholder="搜索当天对话中的关键词" required><button class="secondary">搜索</button></form><p class="targeted-help">搜索会标出命中位置。勾选一条后按住 Shift 再勾选另一条，可快速选中整段对话。</p><div id="targeted-results"><div class="empty">先搜索一个与遗漏事件有关的关键词。</div></div></div>`;
  const form=panel.querySelector("form");
  form.onsubmit=async event=>{
    event.preventDefault();const search=form.search.value.trim();if(!search)return;
    const target=panel.querySelector("#targeted-results");target.innerHTML='<div class="empty">正在查找当天对话…</div>';
    try{
      const data=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/mining/targeted-messages?date=${encodeURIComponent(date)}&search=${encodeURIComponent(search)}`);
      miningUi.targetedSelected.clear();miningUi.targetedLastIndex=null;
      target.innerHTML=data.matchCount?`<div class="targeted-summary">命中 ${data.matchCount} 条；请选择需要交给模型的完整对话范围。</div><div class="targeted-message-list">${data.rows.map((row,index)=>`<label class="select-row targeted-message ${row.matched?"matched":""}" data-targeted-index="${index}"><input type="checkbox" value="${escapeHtml(row.timestamp)}"><time>${escapeHtml(formatBeijingTime(row.timestamp))}</time><span class="role">${escapeHtml(conversationRole(row.role,library))}</span><span class="context">${escapeHtml(row.text)}</span></label>`).join("")}</div><div class="targeted-footer"><span>已选择 <strong id="targeted-count">0</strong> 条对话</span><div><select id="targeted-mode"><option value="subagent" ${miningUi.mode==="subagent"?"selected":""}>Subagent</option><option value="api" ${miningUi.mode==="api"?"selected":""}>API</option></select><button class="primary" id="run-targeted" disabled>补挖所选对话</button></div></div>`:'<div class="empty">当天没有命中这个关键词。</div>';
      if(!data.matchCount)return;
      const inputs=[...target.querySelectorAll('.targeted-message input')],count=target.querySelector("#targeted-count"),run=target.querySelector("#run-targeted");
      const refresh=()=>{count.textContent=miningUi.targetedSelected.size;run.disabled=!miningUi.targetedSelected.size;};
      inputs.forEach((input,index)=>input.onclick=click=>{
        if(click.shiftKey&&miningUi.targetedLastIndex!==null){
          const [start,end]=[miningUi.targetedLastIndex,index].sort((a,b)=>a-b);
          const checked=input.checked;
          for(let i=start;i<=end;i++){inputs[i].checked=checked;checked?miningUi.targetedSelected.add(inputs[i].value):miningUi.targetedSelected.delete(inputs[i].value);}
        }else input.checked?miningUi.targetedSelected.add(input.value):miningUi.targetedSelected.delete(input.value);
        miningUi.targetedLastIndex=index;refresh();
      });
      target.querySelector(".targeted-message.matched")?.scrollIntoView({block:"center"});
      run.onclick=async()=>{
        run.disabled=true;run.textContent="正在精准补挖…";
        try{
          await api(`/api/libraries/${encodeURIComponent(library.threadId)}/mining/targeted`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({date,mode:target.querySelector("#targeted-mode").value,timestamps:[...miningUi.targetedSelected]})});
          showToast("精准补挖完成，摘要已追加");await renderMining(library,miningUi.page);
        }catch(error){showToast(error.message,"error");run.disabled=false;run.textContent="补挖所选对话";}
      };
    }catch(error){target.innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`;}
  };
}

async function renderRebuild(library) {
  document.querySelectorAll(".side-nav button").forEach(button => button.classList.toggle("active", button.dataset.view === "maintenance"));
  const main = document.querySelector("#workspace-main");
  main.innerHTML = `<div class="dashboard-head"><div><p class="eyebrow">线程生命周期</p><h1>线程重建</h1><p class="lead">先检查即将写入线程的内容，再确认应用；线程状态和裁剪工具集中在同一页。</p></div><button class="ghost" id="back-maintenance">返回维护</button></div><section class="section-card rebuild-command-center"><div class="rebuild-primary-actions"><button class="primary rebuild-main-button" id="preview-rebuild"><strong>线程重建</strong><span>先生成中文预览，不会立即改写线程</span></button><button class="secondary rebuild-main-button" id="check-thread"><strong>一键修复</strong><span>检查线程结构，发现问题后备份并修复</span></button></div><div class="rebuild-controls integrated-rebuild-controls"><div class="field"><label for="window-days">保留活跃对话日</label><input id="window-days" type="number" min="1" max="365" value="${rebuildState.windowDays}"><small>天</small></div><div class="field"><label for="tool-pairs">保留工具调用</label><input id="tool-pairs" type="number" min="0" max="500" value="${rebuildState.toolPairs}"><small>组</small></div></div><label class="rebuild-watermark-option"><input id="watermark-mode" type="checkbox" ${rebuildState.watermark?"checked":""}><span><strong>水位线模式</strong><small>从最后一条事件摘要对应的原文开始保留到线程末尾；无法定位时仍按上方活跃日设置重建。</small></span></label><p class="tool-memory-note"><span aria-hidden="true">●</span> 如果不保留工具链，Agent 重建后会失去近期工具调用及其结果的上下文记忆。</p><div id="rebuild-dry-run"></div><div id="integrity"></div></section><section class="section-card rebuild-status"><div class="section-title-row"><div><p class="eyebrow">当前配置</p><h2>线程状态</h2></div></div><details class="rebuild-fold"><summary><span><strong>人设 / 规则</strong><small id="rebuild-rule-summary">正在读取…</small></span><i>⌄</i></summary><div class="rebuild-fold-content" id="rebuild-rules"></div></details><details class="rebuild-fold"><summary><span><strong>摘要</strong><small id="rebuild-feeling-summary">正在读取…</small></span><i>⌄</i></summary><div class="rebuild-fold-content"><p id="rebuild-feeling-detail">正在统计摘要构成…</p><button class="ghost" id="open-feelings">前往记忆档案查看摘要</button></div></details><details class="rebuild-fold" open><summary><span><strong>原文</strong><small>查看并裁剪即将保留的近期对话与工具链</small></span><i>⌄</i></summary><div class="rebuild-fold-content"><button class="secondary" id="open-trim">裁剪对话 / 工具链</button></div></details></section>`;
  document.querySelector("#back-maintenance").onclick=()=>renderMaintenance(library);
  try {
    const [config,rules,daily,coarse,retained]=await Promise.all([
      api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`),
      api(`/api/libraries/${encodeURIComponent(library.threadId)}/rules`),
      api(`/api/libraries/${encodeURIComponent(library.threadId)}/feelings?page=1&mode=daily`),
      api(`/api/libraries/${encodeURIComponent(library.threadId)}/feelings?page=1&mode=coarse`),
      api(`/api/libraries/${encodeURIComponent(library.threadId)}/feelings?page=1&retainAnchor=1`),
    ]);
    rebuildState.windowDays=config.windowDays;rebuildState.toolPairs=config.keepToolPairs;
    document.querySelector("#window-days").value=rebuildState.windowDays;document.querySelector("#tool-pairs").value=rebuildState.toolPairs;
    const injected=rules.rows.filter(row=>row.injected);
    document.querySelector("#rebuild-rule-summary").textContent=injected.length?`将注入 ${injected.length} 份：${injected.map(row=>row.name).join("、")}`:"当前没有启用的人设 / 规则";
    document.querySelector("#rebuild-rules").innerHTML=`${rules.rows.length?rules.rows.map(row=>`<div class="rebuild-rule-row"><span><strong>${escapeHtml(row.name)}</strong><small>${row.injected?"重建时注入":"当前不注入"}</small></span><span class="badge">${row.injected?"已启用":"已停用"}</span></div>`).join(""):'<div class="empty">还没有规则文档。</div>'}<button class="ghost" id="open-rules">前往记忆档案修改人设 / 规则</button>`;
    const injectedTotal=daily.rows.total+coarse.rows.total;
    document.querySelector("#rebuild-feeling-summary").textContent=`保留 ${injectedTotal} 条摘要`;
    document.querySelector("#rebuild-feeling-detail").textContent=`保留了 ${injectedTotal} 条摘要，其中 ${daily.rows.total} 条全量 daily 摘要、${coarse.rows.total} 条精简 coarse 摘要、${retained.rows.total} 条摘要以原文形式存储（原文行数将在重建预览后显示）。`;
    document.querySelector("#open-rules").onclick=()=>renderMemorySection(library,"rules");
  } catch(error){showToast(error.message,"error");}
  document.querySelector("#window-days").onchange=event=>{rebuildState.windowDays=Math.max(1,Number(event.target.value)||3);};
  document.querySelector("#tool-pairs").onchange=event=>{rebuildState.toolPairs=Math.max(0,Number(event.target.value)||0);};
  const syncWatermarkControls=()=>{
    const windowInput=document.querySelector("#window-days");
    windowInput.disabled=rebuildState.watermark;
    windowInput.closest(".field")?.classList.toggle("is-disabled",rebuildState.watermark);
  };
  document.querySelector("#watermark-mode").onchange=event=>{rebuildState.watermark=event.target.checked;syncWatermarkControls();};
  syncWatermarkControls();
  document.querySelector("#preview-rebuild").onclick = () => previewIntegratedRebuild(library);
  document.querySelector("#check-thread").onclick = () => checkAndRepair(library);
  document.querySelector("#open-trim").onclick = () => renderTrimWorkbench(library);
  document.querySelector("#open-feelings").onclick=()=>renderMemorySection(library,"feelings");
  await showIntegrity(library, false);
}

async function renderTrimWorkbench(library) {
  const main = document.querySelector("#workspace-main");
  main.innerHTML = `<div class="dashboard-head"><div><p class="eyebrow">永久裁剪</p><h1>选择保留的对话</h1><p class="lead">展示线程最后 n 个实际发生过对话的日期；没有聊天的空白日期不占名额。默认全部保留，取消勾选的内容会永久消失。</p></div><button class="ghost" id="back-rebuild">返回</button></div><section class="section-card"><div class="tab-row"><button data-tab="messages" class="active">末段对话</button><button data-tab="tools">工具链</button></div><div id="selection-list"><div class="empty">正在读取活动线程…</div></div><div class="integrity warning">取消勾选的内容会从活动线程、archive 和既有 full 重建源中永久删除，无法恢复。已有摘要不会自动修改；如需移除摘要，请在记忆页将其设为 hidden。</div><div class="rebuild-footer"><div id="selection-summary"></div><div class="actions"><button class="primary" id="preview-trim">预览裁剪并重建</button></div></div><div id="trim-dry-run"></div></section>`;
  document.querySelector("#back-rebuild").onclick = () => renderRebuild(library);
  document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => { rebuildState.tab = button.dataset.tab; document.querySelectorAll("[data-tab]").forEach(item => item.classList.toggle("active", item === button)); renderRebuildRows(library); });
  document.querySelector("#preview-trim").onclick = () => previewIntegratedRebuild(library,{target:"#trim-dry-run",button:"#preview-trim",excludedMessages:[...rebuildState.excludedMessages],excludedTools:[...rebuildState.excludedTools]});
  await loadRebuildPreview(library);
}

async function previewIntegratedRebuild(library,options={}) {
  const windowInput=document.querySelector("#window-days"),toolInput=document.querySelector("#tool-pairs");
  if(windowInput)rebuildState.windowDays=Math.max(1,Number(windowInput.value)||3);
  if(toolInput)rebuildState.toolPairs=Math.max(0,Number(toolInput.value)||0);
  const button=document.querySelector(options.button||"#preview-rebuild"),target=document.querySelector(options.target||"#rebuild-dry-run");
  button.disabled=true;target.innerHTML='<div class="empty">正在生成线程重建预览…</div>';
  try {
    const hasTrim=(options.excludedMessages?.length||options.excludedTools?.length),preview=hasTrim
      ?await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rebuild/dry-run`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({windowDays:rebuildState.windowDays,toolPairs:rebuildState.toolPairs,watermark:rebuildState.watermark,excludedMessages:options.excludedMessages||[],excludedTools:options.excludedTools||[]})})
      :await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rebuild/dry-run?windowDays=${rebuildState.windowDays}&toolPairs=${rebuildState.toolPairs}&watermark=${rebuildState.watermark}`),show=value=>value===null||value===undefined?"—":value;
    const retentionLabel=preview.retentionMode==="watermark"?`水位线模式，自 ${escapeHtml(preview.watermarkCutoff||"—")} 起`:preview.watermarkFallback?`活跃日模式（水位线定位失败，已回退）`:`活跃日模式`;
    target.innerHTML=`<div class="rebuild-preview"><div class="section-title-row"><div><p class="eyebrow">正式 Dry-run</p><h3>确认线程重建结果</h3></div><span class="badge">${preview.runtime==="codex"?"Codex":"Claude"}</span></div><div class="rebuild-preview-groups"><section><h4>数据来源</h4><dl><div><dt>full 原始消息</dt><dd>${show(preview.fullMessages??preview.originalMessages)} 条</dd></div><div><dt>full 总体积</dt><dd>${formatBytes(preview.fullArchiveBytes)}</dd></div><div><dt>保留方式</dt><dd>${retentionLabel}</dd></div><div><dt>活跃日设置</dt><dd>${show(preview.windowDays)} 天（普通模式或水位线回退时使用）</dd></div></dl></section><section><h4>摘要去向</h4><dl><div><dt>摘要总数</dt><dd>${show(preview.injectableFeelings)} 条（hidden 已排除）</dd></div><div><dt>近期窗口内</dt><dd>${show(preview.inWindowFeelings)} 条，由近期原文承载</dd></div><div><dt>原文锚点替代</dt><dd>${show(preview.retainAnchors)} 条，覆盖 ${show(preview.retainDates)} 个日期</dd></div><div><dt>注入记忆块</dt><dd>${show(preview.memoryFeelings)} 条摘要</dd></div><div><dt>人设 / 规则</dt><dd>${show(preview.injectedRules)} 份</dd></div><div><dt>记忆块</dt><dd>${show(preview.memoryBlocks)} 个</dd></div></dl></section><section><h4>近期上下文</h4><dl><div><dt>近期原文</dt><dd>${show(preview.windowMessages)} 条</dd></div><div><dt>工具链</dt><dd>${show(preview.toolPairs)} 组${preview.toolIds==null?"":`，${preview.toolIds} 个工具 ID`}</dd></div>${preview.functionCalls==null?"":`<div><dt>函数调用</dt><dd>${preview.functionCalls} 条</dd></div>`}<div><dt>移除系统记录</dt><dd>${show(preview.systemDropped)} 条</dd></div></dl></section><section class="rebuild-result-group"><h4>预计结果</h4><dl><div><dt>线程文件大小</dt><dd>${formatBytes(preview.estimatedOutputBytes)}</dd></div><div><dt>重建后行数</dt><dd>${show(preview.outputLines)} 行</dd></div><div><dt>预计压缩率</dt><dd class="rebuild-reduction">${preview.reductionPercent==null?"—":`${preview.reductionPercent}%`}</dd></div></dl></section></div><details class="rebuild-raw-output"><summary>查看原始 dry-run 输出</summary><pre>${escapeHtml(preview.raw)}</pre></details><div class="wizard-actions"><button class="ghost" id="cancel-rebuild-preview">取消</button><button class="primary" id="apply-previewed-rebuild">确认应用线程重建</button></div></div>`;
    target.querySelector("#cancel-rebuild-preview").onclick=()=>target.innerHTML="";
    target.querySelector("#apply-previewed-rebuild").onclick=()=>applyIntegratedRebuild(library,{excludedMessages:options.excludedMessages||[],excludedTools:options.excludedTools||[]});
    const feelingDetail=document.querySelector("#rebuild-feeling-detail");
    if(feelingDetail&&preview.retainAnchors!=null)feelingDetail.textContent=feelingDetail.textContent.replace(/（原文行数.*?）/u,`（共占 ${show(preview.retainedMessages)} 行）`);
  }catch(error){target.innerHTML=`<div class="integrity warning">${escapeHtml(error.message)}</div>`;}
  button.disabled=false;
}

async function applyIntegratedRebuild(library,{excludedMessages=[],excludedTools=[]}={}) {
  const button=document.querySelector("#apply-previewed-rebuild");button.disabled=true;button.textContent="正在应用线程重建…";
  try{
    await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rebuild/apply`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({windowDays:rebuildState.windowDays,toolPairs:rebuildState.toolPairs,watermark:rebuildState.watermark,excludedMessages,excludedTools})});
    showToast(excludedMessages.length||excludedTools.length?"已永久裁剪所选内容并完成重建":"线程重建完成");await renderRebuild(library);
  }catch(error){showToast(error.message,"error");button.disabled=false;button.textContent="确认应用线程重建";}
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
    ? `<label class="select-row"><input type="checkbox" data-kind="message" data-id="${row.id}" ${rebuildState.excludedMessages.has(row.id) ? "" : "checked"}><time>${escapeHtml(formatBeijingTime(row.timestamp))}</time><span class="role">${escapeHtml(row.role)}</span><span class="context">${escapeHtml(row.context)}</span></label>`
    : `<label class="select-row tool-row"><input type="checkbox" data-kind="tool" data-id="${row.id}" ${rebuildState.excludedTools.has(row.id) ? "" : "checked"}><time>${escapeHtml(formatBeijingTime(row.timestamp))}</time><span class="role">${escapeHtml(row.name)}</span><span class="context">${escapeHtml(row.context)}${row.output ? `\n→ ${escapeHtml(row.output)}` : ""}</span></label>`).join("") : `<div class="empty">这个范围内没有${rebuildState.tab === "messages" ? "对话" : "完整工具链"}。</div>`;
  target.querySelectorAll("input[type=checkbox]").forEach(input => input.onchange = () => {
    const set = input.dataset.kind === "message" ? rebuildState.excludedMessages : rebuildState.excludedTools;
    input.checked ? set.delete(input.dataset.id) : set.add(input.dataset.id); updateSelectionSummary();
  });
  target.insertAdjacentHTML("beforeend", pagination(collection));
  bindPagination(target, collection.page, collection.totalPages, page => changeRebuildPage(library, page));
  updateSelectionSummary();
}

function changeRebuildPage(library, page) { if (rebuildState.tab === "messages") rebuildState.page = page; else rebuildState.toolPage = page; loadRebuildPreview(library); }
function updateSelectionSummary() {
  const el = document.querySelector("#selection-summary"); if (!el) return;
  const preview = rebuildState.preview;
  const range = preview?.cutoff && preview?.referenceDate ? `${preview.cutoff} 至 ${preview.referenceDate} · ` : "";
  el.textContent = `${range}已排除 ${rebuildState.excludedMessages.size} 条对话、${rebuildState.excludedTools.size} 组工具链`;
}

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

loadLibraries().then(() => state.libraries.length ? lobby() : welcome()).catch(error => { app.innerHTML = `<section class="welcome"><div class="welcome-content"><h1>Stone Memory</h1><p class="lead">本地服务暂时无法读取记忆体。</p><button class="primary" onclick="location.reload()">重新加载</button></div></section>`; showToast(error.message, "error"); });
