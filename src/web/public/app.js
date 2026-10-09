const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

const state = {
  libraries: [], step: 1, imports: [], memoryId: null,
  form: { libraryName: "", threadId: "", ai: "", user: "", userGender: "unspecified", runtime: "codex", scenario: "life-supervision", sessionDir: "", minerMode: "subagent", apiProvider: "", apiKey: "", baseUrl: "", model: "", windowDays: 1, keepToolPairs: 15, automaticFullMining: true, automaticMemoryMaintenance: true, automaticCompression: false },
  feelingBatch: { active:false, memoryId:null, pending:new Map() },
};
const promptedLegacyUpgrades = new Set();

// 正式发布前在这里补齐公共账号；空值会显示为“待配置”，不会跳往错误地址。
const projectContact = {
  github: "https://github.com/wanyu445/stone_memory",
  website: "",
  xiaohongshu: "",
  qqGroup: "",
  email: "",
  supportImage: "/assets/support-code.jpg",
};

let deferredPwaInstall = null;
const DESKTOP_ICON_STORAGE_KEY = "stone-memory-desktop-icon-v1";
const DEFAULT_DESKTOP_ICON = "/app-logo.jpg";

function isPwaStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function currentDesktopIcon() {
  try {
    const source=localStorage.getItem(DESKTOP_ICON_STORAGE_KEY)||"";
    if(/^data:image\/(?:png|webp);base64,/i.test(source)||source==="/stone-memory-logo.png"||/^\/brand-icons\/[a-z0-9-]+\.png$/.test(source))return source;
  } catch {}
  return DEFAULT_DESKTOP_ICON;
}

function loadPwaImage(source) {
  return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=source;});
}

async function squarePwaIcon(source,size) {
  const image=await loadPwaImage(source),canvas=document.createElement("canvas"),context=canvas.getContext("2d");
  canvas.width=size;canvas.height=size;
  const background=getComputedStyle(document.documentElement).getPropertyValue("--stone-theme-canvas").trim();
  context.fillStyle=/^(#|rgb|hsl)/i.test(background)?background:"#f4f1e8";context.fillRect(0,0,size,size);
  const scale=Math.min(size*.82/image.naturalWidth,size*.82/image.naturalHeight),width=image.naturalWidth*scale,height=image.naturalHeight*scale;
  context.drawImage(image,(size-width)/2,(size-height)/2,width,height);
  return new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
}

async function syncPwaIcons() {
  if (!("caches" in window)) return;
  const cache=await caches.open("stone-memory-pwa-v3"),source=currentDesktopIcon();
  let desktopIcon="";
  for (const size of [192,512]) {
    const blob=await squarePwaIcon(source,size);
    if (blob) {
      await cache.put(`/pwa-icon-${size}.png`,new Response(blob,{headers:{"content-type":"image/png"}}));
      if(size===192)desktopIcon=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||""));reader.onerror=()=>resolve("");reader.readAsDataURL(blob);});
    }
  }
  if(desktopIcon){
    document.querySelectorAll('link[rel="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]').forEach(link=>{link.href=desktopIcon;});
  }
}

let pwaInstallPending = false;
let pwaInstalled = false;

function pwaInstallHelp() {
  if (!window.isSecureContext) return "当前地址使用非安全连接，请通过 HTTPS 地址访问后安装；普通 HTTP 域名和 Tailscale HTTP IP 不支持应用内安装。";
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "请在 Safari 中点击分享按钮，再选择“添加到主屏幕”。";
  return "浏览器暂未提供安装提示（可能尚未就绪、已安装或此前取消过）。请从浏览器菜单选择“安装应用”或“添加到主屏幕”；也可稍后再次尝试。";
}

async function installStoneMemory() {
  if (pwaInstallPending || pwaInstalled || isPwaStandalone()) return;
  if (!window.isSecureContext || !deferredPwaInstall) {
    showToast(pwaInstallHelp());
    refreshPwaInstallUi();
    return;
  }
  const event = deferredPwaInstall;
  deferredPwaInstall = null;
  pwaInstallPending = true;
  try {
    // Invoke before any await: browsers require the original click activation.
    const prompting = event.prompt();
    refreshPwaInstallUi();
    await prompting;
    const choice = await event.userChoice;
    if (choice.outcome === "accepted") {
      deferredPwaInstall = null;
      showToast("已确认安装，请等待浏览器完成。");
    } else {
      // Do not permanently discard the entry point after a dismissal. Some
      // browsers allow another user-activated prompt; others reject the reuse,
      // in which case the next click falls back to the browser's install menu.
      deferredPwaInstall = event;
      showToast("已取消安装；可以再次点击重试，也可以从浏览器菜单选择“安装应用”。");
    }
  } catch {
    showToast("未能打开系统安装提示。请从浏览器菜单选择“安装应用”或“添加到主屏幕”。", "error");
  } finally {
    pwaInstallPending = false;
    refreshPwaInstallUi();
  }
}

function refreshPwaInstallUi() {
  const button=document.querySelector("#install-stone-memory"),hint=document.querySelector("#pwa-install-hint");
  if(!button)return;
  const label=button.querySelector?.("strong")||button;
  if(pwaInstalled || isPwaStandalone()){button.disabled=true;label.textContent="已添加到桌面";if(hint)hint.textContent="Stone Memory 已安装为桌面应用。";return;}
  if(pwaInstallPending){button.disabled=true;label.textContent="等待安装确认…";return;}
  button.disabled=false;label.textContent="添加到桌面主页";
  if(hint)hint.textContent=window.isSecureContext && deferredPwaInstall?"当前网站可安装，点击后弹出系统安装确认。":pwaInstallHelp();
}

window.addEventListener("beforeinstallprompt",event=>{event.preventDefault();deferredPwaInstall=event;refreshPwaInstallUi();});
window.addEventListener("appinstalled",()=>{deferredPwaInstall=null;pwaInstalled=true;refreshPwaInstallUi();showToast("Stone Memory 已添加到桌面");});

async function preparePwa() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/service-worker.js");
    await navigator.serviceWorker.ready;
    await syncPwaIcons();
    if(!document.querySelector('link[rel="manifest"]')){const link=document.createElement("link");link.rel="manifest";link.href="/manifest.webmanifest";document.head.append(link);}
  } catch {}
}

function resetCreateForm(memory = null) {
  state.step = 1; state.imports = [];
  state.memoryId = memory?.memoryId || null;
  state.form = { libraryName: memory?.libraryName || memory?.label || "", threadId: "", ai: "", user: "", userGender: "unspecified", runtime: "codex", scenario: "life-supervision", sessionDir: "", minerMode: "subagent", apiProvider: "", apiKey: "", baseUrl: "", model: "", windowDays: 1, keepToolPairs: 15, automaticFullMining: true, automaticMemoryMaintenance: true, automaticCompression: false };
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
function formatBeijingClock(value) {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
function formatChineseDate(value) { const parts=String(value||"").split("-").map(Number);return parts.length===3&&parts.every(Number.isFinite)?`${parts[1]}月${parts[2]}日`:String(value||""); }
function formatContextUsage(usage) { if(!usage)return "暂无数据"; return usage.maxTokens?`${formatTokens(usage.usedTokens)} / ${formatTokens(usage.maxTokens)} tokens`:`${formatTokens(usage.usedTokens)} tokens`; }
function contextUsageHint(usage,automaticFullMining){if(!usage)return automaticFullMining?"等待线程产生下一条模型 usage":"开启自动录入全量对话后实时统计";const size=formatContextUsage(usage);return usage.percent==null?`已用 ${size} · 可在设置中填写窗口上限`:`${usage.percent.toFixed(1)}% · 已用 ${size}`;}
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
  const request = { ...options };
  if (!request.method || String(request.method).toUpperCase() === "GET") request.cache = "no-store";
  const response = await fetch(url, request);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith("/api/auth/")) renderWebLogin();
    const error = new Error(data.error || "请求失败");
    error.status = response.status;
    throw error;
  }
  return data;
}

function renderWebLogin(message = "", bootstrapPending = false) {
  document.body.classList.add("web-auth-locked");
  app.innerHTML = `<section class="web-auth-page"><form class="web-auth-card" id="web-auth-form">
    <div class="web-auth-mark" aria-hidden="true">石</div>
    <p class="eyebrow">LOCAL NETWORK ACCESS</p>
    <h1>连接 Stone Memory</h1>
    <p>这台设备已开启 Web 访问保护。请输入服务器生成的 Web API Token。</p>
    <label for="web-auth-token">访问令牌</label>
    <input id="web-auth-token" name="token" type="password" autocomplete="current-password" placeholder="stmem_…" required autofocus>
    <small>令牌只用于首次验证，不会保存在浏览器存储中；成功后会记住这台设备 30 天。</small>
    ${bootstrapPending ? '<p class="notice warning">这是从旧版远程访问自动升级的首次登录。请在服务器终端运行 <code>stmem web auth claim</code> 领取一次性 Token。</p>' : ""}
    <div class="notice danger" id="web-auth-error" ${message ? "" : "hidden"}>${escapeHtml(message)}</div>
    <button class="primary" type="submit">登录</button>
  </form></section>`;
  const form = document.querySelector("#web-auth-form");
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector("button"), error = form.querySelector("#web-auth-error");
    button.disabled = true; button.textContent = "正在验证…"; error.hidden = true;
    try {
      await api("/api/auth/unlock", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ token:new FormData(form).get("token") }) });
      form.reset(); document.body.classList.remove("web-auth-locked"); await startStoneMemory();
    } catch (cause) {
      error.textContent = cause.message; error.hidden = false;
      button.disabled = false; button.textContent = "登录";
      form.querySelector("input").focus();
    }
  };
}

async function startStoneMemory() {
  await loadLibraries();
  document.body.classList.remove("web-auth-locked");
  if (!state.libraries.length) return welcome();
  const route = new URLSearchParams(window.location.search), threadId = route.get("threadId");
  if (route.get("view") === "workshop") return renderGlobalWorkshop();
  if (route.get("view") === "developer" && state.libraries.some(library => library.threadId === threadId)) return openLibrary(threadId, "developer");
  lobby();
}

async function bootstrapStoneMemory() {
  const status = await api("/api/auth/status");
  if (!status.authenticationRequired) return startStoneMemory();
  try { return await startStoneMemory(); }
  catch (error) {
    if (error.status === 401 || error.status === 503) return renderWebLogin("", status.bootstrapPending);
    throw error;
  }
}

async function loadLibraries() {
  const data = await api("/api/libraries"); state.libraries = data.libraries;
}

const optionalScripts = new Map();
function loadOptionalScript(src) {
  if (optionalScripts.has(src)) return optionalScripts.get(src);
  const promise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-optional-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") resolve();
      else {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
      }
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.defer = true;
    script.dataset.optionalSrc = src;
    script.onload = () => { script.dataset.loaded = "true"; resolve(); };
    script.onerror = () => reject(new Error(`开发者模块加载失败：${src}`));
    document.head.append(script);
  });
  optionalScripts.set(src, promise);
  return promise;
}

function loadDeveloperModules() {
  return loadOptionalScript("/developer-kit/bootstrap.js?v=14").catch(error => showToast(error.message, "error"));
}

function openGlobalWorkshopPanel(panel = "plugins") {
  document.querySelectorAll("[data-workshop-panel]").forEach(section => {
    section.hidden = section.dataset.workshopPanel !== panel;
  });
  document.querySelectorAll("[data-workshop-tab]").forEach(button => {
    const active = button.dataset.workshopTab === panel;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

function rememberWorkshopMemory(identifier) {
  const memoryId = String(identifier || "").trim();
  if (!memoryId) return;
  try {
    sessionStorage.setItem("stone-memory-shell-last-memory", memoryId);
    sessionStorage.setItem("stone-memory-developer-thread", memoryId);
  } catch {}
}

function renderGlobalWorkshop(panel = "plugins", preferredMemoryId = "") {
  let rememberedMemoryId = "";
  try { rememberedMemoryId = sessionStorage.getItem("stone-memory-shell-last-memory") || ""; } catch {}
  const workspaceMemoryId = document.querySelector(".workspace")?.dataset.threadId || "";
  const route = new URLSearchParams(location.search);
  const requestedMemoryId = route.get("memoryId") || route.get("threadId") || "";
  const activeMemoryId = [preferredMemoryId, workspaceMemoryId, requestedMemoryId, rememberedMemoryId]
    .find(identifier => state.libraries.some(library => (library.memoryId || library.threadId) === identifier)) || "";
  app.innerHTML = `<section class="global-workshop"><main class="shell global-workshop-main"><div class="dashboard-head"><div><p class="eyebrow">Stone Memory Workshop</p><h1>琢石坊</h1><p class="lead">先使用已经装好的能力，再逛协作社区，或者开始制作自己的模块。</p></div></div><nav class="workshop-tabs" aria-label="琢石坊导航" role="tablist"><button type="button" data-workshop-tab="plugins" role="tab">插件工坊</button><button type="button" data-workshop-tab="community" role="tab">琢石坊</button><button type="button" data-workshop-tab="maker" role="tab">制作台</button></nav><section class="workshop-panel" data-workshop-panel="plugins"><div class="workshop-panel-head"><div><h2>插件工坊</h2><p>查看笔记、织梦与其他已安装模块。需要记忆体的能力会在进入后请你明确选择。</p></div></div><div id="developer-module-host" class="developer-module-host" data-module-section="plugins" aria-live="polite"></div></section><section class="workshop-panel" data-workshop-panel="community" hidden><div class="developer-module-host" data-module-section="community" aria-live="polite"></div></section><section class="workshop-panel" data-workshop-panel="maker" hidden><div data-developer-kit-host></div></section></main></section>`;
  document.querySelectorAll("[data-workshop-tab]").forEach(button => {
    button.onclick = () => openGlobalWorkshopPanel(button.dataset.workshopTab);
  });
  const moduleHost = document.querySelector("#developer-module-host");
  if (moduleHost && state.libraries.length) {
    const picker = document.createElement("div");
    picker.className = "workshop-memory-picker";
    picker.innerHTML = `<span>当前记忆体：</span><select aria-label="选择插件使用的记忆体"><option value="">请选择记忆体</option>${state.libraries.map(library => {
      const id = library.memoryId || library.threadId;
      return `<option value="${escapeHtml(id)}" ${id === activeMemoryId ? "selected" : ""}>${escapeHtml(library.libraryName || library.label || id)}</option>`;
    }).join("")}</select>`;
    moduleHost.dataset.memoryId = activeMemoryId;
    picker.querySelector("select").onchange = event => {
      const memoryId = event.currentTarget.value;
      moduleHost.dataset.memoryId = memoryId;
      rememberWorkshopMemory(memoryId);
      const next = new URL(location.href);
      next.searchParams.set("view", "workshop");
      if (memoryId) next.searchParams.set("threadId", memoryId);
      else next.searchParams.delete("threadId");
      history.replaceState(null, "", next);
    };
    moduleHost.before(picker);
  }
  rememberWorkshopMemory(activeMemoryId);
  openGlobalWorkshopPanel(panel);
  loadDeveloperModules();
}

function welcome() {
  app.innerHTML = `<section class="welcome"><div class="welcome-content">${stoneSvg()}<h1>Stone Memory</h1><p class="cn-title">磐石记忆</p><blockquote>“蒲苇韧如丝，磐石无转移”</blockquote><button class="primary" id="create">点击创建</button></div></section>`;
  document.querySelector("#create").onclick = event => createMemoryDraft(event.currentTarget);
}

function createMemoryDraft(button, memory = null) {
  const upgrading=memory?.upgradeRequired===true;
  const overlay=document.createElement("div");overlay.className="editor-overlay create-memory-overlay";
  overlay.innerHTML=`<form class="editor-panel create-memory-dialog"><button class="ghost editor-close" type="button" aria-label="关闭">关闭</button><p class="eyebrow">${upgrading?"MEMORY UPGRADE":"NEW MEMORY"}</p><h2>${upgrading?"升级旧版记忆体":memory?"完成记忆体设置":"创建记忆体"}</h2><p class="lead">${upgrading?"确认新版记忆体信息。历史数据会保留，旧目录不会删除。":"先建立记忆本身。对话绑定、历史导入与自动化可以进入记忆体后再设置。"}</p><div class="field-grid"><div class="field full"><label for="quick-memory-name">记忆体名字</label><input id="quick-memory-name" name="libraryName" value="${escapeHtml(memory?.libraryName||"")}" required autofocus></div><div class="field"><label for="quick-ai-name">AI 名字</label><input id="quick-ai-name" name="ai" value="${escapeHtml(memory?.ai||"")}" required></div><div class="field"><label for="quick-user-name">用户名字</label><input id="quick-user-name" name="user" value="${escapeHtml(memory?.user||"")}" required></div><div class="field full"><label for="quick-purpose">挖掘场景</label><select id="quick-purpose" name="scenario"><option value="life-supervision">生活监督</option><option value="accompany">情感陪伴</option><option value="coding">编程日志</option></select><small>决定今后生成摘要和特征时关注什么。</small></div></div><div class="wizard-actions">${memory&&!upgrading?'<button class="danger-button" id="delete-draft-memory" type="button">删除这个空记忆体</button>':'<span></span>'}<button class="primary" type="submit">${upgrading?"确认升级":"创建并进入"}</button></div></form>`;
  document.body.append(overlay);
  if(upgrading){const notice=document.createElement("p");notice.className="notice warning";notice.textContent="旧版 tmp/prompt_*.txt 是可清理的临时文件，升级不会复制；旧目录仍会保留，请按需清理以释放空间。";overlay.querySelector(".lead")?.after(notice);}
  const close=()=>{overlay.remove();if(button){button.disabled=false;}};
  overlay.querySelector(".editor-close").onclick=close;
  overlay.onclick=event=>{if(event.target===overlay)close();};
  overlay.querySelector("#delete-draft-memory")?.addEventListener("click",async event=>{
    if(!window.confirm("确认要删除吗？删除后无法恢复"))return;
    event.currentTarget.disabled=true;
    try{await api(`/api/libraries/${encodeURIComponent(memory.memoryId)}`,{method:"DELETE"});close();await loadLibraries();state.libraries.length?lobby():welcome();showToast("空记忆体已删除");}
    catch(error){showToast(error.message,"error");event.currentTarget.disabled=false;}
  });
  overlay.querySelector("form").onsubmit=async event=>{
    event.preventDefault();const submit=event.currentTarget.querySelector('button[type="submit"]'),values=Object.fromEntries(new FormData(event.currentTarget).entries());
    submit.disabled=true;submit.textContent=upgrading?"正在升级…":"正在创建…";
    try{
      const endpoint=upgrading?`/api/memories/${encodeURIComponent(memory.memoryId)}/layout-upgrade`:"/api/libraries";
      let result;
      if(upgrading){
        showLayoutUpgradeProgress(overlay,{stage:"正在启动升级",step:0,total:6});
        const started=await api(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(values)});
        if(started.jobId){
          let job;
          do{
            await new Promise(resolve=>setTimeout(resolve,700));
            const response=await api(`/api/memories/${encodeURIComponent(memory.memoryId)}/layout-upgrade/jobs/${encodeURIComponent(started.jobId)}`);
            job=response.job;showLayoutUpgradeProgress(overlay,job);
          }while(job.status==="running");
          if(job.status==="failed")throw new Error(job.error||"升级失败，请检查后重试");
          result=job.result;
        }else result=started;
      }else result=await api(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...values,...(memory?{memoryId:memory.memoryId}:{})})});
      overlay.remove();await loadLibraries();
      if(upgrading)await showLayoutUpgradeCompletion(result);
      else showToast(`“${result.library.libraryName}”已经创建`);
      await openLibrary(result.library.memoryId);
    }catch(error){
      if(upgrading&&overlay.isConnected&&overlay.querySelector(".layout-upgrade-progress"))showLayoutUpgradeFailure(overlay,error.message);
      else{showToast(error.message,"error");submit.disabled=false;submit.textContent=upgrading?"确认升级":"创建并进入";}
    }
  };
  overlay.querySelector("#quick-purpose").value=memory?.scenario||memory?.purpose||"life-supervision";
  requestAnimationFrame(()=>overlay.querySelector("#quick-memory-name")?.focus());
}

function showLayoutUpgradeProgress(overlay,job){
  overlay.onclick=()=>{};
  if(!overlay.querySelector(".layout-upgrade-progress"))overlay.innerHTML=`<section class="editor-panel layout-upgrade-progress" role="status" aria-live="polite"><p class="eyebrow">MEMORY UPGRADE IN PROGRESS</p><h2>正在升级记忆体</h2><p class="lead">升级期间请保持页面打开。只有全部必要步骤结束后才会显示完成。</p><div class="layout-upgrade-progress-track" aria-hidden="true"><i></i></div><div class="layout-upgrade-stage"><strong></strong><span></span></div><p class="layout-upgrade-detail"></p></section>`;
  overlay.querySelector(".layout-upgrade-stage strong").textContent=job.stage||"准备升级";
  overlay.querySelector(".layout-upgrade-stage span").textContent=`阶段 ${Math.min(Number(job.step)||0,Number(job.total)||6)} / ${Number(job.total)||6}`;
  overlay.querySelector(".layout-upgrade-detail").textContent=job.detail||"正在处理，请稍候…";
}

function showLayoutUpgradeFailure(overlay,message){
  overlay.innerHTML=`<section class="editor-panel layout-upgrade-progress" role="alert"><p class="eyebrow">MEMORY UPGRADE NEEDS ATTENTION</p><h2>升级未完成</h2><p class="lead">没有显示成功。原始旧目录仍会保留；请先检查下面的错误，再决定是否重试。</p><div class="integrity warning">${escapeHtml(message)}</div><div class="wizard-actions"><button class="primary" type="button">关闭</button></div></section>`;
  overlay.querySelector("button").onclick=()=>{overlay.remove();loadLibraries().then(()=>state.libraries.length?lobby():welcome());};
}

function showLayoutUpgradeCompletion(result) {
  return new Promise(resolve=>{
    const overlay=document.createElement("div");overlay.className="editor-overlay layout-upgrade-completion-overlay";
    const recovering=result.backgroundRecovery===true||result.bindingRequired===true||!!result.bindingWarning;
    overlay.innerHTML=`<section class="editor-panel" role="dialog" aria-modal="true" aria-labelledby="layout-upgrade-completion-title"><div class="rebuild-completion-mark" aria-hidden="true">${recovering?"…":"✓"}</div><p class="eyebrow">${recovering?"UPGRADE NEEDS ATTENTION":"MEMORY UPGRADE COMPLETE"}</p><h2 id="layout-upgrade-completion-title">${recovering?"数据目录已升级，接入需要检查":"记忆体升级完成"}</h2><p class="lead">“${escapeHtml(result.library.libraryName)}”的目录迁移已完成。${recovering?"但对话窗口接入或同步尚未全部完成，不能视为整个升级流程已全部就绪。":"记忆、原始对话、rules、窗口接入和同步均已完成。"}</p><div class="integrity ${recovering?"warning":"success"}">${recovering?escapeHtml(result.bindingWarning||"请进入接入设置检查旧窗口绑定和同步状态。"):`已同步 ${Number(result.syncedBindings||0)} 个有效叶子窗口，升级流程全部完成。`}</div><p class="notice">线性 fork 只保留最新叶子；存在兄弟分支时保留各叶子 Binding，共同历史按消息指纹去重。</p><p class="notice">原有自动化开关已保留；自动摘要仍按对话日期跨日触发，不会因迁移或 watcher 重启立即补跑。</p><p class="notice warning">旧目录仍然保留。旧版 tmp/prompt_*.txt 属于可清理的临时文件，可删除以释放磁盘空间。</p><div class="wizard-actions"><button class="primary layout-upgrade-completion-close" type="button">${recovering?"检查接入状态":"进入记忆体"}</button></div></section>`;
    const close=()=>{overlay.remove();resolve();};
    overlay.querySelector(".layout-upgrade-completion-close").onclick=close;
    document.body.append(overlay);overlay.querySelector(".layout-upgrade-completion-close").focus();
  });
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
  panel.innerHTML = `<p class="eyebrow">第一步 · 建立记忆</p><h1>给这段记忆起一个名字</h1><p class="lead">记忆体名字用于显示；真实线程 ID 负责连接 Claude 或 Codex 对话。</p>
    <form id="basic-form"><div class="field-grid">
      ${field("libraryName", "记忆体名字", "以后在 Stone Memory 控制台中显示的名字。", "required autocomplete=off", true)}
      ${field("threadId", "对应 Claude / Codex 线程 ID", "填写真实线程 UUID（例如 019f91...），不是记忆体名字，也不是完整文件路径；创建后不可修改。", "required autocomplete=off", true)}
      ${field("ai", "AI 名字", "这段记忆属于哪位 AI。", "required")}
      ${field("user", "用户名字", "AI 在记忆中如何称呼你。", "required")}
      <div class="field"><label for="runtime">对话来源</label><select id="runtime" name="runtime"><option value="codex" ${state.form.runtime === "codex" ? "selected" : ""}>Codex</option><option value="claude" ${state.form.runtime === "claude" ? "selected" : ""}>Claude</option></select><small>用于绑定正确的线程文件格式。</small></div>
      <div class="field"><label for="purpose">挖掘场景</label><select id="purpose" name="scenario"><option value="life-supervision" ${state.form.scenario === "life-supervision" ? "selected" : ""}>生活监督</option><option value="accompany" ${(state.form.scenario || state.form.purpose) === "accompany" ? "selected" : ""}>情感陪伴</option><option value="coding" ${(state.form.scenario || state.form.purpose) === "coding" ? "selected" : ""}>编程日志</option></select><small>决定摘要与特征挖掘提示词。</small></div>
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
    target.innerHTML = state.form.minerMode === "api" ? `<div class="field-grid">${field("apiProvider", "API 厂商", "填写实际使用的服务商名称，不预设。", "required")}${field("model", "模型名", "必须与上游当前提供的模型名完全一致，Stone Memory 不预设。", "required")}${field("apiKey", "API Key", "只保存在本机配置中，不返回给浏览器。", "required type=password")}${field("baseUrl", "Base URL", "DeepSeek 可留空使用官方地址；其他服务必须填写兼容 chat/completions 的地址。", "", true)}</div>` : "";
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
  list.innerHTML = state.imports.map((item, index) => `<article class="import-card" data-index="${index}"><div class="import-head"><div><strong>${escapeHtml(item.filename)}</strong><div class="import-meta">原始记录 ${item.totalRows} 条 · 将导入纯对话 ${item.valid} 条 · 自动过滤 ${(item.invalid || 0) + (item.filtered || 0)} 条${item.filtered ? `（其中内部运输/模板 ${item.filtered} 条）` : ""} · ${item.firstDate || "-"} 至 ${item.lastDate || "-"}</div></div></div>${previewTable(item)}${pagination(item)}</article>`).join("");
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
    <div class="summary-box"><dl><dt>记忆体名字</dt><dd>${escapeHtml(state.form.libraryName)}</dd><dt>真实线程 ID</dt><dd>${escapeHtml(state.form.threadId)}</dd><dt>对话来源</dt><dd>${escapeHtml(state.form.runtime)}</dd><dt>待导入</dt><dd>${state.imports.reduce((sum, item) => sum + item.valid, 0)} 条对话</dd></dl></div>
    <label class="check-card"><input type="checkbox" name="automaticFullMining" ${state.form.automaticFullMining ? "checked" : ""}><span><strong>自动录入全量对话</strong>当前记忆体绑定主线程的对话将实时录入。</span></label>
    <label class="check-card"><input type="checkbox" name="automaticMemoryMaintenance" ${state.form.automaticMemoryMaintenance ? "checked" : ""}><span><strong>自动挖掘当日摘要和特征</strong>在时间戳跨天时自动开启挖掘。</span></label>
    <label class="check-card"><input type="checkbox" name="automaticCompression" ${state.form.automaticCompression ? "checked" : ""}><span><strong>自动压缩摘要（测试功能）</strong>当前仍在测试，建议暂时不要开启。</span></label>
    <div class="wizard-actions"><button class="ghost" id="back">上一步</button><button class="primary" id="finish">创建我的记忆</button></div>`;
  document.querySelector("#back").onclick = () => { syncForm(); state.step = 2; wizard(); };
  document.querySelector("#finish").onclick = createLibrary;
}

async function createLibrary() {
  syncForm(); const button = document.querySelector("#finish"); button.disabled = true; button.textContent = "正在安放记忆…";
  try {
    const result = await api("/api/libraries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...state.form, memoryId: state.memoryId, importTokens: state.imports.map(item => item.token) }) });
    await loadLibraries(); state.imports = []; showToast(`“${result.library.libraryName || result.library.label}”已经开始生长`); openLibrary(result.library.memoryId || result.library.threadId);
  } catch (error) { showToast(error.message, "error"); button.disabled = false; button.textContent = "创建我的记忆"; }
}

function lobby() {
    app.innerHTML = `<section class="lobby stone-page-transition-pending" data-transition-message="正在整理今日纹路…" aria-busy="true"><div class="shell"><div class="lobby-head"><p>—— 蒲苇韧如丝，磐石无转移 ——</p></div><div class="library-grid">${state.libraries.map(library => `<button class="library-card" data-id="${escapeHtml(library.memoryId || library.threadId)}">${stoneSvg("mini-stone")}<h2>${escapeHtml(library.libraryName)}</h2><p>${library.upgradeRequired ? "旧版记忆体 · 点击升级" : !library.configured ? "尚未配置 · 点击继续" : !library.bound ? "尚未绑定对话窗口" : library.lastMinedAt ? "记忆正在生长" : "等待第一次记忆挖掘"}</p><div class="library-stats"><span>${library.counts.feelings} 条摘要</span><span>${library.counts.features} 条特征</span></div></button>`).join("")}<button class="library-card new-card" id="new-library"><div><span>＋</span><strong>创建新的记忆体</strong></div></button></div></div></section>`;
  document.querySelectorAll(".library-card").forEach(card => card.onclick = () => { const library=state.libraries.find(item=>(item.memoryId||item.threadId)===card.dataset.id); library?.upgradeRequired?createMemoryDraft(card,library):library?.configured?openLibrary(card.dataset.id):createMemoryDraft(card,library); });
  document.querySelector("#new-library").onclick = event => createMemoryDraft(event.currentTarget);
  const legacy=state.libraries.find(library=>library.upgradeRequired&&!promptedLegacyUpgrades.has(library.memoryId));
  if(legacy){promptedLegacyUpgrades.add(legacy.memoryId);queueMicrotask(()=>createMemoryDraft(null,legacy));}
}

async function openLibrary(identifier, view = "overview") {
  if (view === "developer") { renderGlobalWorkshop("plugins", identifier); return; }
  try {
    const data = await api(`/api/libraries/${encodeURIComponent(identifier)}/overview`);
    if (!data.configured) { createMemoryDraft(null,data); return; }
    workspace(data);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function workspace(data) {
  rememberWorkshopMemory(data.memoryId || data.threadId);
  const counts = data.counts, rebuild=data.rebuild;
  const automationReady=data.automaticFullMining&&data.automaticMemoryMaintenance;
  const statusText=!data.bound?"尚未绑定对话窗口":data.attention||(!automationReady?"自动挖掘未完全开启":"记忆运行正常");
  const injected={rules:rebuild?.injectedRules||0,messages:(rebuild?.recentMessages||0)+(rebuild?.retainedMessages||0),feelings:rebuild?.injectedFeelings||0,tools:rebuild?.preservedToolPairs||0};
  const usage=data.contextUsage||null;
  const usagePercent=usage&&Number.isFinite(usage.percent)?Math.max(0,Math.min(100,usage.percent)):0;
  const usageTitle=usage?.observedAt?` title="最近一次模型调用 ${escapeHtml(formatBeijingTime(usage.observedAt))}"`:"";
  const automationSwitch=(key,label,checked,test=false)=>`<label class="overview-switch"><span>${label}${test?` <small>测试功能</small>`:""}</span><input type="checkbox" data-automation="${key}" ${checked?"checked":""}><i aria-hidden="true"></i></label>`;
  app.innerHTML = `<section class="workspace" data-thread-id="${escapeHtml(data.threadId)}" data-library-name="${escapeHtml(data.libraryName)}"><div class="shell workspace-grid workspace-stack"><a class="back-link" href="#">← 返回记忆体</a><div class="dashboard-head workspace-memory-card"><div><p class="eyebrow">Stone Memory</p><h1>${escapeHtml(data.libraryName)}<small>· 已生长了 ${data.growthDays||0} 天</small></h1><div class="status-line ${automationReady&&!data.attention?"":"warning"}"><span class="status-dot"></span>${escapeHtml(statusText)}</div></div>${stoneSvg("mini-stone")}</div><nav class="workspace-nav" aria-label="记忆体页面"><button class="active" role="tab" aria-selected="true" data-view="overview"><span>概况</span></button><button role="tab" aria-selected="false" data-view="memory"><span>记忆</span></button><button role="tab" aria-selected="false" data-view="context"><span>上下文管理</span></button><button role="tab" aria-selected="false" data-view="access"><span>接入</span></button><button role="tab" aria-selected="false" data-view="settings"><span>设置</span></button></nav><main id="workspace-main"><section class="overview-dashboard">
    <article class="overview-card overview-stat-card"><div><span>原始对话</span><strong>${counts.messages||0}<small>条</small></strong></div><div><span>原始线程总体积</span><strong>${formatBytes(data.archiveFullBytes)}</strong></div></article>
    <article class="overview-card overview-stat-card"><div><span>人设 / 规则</span><strong>${counts.rules||0}<small>条</small></strong><small class="corner-note">已停用 ${counts.disabledRules||0} 条</small></div><div><span>已生成摘要</span><strong>${counts.feelings||0}<small>条</small></strong><small class="corner-note">原文锚点 ${counts.retainAnchors||0} 条 · 事件锚点 ${counts.eventAnchors||0} 条 · 隐藏摘要 ${counts.hidden||0} 条</small></div></article>
    <article class="overview-card overview-thread-card"><header><h2>当前对话线程信息</h2><button class="text-link" id="overview-access">接入管理 →</button></header><p class="thread-identity">${escapeHtml(data.runtime||"未接入平台")} · ${escapeHtml(data.externalThreadId||"暂未绑定 UUID")}</p><div class="context-usage"><div class="context-usage-head"><h3>当前窗口上下文</h3><small${usageTitle}>${contextUsageHint(usage,data.automaticFullMining)}</small></div><div class="context-usage-track" role="progressbar" aria-label="当前窗口上下文占用" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(usagePercent)}"><i style="width:${usagePercent.toFixed(1)}%"></i></div></div><div class="injection-heading"><h3>当前窗口注入</h3><small>上次重建：${rebuild?.completedAt?escapeHtml(formatBeijingTime(rebuild.completedAt)):"暂无记录"}</small></div><div class="injection-counts"><div><strong>${injected.rules}</strong><span>人设 / 规则</span></div><div><strong>${injected.messages}</strong><span>对话</span></div><div><strong>${injected.feelings}</strong><span>摘要</span></div><div><strong>${injected.tools}</strong><span>工具链</span></div></div><div id="integrity" class="integrity overview-integrity"></div><footer><button class="secondary" id="overview-repair">线程修复</button><button class="primary" id="overview-rebuild">线程重建</button></footer></article>
    <article class="overview-card overview-automation-card"><h2>自动化设置</h2><div class="overview-switches">${automationSwitch("automaticFullMining","对话录入",data.automaticFullMining)}${automationSwitch("automaticMemoryMaintenance","自动生成摘要",data.automaticMemoryMaintenance)}${automationSwitch("automaticCompression","记忆压缩",data.automaticCompression,true)}</div></article>
  </section></main></div></section>`;
  document.querySelector(".back-link").onclick = event => { event.preventDefault(); lobby(); };
  document.querySelector('[data-view="memory"]').onclick = () => renderManagement(data);
  document.querySelector('[data-view="context"]').onclick = () => renderRebuild(data);
  document.querySelector('[data-view="access"]').onclick = () => renderAccess(data);
  document.querySelector('[data-view="settings"]').onclick = () => renderSettings(data);
  document.querySelector('[data-view="overview"]').onclick = () => workspace(data);
  document.querySelector("#overview-access").onclick=()=>renderAccess(data);
  document.querySelector("#overview-rebuild").onclick=()=>renderRebuild(data);
  document.querySelector("#overview-repair").onclick=()=>checkAndRepair(data);
  document.querySelectorAll("[data-automation]").forEach(input=>input.onchange=async()=>{
    input.disabled=true;
    try{
      const result=await api(`/api/libraries/${encodeURIComponent(data.threadId)}/settings`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({[input.dataset.automation]:input.checked})});
      Object.assign(data,result.config);showToast("自动化设置已保存");
    }catch(error){input.checked=!input.checked;showToast(error.message,"error");}
    input.disabled=false;
  });
}

let adapterRegistryTimer=null;

function renderAdapterRegistryState(adapters, errorMessage="") {
  const target=document.querySelector("#adapter-registry-content");
  if(!target)return;
  if(errorMessage){target.innerHTML=`<span class="badge warning">读取失败</span><p>暂时无法读取适配器注册状态。${escapeHtml(errorMessage)}</p>`;return;}
  if(!adapters.length){target.innerHTML=`<span class="badge">未注册</span><p>当前没有检测到已注册的网关适配器。适配器完成注册后，这里会自动更新。</p><button class="secondary" type="button" disabled>配置适配器（未注册）</button>`;return;}
  const enabled=adapters.filter(item=>item.enabled!==false);
  target.innerHTML=`<div class="adapter-registry-list">${adapters.map(item=>`<div class="adapter-registry-item"><span class="badge ${item.enabled===false?"warning":""}">${item.enabled===false?"已停用":"已注册"}</span><div><strong>${escapeHtml(item.title||item.id)}</strong><small>${escapeHtml(item.host||"gateway")}${item.version?` · v${escapeHtml(item.version)}`:""}</small></div></div>`).join("")}</div><p>${enabled.length} 个适配器已注册${enabled.length?"，等待宿主按适配器协议接入当前记忆体。":"。"}</p><button class="secondary" type="button" disabled>配置适配器（接入能力开发中）</button>`;
}

async function refreshAdapterRegistry(){
  try{
    const data=await api("/api/developer-adapters");
    renderAdapterRegistryState(Array.isArray(data.adapters)?data.adapters:[]);
  }catch(error){renderAdapterRegistryState([],error.message||"接口不可用");}
}

async function renderAccess(library) {
  if(adapterRegistryTimer){clearInterval(adapterRegistryTimer);adapterRegistryTimer=null;}
  activateWorkspaceTab("access");
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`<section class="section-card"><div class="empty">正在读取接入信息…</div></section>`;
  try{
    const data=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/bindings`),bindings=data.bindings||[];
    main.innerHTML=`<div class="access-layout"><section class="section-card access-card access-bindings-card"><div class="section-title-row"><div><p class="eyebrow">Bind status</p><h2>接入</h2><small>最多同时监听 5 个窗口；主 Binding 可以停止监听，但更换主 Binding 后才能删除</small></div><button class="primary" id="open-binding-guide" type="button">接入线程</button></div>${bindings.length?bindings.map(binding=>{const primary=binding.id===data.primaryBindingId,readonly=binding.readOnly===true,listening=binding.enabled!==false;return `<article class="access-binding"><div class="access-binding-copy"><strong>${escapeHtml(binding.provider||"未知平台")}</strong><small>${escapeHtml(binding.externalThreadId||"")}${binding.source==="legacy-config"?" · 旧配置接入":""}</small></div><div class="access-binding-actions"><span class="badge">${primary?`主 Binding · ${listening?"监听中":"未监听"}`:listening?"监听中":"未监听"}</span>${readonly?"":`${primary?"":`<button class="ghost" type="button" data-binding-primary="${escapeHtml(binding.id)}">设为主 Binding</button>`}<button class="ghost" type="button" data-binding-toggle="${escapeHtml(binding.id)}" data-enabled="${listening}">${listening?"停止监听":"开始监听"}</button>${primary?`<button class="ghost danger" type="button" disabled title="请先把另一个窗口设为主 Binding">删除此绑定</button>`:`<button class="ghost danger" type="button" data-binding-delete="${escapeHtml(binding.id)}">删除此绑定</button>`}`}</div></article>`;}).join(""):`<div class="empty">Bind status：当前记忆体还没有接入对话窗口。</div>`}</section><section class="section-card access-card access-mcp-card"><div class="section-title-row"><div><p class="eyebrow">MCP plugins</p><h2>MCP</h2><small>记忆体级插件权限；所有接入 Binding 自动继承，重新连接 MCP 后生效</small></div></div><div id="binding-mcp-list" class="binding-mcp-list"><div class="empty">正在读取插件权限…</div></div></section><section class="section-card access-card adapter-access-card"><div class="section-title-row"><div><p class="eyebrow">Agent adapter</p><h2>适配器接入</h2><small>给网关类 Agent 助手预留统一的记忆调用口，适配器接入后可按当前记忆体读取和编排能力。</small></div></div><div class="adapter-access-body" id="adapter-registry-content"><span class="badge">正在检测</span><p>正在读取适配器注册状态…</p></div></section></div>`;
    main.querySelector("#open-binding-guide")?.addEventListener("click",()=>showBindingGuide(library));
    void refreshAdapterRegistry();
    adapterRegistryTimer=setInterval(()=>{if(document.querySelector("#adapter-registry-content"))void refreshAdapterRegistry();},15000);
    const mutate=async(bindingId,options)=>{try{await api(`/api/libraries/${encodeURIComponent(library.threadId)}/bindings/${encodeURIComponent(bindingId)}`,options);showToast("Binding 已更新");await renderAccess(library);}catch(error){showToast(error.message,"error");}};
    main.querySelectorAll("[data-binding-toggle]").forEach(button=>button.onclick=()=>mutate(button.dataset.bindingToggle,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:button.dataset.enabled!=="true",apply:true})}));
    main.querySelectorAll("[data-binding-primary]").forEach(button=>button.onclick=()=>mutate(button.dataset.bindingPrimary,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action:"primary",apply:true})}));
    main.querySelectorAll("[data-binding-delete]").forEach(button=>button.onclick=async()=>{if(!confirm("删除后将不再监听这个窗口。已归档的记忆不会删除，确定继续吗？"))return;await mutate(button.dataset.bindingDelete,{method:"DELETE"});});
    const mcpList=main.querySelector("#binding-mcp-list");
    if(!bindings.length)mcpList.innerHTML=`<div class="empty">接入线程后，才能为该线程开启 MCP 插件。</div>`;
    else{
      const status=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/mcp`);
      mcpList.innerHTML=`<article class="binding-mcp-row"><header><div><strong>${escapeHtml(library.libraryName||library.label||library.threadId)} 记忆体</strong><small>所有接入 Binding 自动继承这里的 MCP 权限</small></div><span class="badge">${(status.modules||[]).filter(item=>item.enabled).length} 个已开启</span></header><div class="binding-mcp-switches">${(status.modules||[]).filter(item=>item.declared).map(module=>`<label class="overview-switch"><span>${escapeHtml(module.title||module.id)}<small>${escapeHtml(module.summary||"允许该记忆体的所有接入线程使用此插件")}</small></span><input type="checkbox" data-mcp-module="${escapeHtml(module.id)}" ${module.enabled?"checked":""}><i></i></label>`).join("")||`<div class="empty">当前没有声明 MCP 能力的插件。</div>`}</div></article>`;
      mcpList.querySelectorAll("[data-mcp-module]").forEach(input=>input.onchange=async()=>{input.disabled=true;try{await api(`/api/libraries/${encodeURIComponent(library.threadId)}/mcp`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({moduleId:input.dataset.mcpModule,enabled:input.checked,apply:true})});showToast("记忆体 MCP 权限已保存，所有 Binding 重新连接后生效");await renderAccess(library);}catch(error){input.checked=!input.checked;input.disabled=false;showToast(error.message,"error");}});
    }
  }catch(error){main.querySelector(".section-card").innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`;}
}

function showBindingGuide(library) {
  document.querySelector("#binding-guide-dialog")?.remove();
  const memoryId=library.memoryId||library.threadId;
  const current=state.libraries.find(item=>(item.memoryId||item.threadId)===memoryId);
  const memoryName=current?.libraryName||current?.label||document.querySelector(".workspace")?.dataset.libraryName||library.libraryName||library.label||memoryId;
  const instruction=`请用bind mcp将该窗口和${memoryName}记忆体绑定`;
  const dialog=document.createElement("dialog");
  dialog.id="binding-guide-dialog";
  dialog.className="binding-guide-dialog";
  dialog.innerHTML=`<button class="dialog-close" type="button" aria-label="关闭">×</button><p class="eyebrow">NEW BINDING</p><h2>接入线程</h2><ol><li>先确认当前客户端已经注册并启用了 Stone Memory MCP。</li><li>打开需要绑定的新对话窗口。</li><li>把下面这句话发送给该窗口，Agent 会调用 bind MCP 完成绑定。</li></ol><div class="binding-command"><p>${escapeHtml(instruction)}</p><button class="primary" id="copy-binding-command" type="button">复制指令</button></div><small class="binding-guide-note">当前目标记忆体：${escapeHtml(memoryName)}</small>`;
  const close=()=>dialog.close();
  dialog.querySelector(".dialog-close").onclick=close;
  dialog.addEventListener("click",event=>{if(event.target===dialog)close();});
  dialog.addEventListener("close",()=>dialog.remove(),{once:true});
  dialog.querySelector("#copy-binding-command").onclick=async event=>{
    try{
      await navigator.clipboard.writeText(instruction);
    }catch{
      const input=document.createElement("textarea");
      input.value=instruction;input.style.position="fixed";input.style.opacity="0";document.body.append(input);input.select();
      document.execCommand("copy");input.remove();
    }
    event.currentTarget.textContent="已复制";
    showToast("绑定指令已复制");
  };
  document.body.append(dialog);
  dialog.showModal();
}

function renderAboutContent(main) {
  const action=(href,label)=>href?`<a class="secondary about-action" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}<span>↗</span></a>`:`<button class="secondary about-action" disabled>${label}<span>待配置</span></button>`;
  main.innerHTML=`<div class="dashboard-head about-hero"><div><p class="eyebrow">About Stone Memory</p><h1>关于项目</h1><p class="lead">了解磐石记忆的最新进展，参与社区，也为项目继续生长添一块石头。</p></div>${stoneSvg("mini-stone")}</div><section class="about-grid"><article class="about-card about-install"><span class="about-card-icon" aria-hidden="true">⌂</span><div><p class="eyebrow">MOBILE APP</p><h2>添加到桌面主页</h2><p>像普通应用一样打开 Stone Memory，并使用当前主题正在显示的图标。</p><small id="pwa-install-hint"></small></div><button class="primary about-action" id="install-stone-memory">添加到桌面主页</button></article><article class="about-card"><span class="about-card-icon" aria-hidden="true">⌘</span><div><p class="eyebrow">OPEN SOURCE</p><h2>GitHub 项目</h2><p>查看项目动态、提交 Issue，或者用一颗 Star 支持 Stone Memory。</p></div>${action(projectContact.github,"前往 GitHub")}</article><article class="about-card"><span class="about-card-icon" aria-hidden="true">✦</span><div><p class="eyebrow">LATEST NEWS</p><h2>关注项目动态</h2><p>前往小红书主页，查看功能介绍、开发故事与最新测试消息。</p></div>${action(projectContact.xiaohongshu,"关注小红书")}</article><article class="about-card"><span class="about-card-icon" aria-hidden="true">◌</span><div><p class="eyebrow">COMMUNITY</p><h2>加入 QQ 交流群</h2><p>与其他使用者交流部署经验、使用方式和新的想法。</p></div>${action(projectContact.qqGroup,"加入交流群")}</article><article class="about-card"><span class="about-card-icon" aria-hidden="true">@</span><div><p class="eyebrow">CONTACT</p><h2>联系我们</h2><p>合作、授权和正式问题反馈，请通过官方邮箱联系。</p><code>${escapeHtml(projectContact.email||"官方邮箱待配置")}</code></div><button class="secondary about-action" id="copy-project-email" ${projectContact.email?"":"disabled"}>复制官方邮箱<span>${projectContact.email?"复制":"待配置"}</span></button></article><article class="about-card about-support"><div><p class="eyebrow">SUPPORT THE CREATOR</p><h2>支持开发者</h2><p>如果 Stone Memory 帮到了你，可以自愿支持项目继续开发与维护。</p></div><div class="support-code">${projectContact.supportImage?`<img src="${escapeHtml(projectContact.supportImage)}" alt="开发者赞赏码">`:`<div><span>赞赏码</span><small>图片待放置</small></div>`}</div></article></section><p class="about-footnote">支持完全自愿，不影响 Stone Memory 已提供功能的正常使用。</p>`;
  main.querySelector("#copy-project-email")?.addEventListener("click",async()=>{
    try{await navigator.clipboard.writeText(projectContact.email);showToast("官方邮箱已复制");}
    catch{showToast("复制失败，请手动复制邮箱","error");}
  });
  void syncPwaIcons().catch(()=>{});
  main.querySelector("#install-stone-memory")?.addEventListener("click",installStoneMemory);
  refreshPwaInstallUi();
}

function renderGlobalAbout() {
  app.innerHTML = `<section class="global-about"><main class="shell global-about-main" id="global-about-main"></main></section>`;
  renderMyContent(document.querySelector("#global-about-main"));
}

function renderMyContent(main) {
  const external=(href,label)=>href?`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>`:"";
  main.innerHTML=`<div class="dashboard-head about-hero"><div><p class="eyebrow">MY STONE MEMORY</p><h1>我的</h1><p class="lead">管理外观、安装入口与项目联系。</p></div></div><section class="me-panel"><div id="theme-entry-host"></div><button class="me-menu-row" id="install-stone-memory" type="button"><span class="me-menu-icon" aria-hidden="true">⌂</span><span class="me-menu-copy"><strong>添加到桌面主页</strong></span><span aria-hidden="true">›</span></button><button class="me-menu-row" id="open-privacy-statement" type="button"><span class="me-menu-icon" aria-hidden="true">◇</span><span class="me-menu-copy"><strong>隐私声明</strong><small>了解数据存储、导出与第三方服务边界</small></span><span aria-hidden="true">›</span></button><div class="me-menu-row me-follow-row"><span class="me-menu-icon" aria-hidden="true">◎</span><span class="me-menu-copy"><strong>关注项目</strong></span></div><button class="me-menu-row" id="open-support-code" type="button"><span class="me-menu-icon" aria-hidden="true">✦</span><span class="me-menu-copy"><strong>召唤赞赏码</strong><small>请作者喝杯茶，给小石头添一点口粮</small></span><span aria-hidden="true">›</span></button></section><dialog class="support-dialog" id="support-code-dialog"><button class="dialog-close" type="button" aria-label="关闭">×</button><h2>召唤赞赏码</h2><p>支持完全自愿，不影响任何已有功能。</p><div class="support-code">${projectContact.supportImage?`<img src="${escapeHtml(projectContact.supportImage)}" alt="开发者赞赏码">`:`<div><span>赞赏码</span><small>图片待放置</small></div>`}</div></dialog><dialog class="privacy-dialog" id="privacy-statement-dialog"><button class="dialog-close" type="button" aria-label="关闭">×</button><h2>隐私声明</h2><p>Stone Memory 的记忆、对话、摘要和设置默认保存在你配置的本地服务及其数据目录中。项目不会因为打开页面而把对话内容上传到第三方分析服务，也不内置广告追踪。</p><p>只有你主动启用的功能才会发送数据：例如你配置的摘要模型/API、MCP 或外部项目链接。调用上游服务时，内容会按对应功能的用途发送，请自行确认服务商的隐私政策与保留规则。</p><p>“数据导出”由你主动触发，导出的文件可能包含全量对话和摘要，请像保护原始记忆一样保存。主题、界面偏好和部分安装状态会保存在浏览器本地存储中。</p><p>删除浏览器数据不会自动删除服务器上的记忆；删除记忆体、备份或导出文件也应由你在对应管理入口中明确操作。</p></dialog>`;
  main.querySelector("#open-privacy-statement")?.insertAdjacentHTML("beforebegin",`<button class="me-menu-row" id="open-lan-access" type="button"><span class="me-menu-icon" aria-hidden="true">⌁</span><span class="me-menu-copy"><strong>局域网访问</strong><small>让同一 Wi-Fi 下的手机安全登录</small></span><span aria-hidden="true">›</span></button>`);
  main.querySelector("#support-code-dialog")?.insertAdjacentHTML("beforebegin",`<dialog class="privacy-dialog" id="lan-access-dialog"><button class="dialog-close" type="button" aria-label="关闭">×</button><h2>局域网访问</h2><div id="lan-access-content"><p>正在读取访问状态…</p></div></dialog>`);
  const supportDialog=main.querySelector("#support-code-dialog");
  const privacyDialog=main.querySelector("#privacy-statement-dialog");
  const lanDialog=main.querySelector("#lan-access-dialog");
  main.querySelector("#open-support-code")?.addEventListener("click",()=>supportDialog?.showModal());
  main.querySelector("#open-privacy-statement")?.addEventListener("click",()=>privacyDialog?.showModal());
  main.querySelector("#open-lan-access")?.addEventListener("click",async()=>{
    lanDialog?.showModal();
    const target=lanDialog?.querySelector("#lan-access-content");
    try{
      const status=await api("/api/web-access");
      target.innerHTML=status.enabled
        ?`<p><strong>局域网访问已开启</strong></p><p>同一 Wi-Fi 下可打开；首次登录后会记住该设备 30 天，Web 重启无需重填：</p><div class="lan-access-urls">${status.urls.length?status.urls.map(url=>`<code>${escapeHtml(url)}</code>`).join(""):`<small>暂未检测到可用的局域网 IPv4 地址。</small>`}</div><p class="notice warning">当前是局域网 HTTP，请只在可信网络中使用。关闭请在服务器运行 <code>stmem web lan disable</code>。</p>`
        :`<p>当前仅允许本机访问。在服务器终端运行下面的命令即可开启，并获得手机登录 Token：</p><code class="lan-access-command">stmem web lan enable</code><p>开启后回到这里即可查看手机访问地址。无需域名、VPN 或 Tailscale。</p>`;
    }catch(error){target.innerHTML=`<p class="notice danger">${escapeHtml(error.message)}</p>`;}
  });
  supportDialog?.querySelector(".dialog-close")?.addEventListener("click",()=>supportDialog.close());
  privacyDialog?.querySelector(".dialog-close")?.addEventListener("click",()=>privacyDialog.close());
  lanDialog?.querySelector(".dialog-close")?.addEventListener("click",()=>lanDialog.close());
  void syncPwaIcons().catch(()=>{});
  main.querySelector("#install-stone-memory")?.addEventListener("click",installStoneMemory);
  refreshPwaInstallUi();
}

window.StoneLegacyNavigation = Object.freeze({
  openAbout: renderGlobalAbout,
  openWorkshop: renderGlobalWorkshop,
  openHome: lobby,
  openMemory: (identifier, view = "overview") => openLibrary(identifier, view),
});

function managementNav(active="overview") {
  void active;
  return "";
}

function bindManagementNav(library) {
  void library;
}

let settingsRenderVersion = 0;

function activateWorkspaceTab(active) {
  if (active !== "settings") settingsRenderVersion += 1;
  document.querySelectorAll(".workspace-nav button").forEach(button=>{
    const selected=button.dataset.view===active;
    button.classList.toggle("active",selected);
    button.setAttribute("aria-selected",String(selected));
  });
}

function activateManagementNav() {
  activateWorkspaceTab("memory");
}

function renderManagement(library) {
  activateManagementNav();
  const main=document.querySelector("#workspace-main"),counts=library.counts||{};
  main.innerHTML=`${managementNav("overview")}<section class="management-overview-grid"><article class="section-card management-overview-panel"><header><p class="eyebrow">Memory archive</p><h1>记忆档案</h1></header><div class="management-overview-list"><button class="management-overview-entry" data-management-archive="rules"><span><strong>人设 / 规则</strong><small>查看和管理会注入当前记忆体的人设与规则</small></span><b>共 ${counts.rules||0} 条</b><i aria-hidden="true">›</i></button><button class="management-overview-entry" data-management-archive="feelings"><span><strong>摘要</strong><small>查看完整、精简和隐藏的记忆摘要</small></span><b>共 ${counts.feelings||0} 条</b><i aria-hidden="true">›</i></button><button class="management-overview-entry" data-management-archive="conversations"><span><strong>全量对话</strong><small>按日期回看已经进入记忆体的真实原文</small></span><b>共 ${counts.messages||counts.conversations||0} 条</b><i aria-hidden="true">›</i></button><button class="management-overview-entry" data-management-archive="timeline"><span><strong>时间轴</strong><small>查看词频、重要摘要与记忆生命周期</small></span><i aria-hidden="true">›</i></button></div></article><article class="section-card management-overview-panel"><header><p class="eyebrow">Memory maintenance</p><h1>记忆维护</h1></header><div class="management-overview-list"><button class="management-overview-entry" data-management-maintenance="import"><span><strong>数据导入</strong><small>支持直接导入线程文件或符合格式的对话文件</small></span><i aria-hidden="true">›</i></button><button class="management-overview-entry" data-management-maintenance="export"><span><strong>数据导出</strong><small>导出当前记忆体的全量对话与摘要表，不包含密钥和运行配置</small></span><i aria-hidden="true">›</i></button><button class="management-overview-entry" data-management-maintenance="materials"><span><strong>管理挖掘素材</strong><small>决定哪些对话、工具链成为挖掘摘要的素材，同时避免反复注入的内容污染摘要库</small></span><i aria-hidden="true">›</i></button><button class="management-overview-entry" data-management-maintenance="mining"><span><strong>记忆挖掘台</strong><small>手动生成多日摘要并审核</small></span><i aria-hidden="true">›</i></button><button class="management-overview-entry" data-management-maintenance="compression"><span><strong>记忆压缩（测试功能）</strong><small>预览并逐步精简不再需要完整注入的旧摘要</small></span><i aria-hidden="true">›</i></button></div></article></section>`;
  bindManagementNav(library);
  main.querySelector('[data-management-archive="rules"]').onclick=()=>renderMemorySection(library,"rules");
  main.querySelector('[data-management-archive="feelings"]').onclick=()=>renderMemorySection(library,"feelings");
  main.querySelector('[data-management-archive="conversations"]').onclick=()=>renderConversations(library);
  main.querySelector('[data-management-archive="timeline"]').onclick=()=>renderTimeline(library);
  main.querySelector('[data-management-maintenance="import"]').onclick=()=>renderConversationImport(library);
  main.querySelector('[data-management-maintenance="export"]').onclick=event=>downloadMemoryExport(library,event.currentTarget);
  main.querySelector('[data-management-maintenance="materials"]').onclick=()=>renderToolPolicy(library);
  main.querySelector('[data-management-maintenance="mining"]').onclick=()=>renderMining(library);
  main.querySelector('[data-management-maintenance="compression"]').onclick=()=>renderCompression(library);
}

async function downloadMemoryExport(library, button) {
  const previous=button.innerHTML;
  button.disabled=true;
  button.querySelector("strong").textContent="正在导出…";
  try {
    const response=await fetch(`/api/libraries/${encodeURIComponent(library.threadId)}/export`,{cache:"no-store"});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||"导出失败");}
    const blob=await response.blob(),stamp=new Date().toISOString().slice(0,10),safeName=String(library.libraryName||library.threadId||"memory").replace(/[\\/:*?"<>|]/g,"_");
    const link=document.createElement("a"),url=URL.createObjectURL(blob);
    link.href=url;link.download=`${safeName}-记忆导出-${stamp}.json`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    showToast(`已导出 ${countsForExport(library).messages} 条对话和 ${countsForExport(library).feelings} 条摘要`);
  } catch(error) { showToast(error.message,"error"); }
  finally { button.disabled=false;button.innerHTML=previous; }
}

function countsForExport(library) {
  const counts=library.counts||{};
  return {messages:counts.messages||counts.conversations||0,feelings:counts.feelings||0};
}

async function renderAutomation(library) {
  activateManagementNav();
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`${managementNav("automation")}<div class="dashboard-head"><div><p class="eyebrow">Background services</p><h1>自动化</h1><p class="lead">集中查看后台正在替这个记忆体完成的工作。</p></div></div><section class="section-card"><div class="empty">正在读取自动化状态…</div></section>`;
  bindManagementNav(library);
  try{
    const config=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`),card=main.querySelector(".section-card");
    const item=(title,on,detail)=>`<article class="automation-status-card ${on?"enabled":""}"><span class="status-dot"></span><div><strong>${title}</strong><small>${detail}</small></div><b>${on?"已开启":"已关闭"}</b></article>`;
    card.innerHTML=`<div class="automation-status-list">${item("自动录入全量对话",config.automaticFullMining,"持续同步当前绑定线程的新对话")}${item("自动挖掘摘要和素材",config.automaticMemoryMaintenance,"跨天后处理已经完整结束的日期")}${item("自动压缩摘要（测试）",config.automaticCompression,"测试能力，默认保持关闭")}</div><div class="wizard-actions"><span>开关与模型配置仍在记忆体设置中统一保存。</span><button class="primary" id="open-automation-settings">前往设置</button></div>`;
    card.querySelector("#open-automation-settings").onclick=()=>renderSettings(library);
  }catch(error){main.querySelector(".section-card").innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`;}
}

function renderDeveloperMode(library) {
  renderGlobalWorkshop("plugins", library.memoryId || library.threadId);
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
  return row.categories.length?`当前按 ${row.categories.join(" / ")} 特征解释`:"尚未进入素材库，暂只展示真实命中";
}

async function renderTimeline(library,{terms="",from="",to=""}={}) {
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`${managementNav("memories")}<div class="dashboard-head"><div><p class="eyebrow">Temporal evidence</p><h1>时间轴</h1><p class="lead">把关键词曲线、对应摘要与生命周期证据放在同一条时间线上查看。</p></div><button class="ghost" id="back-memory">返回记忆</button></div><section class="section-card timeline-query-card"><form id="timeline-query"><div class="timeline-term-field"><label for="timeline-terms">关键词</label><input id="timeline-terms" value="${escapeHtml(terms)}" placeholder="输入 1～3 个词，用逗号分隔"></div><div><label for="timeline-from">开始日期</label><input id="timeline-from" type="date" value="${escapeHtml(from)}"></div><div><label for="timeline-to">结束日期</label><input id="timeline-to" type="date" value="${escapeHtml(to)}"></div><button class="primary">生成时间轴</button></form><p class="timeline-query-note">曲线展示真实对话词频；摘要点负责说明这些词在记忆中留下了什么。时间轴仅解释，不会自动修改摘要。</p></section><div id="timeline-results"></div>`;
  bindManagementNav(library);
  main.querySelector("#back-memory").onclick=()=>renderManagement(library);
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
  activateManagementNav();
  const main=document.querySelector("#workspace-main");main.innerHTML=`${managementNav("conversations")}<div class="dashboard-head"><div><p class="eyebrow">SQLite archive</p><h1>对话档案</h1><p class="lead">按日期翻看你和 ${escapeHtml(library.ai||"AI")} 的真实对话记录。</p></div><button class="ghost" id="back-memory">返回记忆</button></div><section class="section-card conversation-overview" id="conversation-content"><div class="empty">正在读取…</div></section>`;bindManagementNav(library);
  main.querySelector("#back-memory").onclick=()=>renderManagement(library);
  const params=new URLSearchParams({page:String(page),calendarPage:String(calendarPage)});if(search)params.set("search",search);if(date)params.set("date",date);if(focus)params.set("focus",focus);const data=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/conversations?${params}`),card=main.querySelector("#conversation-content"),calendar=data.calendar;
  const calendarHtml=calendar.days.length?`<div class="mining-calendar conversation-calendar"><div class="calendar-head"><button class="calendar-arrow" id="newer-month" aria-label="更新的月份" ${calendar.page<=1?"disabled":""}>‹</button><div><strong>${calendar.month.replace("-"," 年 ")} 月</strong><span>聊天留下的小苔痕</span></div><button class="calendar-arrow" id="older-month" aria-label="更早的月份" ${calendar.page>=calendar.totalPages?"disabled":""}>›</button></div><div class="calendar-weekdays">${["日","一","二","三","四","五","六"].map(day=>`<span>${day}</span>`).join("")}</div><div class="calendar-days">${Array.from({length:calendar.leadingBlanks},()=>'<span class="calendar-blank"></span>').join("")}${calendar.days.map(day=>`<button class="calendar-day level-${day.count===0?0:day.count<=100?1:day.count<200?2:3} ${day.date===date?"selected":""}" data-calendar-date="${day.date}" title="${day.date} · ${day.count} 条对话" aria-label="${day.date}，${day.count} 条对话"></button>`).join("")}</div><div class="conversation-legend"><span><i class="level-0"></i>无对话</span><span><i class="level-1"></i>≤100</span><span><i class="level-2"></i>101–199</span><span><i class="level-3"></i>≥200</span></div></div>`:`<div class="empty">archive 中还没有纯对话。</div>`;
  card.innerHTML=`<div class="mining-overview-grid conversation-overview-grid"><div id="conversation-calendar">${calendarHtml}</div><div class="conversation-archive-panel"><div class="section-title-row"><div><p class="eyebrow">${search?"关键词结果":date?formatChineseDate(date):"按日查看"}</p><h2>${search?`搜索“${escapeHtml(search)}”`:date?`${escapeHtml(library.user||"用户")} 与 ${escapeHtml(library.ai||"AI")}`:"选择一天的对话"}</h2></div></div><div class="conversation-tools"><form id="conversation-search"><input placeholder="搜索关键词" value="${escapeHtml(search)}"><button class="secondary">搜索</button></form><div class="date-jump"><input id="conversation-date" type="date" value="${escapeHtml(date)}"><button class="secondary" id="open-date">按日期查看</button></div></div><div id="conversation-results"></div></div></div>`;
  const calendarSlot=card.querySelector("#conversation-calendar");
  calendarSlot.querySelectorAll("[data-calendar-date]").forEach(button=>button.onclick=()=>renderConversations(library,{date:button.dataset.calendarDate,calendarPage:calendar.page}));
  const switchMonth=nextCalendarPage=>renderConversations(library,{search,date,page:1,calendarPage:nextCalendarPage});
  calendarSlot.querySelector("#newer-month")?.addEventListener("click",()=>switchMonth(calendar.page-1));calendarSlot.querySelector("#older-month")?.addEventListener("click",()=>switchMonth(calendar.page+1));
  card.querySelector("#conversation-search").onsubmit=e=>{e.preventDefault();const q=e.currentTarget.querySelector("input").value.trim();renderConversations(library,{search:q,page:1,calendarPage:calendar.page});};card.querySelector("#open-date").onclick=()=>{const d=card.querySelector("#conversation-date").value;if(d)renderConversations(library,{date:d,page:1,calendarPage:calendarPageForDate(calendar,d)});};
  const target=card.querySelector("#conversation-results");if(data.mode==="calendar"){target.innerHTML='<div class="empty">从左侧月历选择一天，查看当天完整对话。</div>';return;}
  const rows=data.rows;let previousDate="";const bubbles=rows.rows.map(row=>{const dayDivider=data.mode==="search"&&row.sourceDate!==previousDate?`<div class="conversation-day-divider"><span>${formatChineseDate(row.sourceDate)}</span></div>`:"";previousDate=row.sourceDate;const side=row.role==="user"?"user":"assistant";return `${dayDivider}<article class="chat-message ${side} ${focus===row.timestamp?"focused":""}" data-timestamp="${escapeHtml(row.timestamp)}" data-source-date="${escapeHtml(row.sourceDate)}"><div class="chat-bubble"><time>${escapeHtml(formatBeijingClock(row.timestamp))}</time><p>${escapeHtml(row.text)}</p>${data.mode==="search"?'<button class="jump-conversation">查看当天对话</button>':""}</div></article>`;}).join("");
  target.innerHTML=rows.rows.length?`<div class="chat-thread">${bubbles}</div>`:`<div class="empty">没有匹配的对话。</div>`;target.insertAdjacentHTML("beforeend",pagination(rows));target.querySelectorAll(".jump-conversation").forEach(b=>b.onclick=()=>{const row=b.closest("article"),targetDate=row.dataset.sourceDate;renderConversations(library,{date:targetDate,focus:row.dataset.timestamp,calendarPage:calendarPageForDate(calendar,targetDate)});});bindPagination(target,rows.page,rows.totalPages,nextPage=>renderConversations(library,{search,date,page:nextPage,calendarPage:calendar.page}));if(focus)setTimeout(()=>target.querySelector(".focused")?.scrollIntoView({block:"center"}),0);
}

async function renderMemorySection(library, section, page=1, search="", category="", mode="", importance="", sort="desc", retainAnchor=false, eventAnchor=false, date="") {
  const batch=state.feelingBatch;
  if(section==="feelings"&&batch.memoryId&&batch.memoryId!==library.threadId){batch.active=false;batch.memoryId=null;batch.pending.clear();}
  const main=document.querySelector("#workspace-main"), titles={rules:"人设 / 规则",feelings:"摘要",features:"素材库"};
  main.innerHTML=`${managementNav("memories")}<div class="dashboard-head"><div><p class="eyebrow">记忆</p><h1>${titles[section]}</h1>${section==="feelings"?'<p class="lead memory-anchor-guide">选择【原文锚点】，将在线程中注入该摘要对应原文；选择【事件锚点】，则该摘要不受衰减模型影响；选择【隐藏摘要】，线程重建时该摘要将不注入线程。</p>':""}</div><button class="ghost" id="back-memory">返回记忆</button></div><section class="section-card" id="memory-content"><div class="empty">正在读取…</div></section>`;
  bindManagementNav(library);
  main.querySelector("#back-memory").onclick=()=>{if(section==="feelings"&&batch.active){showToast("请先结束多选，再离开摘要页面");return;}renderManagement(library);};
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
  const feelingControls=section==="feelings"?`<div class="memory-subtoolbar"><div class="filter-chips" aria-label="锚点筛选"><button class="filter-chip ${retainAnchor?"active":""}" id="retain-filter" aria-pressed="${retainAnchor}">原文锚点</button><button class="filter-chip ${eventAnchor?"active":""}" id="event-filter" aria-pressed="${eventAnchor}">事件锚点</button></div><div class="summary-date-tools"><span class="batch-pending" ${batch.active?"":"hidden"}>待保存 ${batch.pending.size} 条 · 新增原文锚点需结束多选</span><button class="secondary ${batch.active?"active":""}" id="toggle-feeling-batch">${batch.active?"结束多选":"开启多选模式"}</button><input id="summary-date" type="date" value="${escapeHtml(date)}"><button class="ghost" id="clear-summary-date" ${date?"":"disabled"}>清除日期</button><label class="sort-control">日期顺序<select id="sort-filter"><option value="desc" ${sort==="desc"?"selected":""}>最新优先</option><option value="asc" ${sort==="asc"?"selected":""}>最早优先</option></select></label></div></div>`:"";
  const displayRows=section==="feelings"?rows.rows.map(row=>{const pending=batch.active?batch.pending.get(row.id):null;return pending?{...row,eventAnchor:pending.eventAnchor??row.eventAnchor,retainAnchor:pending.retainAnchor??row.retainAnchor,summary_mode:pending.summaryMode??row.summary_mode}:row;}):rows.rows;
  card.innerHTML=`<div class="memory-toolbar"><input id="memory-search" placeholder="搜索摘要内容" value="${escapeHtml(search)}">${filters}<button class="secondary" id="memory-filter">筛选</button></div>${feelingControls}${displayRows.length?displayRows.map((row,index)=>section==="feelings"?feelingCard(row,index,"seq",batch.active):`<article class="memory-row"><div class="memory-time">${escapeHtml(row.source_date||"")}</div><p>${escapeHtml(row.content)}</p><span class="badge">importance ${row.importance}</span><span class="badge">${escapeHtml(row.category||"misc")}</span></article>`).join(""):`<div class="empty">没有匹配内容。</div>`}${pagination(rows)}<div id="feeling-editor"></div>`;
  const applyFilters=(nextRetain=retainAnchor,nextEvent=eventAnchor,nextDate=card.querySelector("#summary-date")?.value||"")=>renderMemorySection(library,section,1,card.querySelector("#memory-search").value,card.querySelector("#category-filter")?.value||"",card.querySelector("#mode-filter")?.value||"",card.querySelector("#importance-filter")?.value||"",card.querySelector("#sort-filter")?.value||sort,nextRetain,nextEvent,nextDate);
  card.querySelector("#memory-filter").onclick=()=>batch.active?showToast("请先结束多选，再更改筛选条件"):applyFilters();
  card.querySelector("#memory-search").onkeydown=event=>{if(event.key==="Enter"){event.preventDefault();batch.active?showToast("请先结束多选，再更改筛选条件"):applyFilters();}};
  if(section==="feelings"){
    const blockedFilter=action=>()=>batch.active?showToast("请先结束多选，再更改筛选条件"):action();
    card.querySelector("#retain-filter").onclick=blockedFilter(()=>applyFilters(!retainAnchor,eventAnchor));card.querySelector("#event-filter").onclick=blockedFilter(()=>applyFilters(retainAnchor,!eventAnchor));card.querySelector("#sort-filter").onchange=blockedFilter(()=>applyFilters());card.querySelector("#summary-date").onchange=blockedFilter(()=>applyFilters());card.querySelector("#clear-summary-date").onclick=blockedFilter(()=>applyFilters(retainAnchor,eventAnchor,""));
    card.querySelector("#toggle-feeling-batch").onclick=async()=>{if(!batch.active){batch.active=true;batch.memoryId=library.threadId;batch.pending.clear();await renderMemorySection(library,section,page,search,category,mode,importance,sort,retainAnchor,eventAnchor,date);return;}if(!await flushFeelingBatch(library))return;batch.active=false;batch.memoryId=null;showToast("多选修改已保存");await renderMemorySection(library,section,page,search,category,mode,importance,sort,retainAnchor,eventAnchor,date);};
  }
  bindPagination(card,rows.page,rows.totalPages,async nextPage=>{if(section==="feelings"&&batch.active&&!await flushFeelingBatch(library))return;await renderMemorySection(library,section,nextPage,search,category,mode,importance,sort,retainAnchor,eventAnchor,date);});
  if(section==="feelings")bindFeelingCards(card,library,rows.rows,card.querySelector("#feeling-editor"),()=>renderMemorySection(library,section,page,search,category,mode,importance,sort,retainAnchor,eventAnchor,date),batch.active);
}

function feelingCard(row,index,sequence="seq",batchMode=false) {
  const number=sequence==="daySeq"?(row.daySeq||index+1):(row.seq||index+1),content=row.summary_mode==="coarse"&&row.coarse_summary?row.coarse_summary:row.content;
  const retainDisabled=batchMode&&!row.retainAnchor;
  return `<article class="memory-row feeling-card ${(row.eventAnchor||row.retainAnchor)?"anchored":""} ${row.summary_mode==="hidden"?"is-hidden":""} ${batchMode?"batch-mode":""}"><div class="memory-time">第 ${number} 条 · importance ${row.importance}</div><p>${escapeHtml(content)}</p><div class="feeling-quick-actions"><button class="ghost edit-feeling" data-index="${index}" ${batchMode?"disabled":""}>查看 / 编辑</button><label class="${retainDisabled?"is-disabled":""}" title="${retainDisabled?"原文锚点需要逐条确认对话范围，请结束多选后设置。":""}"><input class="quick-retain" type="checkbox" data-index="${index}" ${row.retainAnchor?"checked":""} ${retainDisabled?"disabled":""}>原文锚点</label><label><input class="quick-event" type="checkbox" data-index="${index}" ${row.eventAnchor?"checked":""}>事件锚点</label><label><input class="quick-hidden" type="checkbox" data-index="${index}" ${row.summary_mode==="hidden"?"checked":""}>隐藏摘要</label></div></article>`;
}

async function flushFeelingBatch(library) {
  const batch=state.feelingBatch;
  if(!batch.pending.size)return true;
  try{await api(`/api/libraries/${encodeURIComponent(library.threadId)}/feelings/batch-update`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items:[...batch.pending.entries()].map(([id,changes])=>({id,...changes}))})});batch.pending.clear();return true;}
  catch(error){showToast(`批量保存失败：${error.message}`,"error");return false;}
}

function bindFeelingCards(container,library,rows,editorTarget,refresh,batchMode=false) {
  const stage=(row,changes)=>{const current={...(state.feelingBatch.pending.get(row.id)||{}),...changes};if(current.summaryMode===row.summary_mode)delete current.summaryMode;if(current.eventAnchor===Boolean(row.eventAnchor))delete current.eventAnchor;if(current.retainAnchor===Boolean(row.retainAnchor))delete current.retainAnchor;Object.keys(current).length?state.feelingBatch.pending.set(row.id,current):state.feelingBatch.pending.delete(row.id);const count=container.querySelector(".batch-pending");if(count)count.textContent=`待保存 ${state.feelingBatch.pending.size} 条 · 新增原文锚点需结束多选`;};
  const refreshWithoutJump=async()=>{const scrollY=window.scrollY;await refresh();requestAnimationFrame(()=>window.scrollTo({top:scrollY,left:0,behavior:"auto"}));};
  container.querySelectorAll(".edit-feeling").forEach(button=>button.onclick=()=>renderFeelingEditor(library,rows[Number(button.dataset.index)],editorTarget,refreshWithoutJump));
  container.querySelectorAll(".quick-event").forEach(input=>input.onchange=async()=>{
    const row=rows[Number(input.dataset.index)],enabled=input.checked;input.disabled=true;
    if(batchMode){stage(row,{eventAnchor:enabled});input.disabled=false;return;}
    try{await setFeelingAnchor(library,row,"event",enabled);showToast(enabled?"已设置事件锚点":"已移除事件锚点");await refreshWithoutJump();}
    catch(error){input.checked=!enabled;input.disabled=false;showToast(error.message,"error");}
  });
  container.querySelectorAll(".quick-hidden").forEach(input=>input.onchange=async()=>{
    const row=rows[Number(input.dataset.index)],hidden=input.checked;
    if(hidden&&(row.eventAnchor||row.retainAnchor)&&!confirm("这条摘要已有锚点。隐藏后摘要本身不注入，但锚点保护仍可能生效，确认继续吗？")){input.checked=false;return;}
    if(batchMode){stage(row,{summaryMode:hidden?"hidden":(row.coarse_summary?"coarse":"daily")});return;}
    input.disabled=true;
    try{await api(`/api/libraries/${encodeURIComponent(library.threadId)}/feelings/update`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:row.id,summaryMode:hidden?"hidden":(row.coarse_summary?"coarse":"daily")})});showToast(hidden?"摘要已隐藏":"摘要已恢复");await refreshWithoutJump();}
    catch(error){input.checked=!hidden;input.disabled=false;showToast(error.message,"error");}
  });
  container.querySelectorAll(".quick-retain").forEach(input=>input.onchange=async()=>{
    const row=rows[Number(input.dataset.index)],enabled=input.checked;
    if(batchMode){if(enabled&&!row.retainAnchor){input.checked=false;showToast("原文锚点需要逐条确认对话范围，请结束多选后设置");return;}stage(row,{retainAnchor:enabled});return;}
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
  activateWorkspaceTab("settings");
  const renderVersion=++settingsRenderVersion;
  const main = document.querySelector("#workspace-main");
  main.innerHTML = `<section class="section-card settings-loading"><div class="empty">正在读取设置…</div></section>`;
  try {
    const config = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`);
    if(renderVersion!==settingsRenderVersion||!main.isConnected)return;
    main.innerHTML = `<form id="settings-form" class="settings-page"><div class="settings-grid">
      <section class="section-card settings-card"><div class="section-title-row"><div><p class="eyebrow">Identity</p><h2>基本信息</h2><small>这些名称会用于显示和生成记忆摘要。</small></div></div><div class="field-grid">
        <div class="field full"><label for="setting-libraryName">记忆体名字</label><input id="setting-libraryName" name="libraryName" value="${escapeHtml(config.libraryName)}" required><small>控制台和记忆体大厅显示的名称；不能与其他记忆体重名。</small></div>
        <div class="field"><label for="setting-ai">AI 名字</label><input id="setting-ai" name="ai" value="${escapeHtml(config.ai)}" required></div>
        <div class="field"><label for="setting-user">用户名字</label><input id="setting-user" name="user" value="${escapeHtml(config.user)}" required></div>
        <div class="field full"><label for="setting-gender">用户性别</label><select id="setting-gender" name="userGender"><option value="unspecified" ${config.userGender === "unspecified" ? "selected" : ""}>不指定</option><option value="female" ${config.userGender === "female" ? "selected" : ""}>女性</option><option value="male" ${config.userGender === "male" ? "selected" : ""}>男性</option></select></div>
      </div></section>
      <section class="section-card settings-card"><div class="section-title-row"><div><p class="eyebrow">Mining</p><h2>摘要生成</h2><small>选择记忆挖掘使用的执行通道。</small></div></div><div class="field-grid">
        <div class="field full"><label for="setting-scenario">挖掘场景</label><select id="setting-scenario" name="scenario">${(config.scenario||config.purpose)==="study"?'<option value="study" selected>学习（旧场景）</option>':""}<option value="life-supervision" ${config.scenario==="life-supervision"?"selected":""}>生活监督</option><option value="accompany" ${(config.scenario||config.purpose)==="accompany"?"selected":""}>情感陪伴</option><option value="coding" ${(config.scenario||config.purpose)==="coding"?"selected":""}>编程日志</option></select><small>只影响今后生成的摘要和特征，不会移动目录或改写历史记忆。</small></div>
        <div class="field full"><label for="setting-miner">挖掘方式</label><select id="setting-miner" name="minerMode"><option value="subagent" ${config.minerMode === "subagent" ? "selected" : ""}>本地 Subagent</option><option value="api" ${config.minerMode === "api" ? "selected" : ""}>API</option></select></div>
        <div id="setting-api-fields" class="field full"></div>
      </div></section>
      <section class="section-card settings-card settings-context-card"><div class="section-title-row"><div><p class="eyebrow">Rebuild defaults</p><h2>上下文默认值</h2><small>作为线程重建的初始值，每次重建时仍可临时调整。</small></div><span class="badge">${escapeHtml(config.runtime||"未知运行时")}</span></div><div class="field-grid">
        <div class="field"><label for="setting-window">默认保留对话天数</label><input id="setting-window" name="windowDays" type="number" min="1" max="365" value="${config.windowDays}"></div>
        <div class="field"><label for="setting-tools">默认保留工具链组数</label><input id="setting-tools" name="keepToolPairs" type="number" min="0" max="500" value="${config.keepToolPairs}"></div>
        <div class="field full"><label for="setting-context-window">上下文窗口上限（tokens，可选）</label><input id="setting-context-window" name="contextWindowTokens" type="number" min="1000" step="1000" value="${config.contextWindowTokens||""}" placeholder="例如 1000000"><small>Claude 建议填写；Codex 通常能自动识别。手动值优先。</small></div>
      </div><p class="settings-binding-note">线程接入和文件定位已由 Binding 管理；新增窗口请前往“接入”，无需在这里填写线程 ID 或搜索目录。</p></section>
      <section class="section-card settings-card settings-danger-card"><div><p class="eyebrow">Danger zone</p><h2>危险操作</h2><p>永久删除这个记忆体及其本地数据。此操作无法恢复。</p></div><button class="danger-button" id="delete-library" type="button">删除记忆体</button></section>
    </div><div class="settings-savebar"><span>修改只影响当前记忆体。</span><button class="primary" type="submit">保存设置</button></div></form>`;
    const card = main;
    const miner = card.querySelector("#setting-miner"), apiFields = card.querySelector("#setting-api-fields");
    const renderApiSettings = () => {
      apiFields.innerHTML = miner.value === "api" ? `<div class="field-grid"><div class="field"><label for="setting-provider">API 厂商</label><input id="setting-provider" name="apiProvider" value="${escapeHtml(config.apiProvider || "")}" required></div><div class="field"><label for="setting-model">模型名</label><input id="setting-model" name="model" value="${escapeHtml(config.model || "")}" required><small>必须与上游当前提供的模型名完全一致；Stone Memory 不预设。</small></div><div class="field"><label for="setting-key">API Key</label><div class="secret-input"><input id="setting-key" name="apiKey" type="password" value="" ${config.hasApiKey ? `placeholder="已配置；留空保持不变"` : "required"}><button type="button" id="toggle-key" aria-label="显示 API Key" title="显示 API Key"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.7"/></svg></button></div><small>${config.hasApiKey ? "API Key 已配置；留空不会覆盖，输入新值才会替换。" : "API Key 只保存在服务器本机，不会返回浏览器。"}</small></div><div class="field"><label for="setting-base">Base URL</label><input id="setting-base" name="baseUrl" value="${escapeHtml(config.baseUrl || "")}"></div></div>` : "";
      const toggle = apiFields.querySelector("#toggle-key"), keyInput = apiFields.querySelector("#setting-key");
      if (toggle) toggle.onclick = () => { const visible = keyInput.type === "text"; keyInput.type = visible ? "password" : "text"; toggle.setAttribute("aria-label", visible ? "显示 API Key" : "隐藏 API Key"); toggle.title = visible ? "显示 API Key" : "隐藏 API Key"; };
    };
    miner.onchange = renderApiSettings; renderApiSettings();
    card.querySelector("#settings-form").onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget, button = form.querySelector("button[type=submit]");
      const values = Object.fromEntries(new FormData(form).entries());
      values.windowDays = Number(values.windowDays); values.keepToolPairs = Number(values.keepToolPairs); values.contextWindowTokens = values.contextWindowTokens ? Number(values.contextWindowTokens) : 0;
      button.disabled = true; button.textContent = "正在保存…";
      try {
        const result = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
        library.libraryName = result.config.libraryName;
        const workspace=document.querySelector(".workspace"),title=workspace?.querySelector(".workspace-memory-card h1");
        if(workspace)workspace.dataset.libraryName=result.config.libraryName;
        if(title?.firstChild)title.firstChild.nodeValue=result.config.libraryName;
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
  } catch (error) {
    if(renderVersion!==settingsRenderVersion||!main.isConnected)return;
    const card=main.querySelector(".section-card");
    if(card)card.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    else showToast(error.message,"error");
  }
}

const rebuildState = { windowDays: 1, toolPairs: 15, watermark: false, summaryMode: "default", summaryLimit: 0, minImportance: 0, mcpDefault: false, page: 1, toolPage: 1, tab: "messages", excludedMessages: new Set(), excludedTools: new Set(), preview: null, bindingId: null, bindingMemoryId: null, bindingRuntime: null };
const miningUi={threadId:null,selected:new Set(),page:1,reportPage:1,reportFilter:"all",monthPage:1,selectedDate:null,mode:null,apiProfile:"optimized",timer:null,targetedSelected:new Set(),targetedLastIndex:null};
const compressionUi={mode:"subagent",afterDays:90};

async function renderToolPolicy(library){
  document.querySelectorAll(".side-nav button").forEach(button=>button.classList.toggle("active",button.dataset.view==="maintenance"));
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`<div class="dashboard-head"><div><p class="eyebrow">Conversation cleaning</p><h1>全量对话清洗</h1><p class="lead">查出混进对话里的重复、注入和召回内容。原始 full 始终保留，清洗只影响前端浏览与后续挖掘。</p></div><button class="ghost" id="back-maintenance">返回记忆</button></div><div id="cleaning-workspace"><section class="section-card"><div class="empty">正在读取清洗设置…</div></section></div>`;
  main.querySelector("#back-maintenance").onclick=()=>renderManagement(library);
  try{
    let data=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/tool-policy`);
    const draw=()=>{
      const policy=data.policy||{},cleaning=policy.cleaning||{},anomalies=data.anomalies||null,defaults=data.alreadyFiltered||{},tools=data.observed||[],selected=policy.categories||{},log=data.filtered||{total:0,rows:[]};
      const filterLabels={exact_duplicate:"重复副本",injection_fragment:"注入片段",recall_block:"召回内容",rule_header:"规则头文本"};
      const group=(title,help,items,type)=>`<section class="anomaly-group"><div><h3>${title}</h3><p>${help}</p></div>${items.length?items.map(item=>`<label class="anomaly-candidate"><input type="checkbox" data-anomaly="${type}" data-id="${escapeHtml(item.id)}" ${((cleaning[type]||[]).some(rule=>rule.id===item.id))?"checked":""}><span><strong>${item.role==="user"?"用户消息":item.role==="assistant"?"助手消息":"未知角色"} · 发现 ${item.count} 处</strong><small>${escapeHtml(item.preview||"")}</small></span></label>`).join(""):`<div class="clean-result-ok">没有发现这一类异常</div>`}</section>`;
      const defaultCard=(id,title,bucket,{locked=false}={})=>`<label class="filter-default-card ${locked?"locked":""}"><input id="${id}" type="checkbox" ${locked?"checked disabled":bucket?.allowed?"":"checked"}><span><strong>${title}</strong><small>发现 ${bucket?.count||0} 条 · ${locked?"安全保护，始终过滤":bucket?.allowed?"已加入放行白名单":"当前继续过滤"}</small>${bucket?.samples?.[0]?`<em>${escapeHtml(bucket.samples[0])}</em>`:""}</span></label>`;
      const alreadyFiltered=anomalies?`<section class="section-card"><div class="section-title-row"><div><p class="eyebrow">当前过滤边界</p><h2>已被过滤部分</h2><p>这些内容原本就不会送去挖掘。取消“继续过滤”相当于加入白名单，以后允许进入对话库。</p></div></div><div class="filter-default-grid">${defaultCard("filter-memory-blocks","SM 注入的记忆块",defaults.memoryBlocks,{locked:true})}${defaultCard("filter-internal-records","运行时内部记录",defaults.internalRecords,{locked:true})}${defaultCard("filter-system-templates","轮询 / 唤醒 / 稳定指令",defaults.systemTemplates)}${defaultCard("filter-thinking","思考链",defaults.thinking)}${defaultCard("filter-rule-injections","带 stmem 规则头的文本",defaults.ruleInjections)}</div><details class="tool-whitelist"><summary><span><strong>工具事件白名单</strong><small>${tools.length} 种工具默认不进入对话库，可按工具单独放行</small></span><i>⌄</i></summary><div>${tools.length?`<div class="tool-policy-list">${tools.map((tool,index)=>`<article class="tool-policy-row" data-index="${index}"><div><strong>${escapeHtml(tool.name)}</strong><small>发现 ${tool.count} 条</small></div><label>以后如何处理<select class="tool-policy-mode"><option value="exclude" ${tool.rule.mode==="exclude"?"selected":""}>继续过滤</option><option value="event" ${tool.rule.mode==="event"?"selected":""}>作为可读事件放行</option><option value="call" ${tool.rule.mode==="call"?"selected":""}>只放行调用</option><option value="result" ${tool.rule.mode==="result"?"selected":""}>只放行结果</option><option value="both" ${tool.rule.mode==="both"?"selected":""}>调用与结果都放行</option></select></label><label>显示名称<input class="tool-policy-label" value="${escapeHtml(tool.rule.label||"")}" placeholder="例如：客厅音响说话"></label><label>保留字段<input class="tool-policy-fields" value="${escapeHtml((tool.rule.fields||[]).join(", "))}" placeholder="text, room"></label></article>`).join("")}</div>`:`<div class="empty">没有识别到工具事件</div>`}</div></details></section>`:"";
      document.querySelector("#cleaning-workspace").innerHTML=`<section class="section-card cleaning-detect"><div><p class="eyebrow">异常自检</p><h2>${anomalies?`已检查 ${anomalies.scannedMessages} 条当前可入库对话`:"先检查，再决定"}</h2><p>检测本身不会修改内容，并会把“原本已过滤”和“仍在库里的异常”分开。</p></div><button class="primary" id="detect-conversation-anomalies">${anomalies?"重新检测":"开始异常检测"}</button></section>${alreadyFiltered}${anomalies?`<section class="section-card anomaly-results"><div><p class="eyebrow">新增过滤候选</p><h2>仍在对话库里的异常</h2><p>以下内容目前没有被系统过滤。只有勾选后，才会成为新的过滤黑名单。</p></div>${group("完全重复的文本","选中后保留最早一条，后续完全相同的副本不再进入对话库。",anomalies.exactDuplicates||[],"exactDuplicates")}${group("重复注入片段","选中后只剥离同质化注入段，同一条消息里的真实对话继续保留。",anomalies.injectionFragments||[],"injectionFragments")}${group("召回型文本","选中后识别对应召回头，剥离其后的旧记忆拼接内容。",anomalies.recallBlocks||[],"recallHeaders")}</section>`:""}<section class="section-card"><div class="section-title-row"><div><h2>自定义过滤规则头</h2><p>一行一种明确的开头标记。命中的整条注入消息以后不进入对话库。</p></div></div><textarea class="rule-header-input" id="custom-rule-headers" placeholder="例如：<!-- my-agent-rule -->&#10;例如：[SYSTEM INJECTION]">${escapeHtml((cleaning.customRuleHeaders||[]).join("\n"))}</textarea></section><details class="section-card filtered-archive"><summary><span><strong>用户规则过滤档案</strong><small>共 ${log.total||0} 条；系统默认过滤的样例在上方查看，全部原文仍保存在 full</small></span><i>⌄</i></summary><div>${(log.rows||[]).length?(log.rows||[]).map(row=>`<article><div><strong>${escapeHtml({exact_duplicate:"重复副本",injection_fragment:"注入片段",recall_block:"召回内容",rule_header:"规则头文本"}[row.category]||row.category)}</strong><time>${escapeHtml(formatBeijingTime(row.timestamp))}</time></div><p>${escapeHtml(row.originalText)}</p></article>`).join(""):`<div class="empty">还没有用户规则过滤记录</div>`}</div></details><div id="cleaning-plan"></div><div class="cleaning-savebar"><span>${anomalies?"先预览这次会影响哪些内容，再二次确认。":"请先完成一次异常检测。"}</span><button class="primary" id="apply-tool-policy" ${anomalies?"":"disabled"}>预览规则影响</button></div>`;
      const anomalyResults=main.querySelector(".anomaly-results");
      if(anomalyResults){
        anomalyResults.firstElementChild.insertAdjacentHTML("afterend",`<div class="candidate-selection-toolbar"><span id="candidate-selection-count">尚未选择候选</span><div><button class="ghost" data-pick-candidates="all">全选</button><button class="ghost" data-pick-candidates="exactDuplicates">选择重复文本</button><button class="ghost" data-pick-candidates="injectionFragments">选择注入片段</button><button class="ghost" data-pick-candidates="recallHeaders">选择召回文本</button><button class="ghost" data-pick-candidates="clear">清空</button></div></div>`);
        const updateCandidateSelection=()=>{const count=main.querySelectorAll("[data-anomaly]:checked").length,total=main.querySelectorAll("[data-anomaly]").length;main.querySelector("#candidate-selection-count").textContent=count?`已选择 ${count}/${total} 项候选`:`尚未选择候选 · 共 ${total} 项`;const apply=main.querySelector("#apply-tool-policy");if(apply)apply.textContent=count?`预览所选 ${count} 项影响`:"预览规则影响";};
        main.querySelectorAll("[data-anomaly]").forEach(input=>input.onchange=updateCandidateSelection);
        anomalyResults.querySelectorAll("[data-pick-candidates]").forEach(button=>button.onclick=()=>{const mode=button.dataset.pickCandidates;main.querySelectorAll("[data-anomaly]").forEach(input=>{if(mode==="clear")input.checked=false;else if(mode==="all"||input.dataset.anomaly===mode)input.checked=true;});updateCandidateSelection();});
        updateCandidateSelection();
      }
      const archive=main.querySelector(".filtered-archive"),archivedRules=log.groups||[];
      archive.innerHTML=`<summary><span><strong>用户规则过滤档案</strong><small>累计命中 ${log.total||0} 条 · ${archivedRules.length} 条规则；完整原文仍保存在 full</small></span><i>⌄</i></summary><div>${archivedRules.length?`<div class="candidate-selection-toolbar"><span>可批量选择需要撤销的规则</span><div><button class="ghost" id="select-all-unfilter">全选</button><button class="ghost" id="clear-unfilter">清空</button></div></div>`:""}${archivedRules.length?archivedRules.map((item,index)=>`<label class="anomaly-candidate filter-rule-record"><input type="checkbox" class="unfilter-rule-select" data-index="${index}"><span><strong>${escapeHtml(filterLabels[item.category]||item.category)} · 命中 ${item.count} 条</strong><time>最近 ${escapeHtml(formatBeijingTime(item.lastTimestamp))}</time><small>${escapeHtml(item.sample||"")}</small></span></label>`).join(""):`<div class="empty">还没有用户规则过滤记录</div>`}${archivedRules.length?`<div class="wizard-actions"><span id="unfilter-selection-count">尚未选择规则</span><button class="ghost" id="unfilter-selected" disabled>取消所选过滤</button></div>`:""}</div>`;
      const unfilterButton=archive.querySelector("#unfilter-selected"),unfilterCount=archive.querySelector("#unfilter-selection-count");
      const selectedUnfilterRules=()=>[...archive.querySelectorAll(".unfilter-rule-select:checked")].map(input=>archivedRules[Number(input.dataset.index)]).filter(Boolean).map(item=>({category:item.category,ruleId:item.ruleId}));
      const updateUnfilterSelection=()=>{const count=selectedUnfilterRules().length;unfilterButton.disabled=!count;unfilterCount.textContent=count?`已选择 ${count}/${archivedRules.length} 条规则`:`尚未选择规则 · 共 ${archivedRules.length} 条`;};
      archive.querySelector("#select-all-unfilter")?.addEventListener("click",()=>{archive.querySelectorAll(".unfilter-rule-select").forEach(input=>{input.checked=true;});updateUnfilterSelection();});
      archive.querySelector("#clear-unfilter")?.addEventListener("click",()=>{archive.querySelectorAll(".unfilter-rule-select").forEach(input=>{input.checked=false;});updateUnfilterSelection();});
      archive.querySelectorAll(".unfilter-rule-select").forEach(input=>input.onchange=updateUnfilterSelection);
      if(unfilterButton)updateUnfilterSelection();
      if(unfilterButton)unfilterButton.onclick=async()=>{
        const rules=selectedUnfilterRules();unfilterButton.disabled=true;unfilterButton.textContent="正在预览…";
        try{
          const preview=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/tool-policy?action=unfilter-preview`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rules})}),plan=preview.plan;
          main.querySelector("#cleaning-plan").innerHTML=`<section class="section-card cleaning-plan-card"><div><p class="eyebrow">批量取消过滤预览</p><h2>将撤销 ${plan.rules.length} 条规则，恢复 ${plan.recoverable} 条对话</h2><p>所选规则共有 ${plan.logged} 条命中记录。同一条对话被多条规则切分时只恢复一次；其他未选规则仍会继续生效，raw full 不会修改。</p></div><div class="wizard-actions"><button class="ghost" id="cancel-unfilter">返回修改</button><button class="primary" id="confirm-unfilter">确认批量取消</button></div></section>`;
          main.querySelector("#cancel-unfilter").onclick=()=>{main.querySelector("#cleaning-plan").innerHTML="";unfilterButton.disabled=false;unfilterButton.textContent="取消所选过滤";};
          main.querySelector("#confirm-unfilter").onclick=async()=>{const confirm=main.querySelector("#confirm-unfilter");confirm.disabled=true;confirm.textContent="正在恢复…";try{const result=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/tool-policy?action=unfilter`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rules,confirmedPlan:plan.token})});showToast(`已撤销 ${result.removedRules||0} 条规则并恢复 ${result.restored||0} 条对话`);await renderToolPolicy(library);}catch(error){showToast(error.message,"error");confirm.disabled=false;confirm.textContent="确认批量取消";}};
        }catch(error){showToast(error.message,"error");unfilterButton.disabled=false;unfilterButton.textContent="取消所选过滤";}
      };
      main.querySelector("#detect-conversation-anomalies").onclick=async()=>{const button=main.querySelector("#detect-conversation-anomalies");button.disabled=true;button.textContent="正在检查…";try{const detected=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/tool-policy?action=detect`);data={...data,...detected,filtered:data.filtered};draw();}catch(error){showToast(error.message,"error");button.disabled=false;button.textContent="重新检测";}};
      main.querySelector("#apply-tool-policy").onclick=async()=>{
        const button=main.querySelector("#apply-tool-policy");button.disabled=true;button.textContent="正在计算影响…";
        const next={version:1,categories:{systemTemplates:!main.querySelector("#filter-system-templates")?.checked,thinking:!main.querySelector("#filter-thinking")?.checked,ruleInjections:!main.querySelector("#filter-rule-injections")?.checked},tools:{...policy.tools},cleaning:{exactDuplicates:[],injectionFragments:[],recallHeaders:[],customRuleHeaders:main.querySelector("#custom-rule-headers").value.split("\n").map(value=>value.trim()).filter(Boolean)}};
        const maps={exactDuplicates:new Map((anomalies?.exactDuplicates||[]).map(item=>[item.id,item])),injectionFragments:new Map((anomalies?.injectionFragments||[]).map(item=>[item.id,item])),recallHeaders:new Map((anomalies?.recallBlocks||[]).map(item=>[item.id,item]))};
        main.querySelectorAll("[data-anomaly]:checked").forEach(input=>{const type=input.dataset.anomaly,item=maps[type].get(input.dataset.id);if(!item)return;if(type==="exactDuplicates")next.cleaning[type].push({id:item.id,role:item.role,text:item.text});if(type==="injectionFragments")next.cleaning[type].push({id:item.id,role:item.role,normalized:item.normalized,sample:item.sample});if(type==="recallHeaders")next.cleaning[type].push({id:item.id,role:item.role,header:item.header});});
        main.querySelectorAll(".tool-policy-row").forEach((row,index)=>{const item=tools[index];next.tools[item.name]={mode:row.querySelector(".tool-policy-mode").value,label:row.querySelector(".tool-policy-label").value.trim(),fields:row.querySelector(".tool-policy-fields").value.split(",").map(value=>value.trim()).filter(Boolean)};});
        try{
          const preview=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/tool-policy?action=plan`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(next)}),plan=preview.plan;
          const samples=(plan.samples||[]).map(item=>`<article><strong>${item.action==="remove"?"整条不入库":"剥离片段后保留正文"}</strong><small>${escapeHtml(item.before)}</small>${item.action!=="remove"?`<b>清洗后</b><small>${escapeHtml(item.after)}</small>`:""}</article>`).join("");
          main.querySelector("#cleaning-plan").innerHTML=`<section class="section-card cleaning-plan-card"><div><p class="eyebrow">应用前预览</p><h2>将移除 ${plan.removed} 条，剥离 ${plan.cleaned} 条</h2><p>本次扫描 ${plan.scanned} 条现有对话；当前白名单内容 ${plan.supplementalCurrent||0} 条，应用后预计放行 ${plan.supplementalSelected||0} 条。规则也会继续作用于以后。</p></div>${samples?`<details><summary>查看命中样例</summary><div>${samples}</div></details>`:"<div class=\"clean-result-ok\">当前没有普通对话会被修改；新规则或白名单只影响对应内容。</div>"}<div class="wizard-actions"><button class="ghost" id="cancel-cleaning-plan">返回修改</button><button class="primary" id="confirm-cleaning-plan">确认应用这些规则</button></div></section>`;
          main.querySelector("#cancel-cleaning-plan").onclick=()=>{main.querySelector("#cleaning-plan").innerHTML="";button.disabled=false;button.textContent="预览规则影响";};
          main.querySelector("#confirm-cleaning-plan").onclick=async()=>{const confirmButton=main.querySelector("#confirm-cleaning-plan");confirmButton.disabled=true;confirmButton.textContent="正在应用…";try{const result=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/tool-policy`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...next,confirmedPlan:plan.token})});showToast(`清洗完成：移除 ${result.removedConversations||0} 条，剥离 ${result.cleanedConversations||0} 条`);await renderToolPolicy(library);}catch(error){showToast(error.message,"error");confirmButton.disabled=false;confirmButton.textContent="确认应用这些规则";}};
          button.textContent="已生成预览";
        }catch(error){showToast(error.message,"error");button.disabled=false;button.textContent="预览规则影响";}
      };
    };
    draw();
  }catch(error){document.querySelector("#cleaning-workspace").innerHTML=`<section class="section-card"><div class="empty">${escapeHtml(error.message)}</div></section>`;}
}

async function renderCompression(library,kind="compact",report=null) {
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`<div class="dashboard-head"><div><p class="eyebrow">Memory lifecycle</p><h1>记忆压缩</h1><p class="lead">先查看系统建议，再决定是否精简或隐藏；完整摘要内容始终保留在 SQLite 中。</p></div><button class="ghost" id="back-maintenance">返回记忆</button></div><section class="compression-mode-grid"><button class="${kind==="compact"?"active":""}" data-compression-kind="compact"><strong>摘要精简</strong><span>将适合压缩的 daily 摘要改为 coarse，保留日期、事实与关键感受</span></button><button class="${kind==="hidden"?"active":""}" data-compression-kind="hidden"><strong>长期隐藏</strong><span>将长期沉寂的 coarse 摘要停止注入线程，不删除完整内容</span></button></section><section class="section-card compression-control"><div><p class="eyebrow">${kind==="compact"?"推荐窗口":"沉寂检查"}</p><h2>${kind==="compact"?"寻找低风险、高收益的一周":"检查长期不再出现的事实"}</h2><p>${kind==="compact"?"系统综合锚点、关系阶段、副核心与 importance 排序；预览不会调用模型。":"默认只检查核心词至少 90 天未再出现的 coarse 摘要；锚点和仍由 relation 接管的摘要受保护。"}</p></div>${kind==="compact"?`<label>执行通道<select id="compression-mode"><option value="subagent" ${compressionUi.mode==="subagent"?"selected":""}>Subagent</option><option value="api" ${compressionUi.mode==="api"?"selected":""}>API</option></select></label>`:`<label>沉寂阈值<div class="compact-number"><input id="hidden-days" type="number" min="1" max="3650" value="${compressionUi.afterDays}"><span>天</span></div></label>`}<button class="primary" id="preview-compression">生成压缩建议</button></section><div id="compression-report">${report?renderCompressionReport(kind,report):""}</div>`;
  main.querySelector("#back-maintenance").onclick=()=>renderManagement(library);
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
  main.innerHTML=`<div class="dashboard-head"><div><p class="eyebrow">对话维护</p><h1>对话导入</h1><p class="lead">支持 Claude Code、Claude.ai、Codex、ChatGPT 官方导出、通用 JSON/JSONL 和 SQLite；确认识别结果后再写入当前记忆体。</p></div><button class="ghost" id="back-maintenance">返回记忆</button></div><section class="section-card"><div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="上传对话文件"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 002 2h10a2 2 0 002-2v-4"/></svg><strong>把文件拖到这里</strong><p>或者点击打开文件资源管理器</p><button class="secondary" type="button">选择文件</button><input id="file-input" type="file" accept=".json,.jsonl,.db,.sqlite,.sqlite3" multiple hidden></div><div class="import-list" id="import-list"></div><div class="wizard-actions"><span></span><button class="primary" id="apply-import" disabled>导入当前记忆体</button></div></section>`;
  const input=main.querySelector("#file-input"),zone=main.querySelector("#dropzone"),apply=main.querySelector("#apply-import");
  const receive=async files=>{await uploadFiles(files);apply.disabled=!state.imports.length;apply.textContent=state.imports.length?`导入 ${state.imports.length} 个文件`:"导入当前记忆体";};
  zone.onclick=event=>{if(event.target.tagName!=="INPUT")input.click();};
  zone.onkeydown=event=>{if(["Enter"," "].includes(event.key)){event.preventDefault();input.click();}};
  zone.ondragover=event=>{event.preventDefault();zone.classList.add("dragging");};
  zone.ondragleave=()=>zone.classList.remove("dragging");
  zone.ondrop=event=>{event.preventDefault();zone.classList.remove("dragging");receive(event.dataTransfer.files);};
  input.onchange=()=>receive(input.files);
  main.querySelector("#back-maintenance").onclick=()=>renderManagement(library);
  apply.onclick=async()=>{
    apply.disabled=true;apply.textContent="正在导入…";
    try{
      const result=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/imports`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({importTokens:state.imports.map(item=>item.token)})});
      state.imports=[];showToast(`已导入 ${result.imported} 条纯对话`);renderManagement(library);
    }catch(error){showToast(error.message,"error");apply.disabled=false;apply.textContent=`导入 ${state.imports.length} 个文件`;}
  };
  renderImports();
}

function miningStatusLabel(row){return row.status==="completed"?"已完成":row.status==="completed_empty"?"无需记录":row.status==="running"?"正在挖掘":row.status==="partial_failed"?"部分分块待补挖":row.status==="failed"?"失败":"尚未挖掘";}
function miningRecoveryText(chunk){
  if(chunk.recoveryStatus==="format_repaired")return "JSON 格式已由 Subagent 修复并入库";
  if(chunk.recoveryStatus==="subagent_takeover")return "API 格式无法修复，已由 Subagent 接管并入库";
  return "";
}

async function renderMining(library,page=1) {
  if(miningUi.threadId!==library.threadId){miningUi.threadId=library.threadId;miningUi.selected.clear();miningUi.targetedSelected.clear();miningUi.targetedLastIndex=null;miningUi.page=1;miningUi.reportPage=1;miningUi.reportFilter="all";miningUi.monthPage=1;miningUi.selectedDate=null;miningUi.mode=null;miningUi.apiProfile="optimized";}
  clearTimeout(miningUi.timer);miningUi.page=page;
  document.querySelectorAll(".side-nav button").forEach(button=>button.classList.toggle("active",button.dataset.view==="maintenance"));
  const main=document.querySelector("#workspace-main");
  main.innerHTML=`<div class="dashboard-head"><div><p class="eyebrow">记忆维护</p><h1>记忆挖掘</h1><p class="lead">查看每天从对话中留下的摘要与特征。</p><p class="mining-first-run"><strong>第一次重建线程前需要挖掘全量对话；此后可通过“自动挖掘全量对话 / 自动执行记忆挖掘”让系统自行维护。</strong></p></div><button class="ghost" id="back-maintenance">返回记忆</button></div><div id="mining-content"><section class="section-card"><div class="empty">正在读取挖掘结果…</div></section></div>`;
  main.querySelector("#back-maintenance").onclick=()=>{clearTimeout(miningUi.timer);renderManagement(library);};
  try{
    const [data,config]=await Promise.all([api(`/api/libraries/${encodeURIComponent(library.threadId)}/mining/status`),miningUi.mode?Promise.resolve(null):api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`)]);
    if(!miningUi.mode)miningUi.mode=config?.minerMode==="api"?"api":"subagent";
    const job=data.job,active=job&&["queued","running","cancelling"].includes(job.status),matchesFilter=row=>miningUi.reportFilter==="pending"?!["completed","completed_empty","failed","partial_failed"].includes(row.status):miningUi.reportFilter==="completed"?["completed","completed_empty"].includes(row.status):miningUi.reportFilter==="failed"?["failed","partial_failed"].includes(row.status):true,reports=data.dates.filter(matchesFilter),reportPageSize=8,reportTotalPages=Math.max(1,Math.ceil(reports.length/reportPageSize));
    miningUi.reportPage=Math.min(Math.max(1,miningUi.reportPage),reportTotalPages);const reportRows=reports.slice((miningUi.reportPage-1)*reportPageSize,miningUi.reportPage*reportPageSize);
    if(!miningUi.selectedDate)miningUi.selectedDate=data.dates[0]?.date||null;
    const detail=miningUi.selectedDate?await api(`/api/libraries/${encodeURIComponent(library.threadId)}/mining/day?date=${miningUi.selectedDate}`):{feelings:[],features:[]};
    const progress=job?.dates?.length?Math.round((job.completed/job.dates.length)*100):0,calendar=miningCalendarData(data.dates,miningUi.monthPage);miningUi.monthPage=calendar.page;
    const jobHtml=job?`<div class="mining-progress ${job.status.includes("error")||job.status==="failed"?"has-errors":""}"><div class="mining-progress-head"><div><strong>${job.status==="cancelling"?"正在停止挖掘":active?`正在挖掘 ${job.currentDate||"准备中"}`:job.status==="cancelled"?"本次挖掘已停止":job.status==="completed"?"本次挖掘已完成":"本次挖掘完成，部分日期失败"}</strong><span>${job.completed} / ${job.dates.length} 天 · ${job.mode==="api"?`API（${job.apiProfile==="optimized"?"优化版":"原始版"}）`:"Subagent"}</span></div><div class="mining-progress-side"><b>${progress}%</b>${active?`<button class="danger-link" id="stop-mining" ${job.status==="cancelling"?"disabled":""}>停止挖掘</button>`:""}</div></div><div class="progress-track"><i style="width:${progress}%"></i></div>${job.results.some(row=>row.status==="failed")?`<details><summary>查看失败日期</summary>${job.results.filter(row=>row.status==="failed").map(row=>`<p>${escapeHtml(row.date)}：${escapeHtml(row.error)}</p>`).join("")}</details>`:""}</div>`:"";
    const dayClass=day=>!day.row?"mining-none":day.row.feelingCount>0?(day.row.feelingCount>=10?"mining-deep":"mining-light"):["failed","partial_failed"].includes(day.row.status)?"mining-failed":day.row.status==="running"?"mining-running":["completed","completed_empty"].includes(day.row.status)?"mining-light":"mining-pending";
    const calendarHtml=calendar.days.length?`<div class="mining-calendar"><div class="calendar-head"><button class="calendar-arrow" id="mining-newer" ${calendar.page<=1?"disabled":""}>‹</button><div><strong>${calendar.month.replace("-"," 年 ")} 月</strong><span>每天留下的记忆颜色</span></div><button class="calendar-arrow" id="mining-older" ${calendar.page>=calendar.totalPages?"disabled":""}>›</button></div><div class="calendar-weekdays">${["日","一","二","三","四","五","六"].map(day=>`<span>${day}</span>`).join("")}</div><div class="calendar-days">${Array.from({length:calendar.leadingBlanks},()=>'<span class="calendar-blank"></span>').join("")}${calendar.days.map(day=>`<button class="calendar-day ${dayClass(day)} ${day.date===miningUi.selectedDate?"selected":""}" data-mining-date="${day.date}" ${day.row?"":"disabled"} title="${day.date}${day.row?` · ${miningStatusLabel(day.row)} · ${day.row.feelingCount} 条摘要`:" · 无对话"}"></button>`).join("")}</div><div class="mining-legend"><span><i class="mining-none"></i>无对话</span><span><i class="mining-pending"></i>未挖掘</span><span><i class="mining-light"></i>&lt;10 摘要</span><span><i class="mining-deep"></i>≥10 摘要</span></div></div>`:"";
    const reportHtml=reports.length?`${reportRows.map(row=>{const completed=["completed","completed_empty"].includes(row.status),failed=["failed","partial_failed"].includes(row.status),chunks=(row.chunkReport||[]).map(chunk=>{const engine=chunk.channel==="api"?[chunk.provider,chunk.model].filter(Boolean).join(" / "):[chunk.channel==="subagent"?"Subagent":chunk.channel,chunk.runtime].filter(Boolean).join(" / "),recovery=miningRecoveryText(chunk);return `<li>${escapeHtml(chunk.timeLabel||`第 ${chunk.index} 块`)} · ${chunk.messageCount||0} 条 / ${Math.round((chunk.inputBytes||0)/1024)}KB → ${chunk.outputCount||0} 条摘要${chunk.empty?"（明确返回空数组）":""}${engine?` · ${escapeHtml(engine)}`:""}${recovery?` · <strong>${escapeHtml(recovery)}</strong>`:""}</li>`;}).join("");return `<article class="mining-report ${row.date===miningUi.selectedDate?"active":""} ${failed?"failed":""}"><label class="mining-report-check" title="${completed?"选择这个日期重新挖掘":"选择这个日期进行挖掘"}"><input type="checkbox" value="${row.date}" ${miningUi.selected.has(row.date)?"checked":""} ${active?"disabled":""}></label><div class="mining-report-open" data-report-date="${row.date}"><span><strong>${formatChineseDate(row.date)}</strong><small>${row.status==="partial_failed"?`部分分块待补挖${row.errorMessage?` · ${escapeHtml(row.errorMessage)}`:""}`:row.status==="failed"?`挖掘失败${row.errorMessage?` · ${escapeHtml(row.errorMessage)}`:""}`:row.status==="pending"?`尚未挖掘 · 共 ${row.messageCount} 条对话`:row.status==="completed_empty"?`共 ${row.messageCount} 条对话，本次返回 0 条摘要（已按成功处理）`:`共 ${row.messageCount} 条对话，挖掘出 ${row.feelingCount} 条摘要、${row.featureCount} 条特征`}</small>${chunks?`<details class="mining-chunk-report"><summary>查看 ${row.chunkReport.length} 个分块结果</summary><ul>${chunks}</ul></details>`:""}</span><time>${row.updatedAt?escapeHtml(formatBeijingTime(row.updatedAt)):miningStatusLabel(row)}</time></div></article>`;}).join("")}${pagination({page:miningUi.reportPage,totalPages:reportTotalPages})}`:'<div class="empty">当前筛选下没有日期。</div>';
    const categories=[...new Set(detail.features.map(row=>row.category))].map(category=>`<span class="badge">${escapeHtml(category)} ${detail.features.filter(row=>row.category===category).length}</span>`).join("");
    const detailHtml=miningUi.selectedDate?`<section class="section-card mining-results"><div class="section-title-row"><div><p class="eyebrow">${formatChineseDate(miningUi.selectedDate)}</p><h2>当天挖出的摘要</h2></div><div class="mining-result-actions"><span>${categories}</span><button class="secondary" id="open-targeted" ${active?"disabled":""}>精准补挖</button></div></div><p class="memory-anchor-guide">选择【原文锚点】，将在线程中注入该摘要对应原文；选择【事件锚点】，则该摘要不受衰减模型影响；选择【隐藏摘要】，线程重建时该摘要将不注入线程。</p><div id="targeted-panel"></div>${detail.feelings.length?detail.feelings.map((row,index)=>feelingCard(row,index,"daySeq")).join(""):'<div class="empty">这一天尚未生成摘要，或本次挖掘没有需要记录的内容。</div>'}<div id="feeling-editor"></div></section>`:"";
    const content=main.querySelector("#mining-content");
    content.innerHTML=`${jobHtml}<div id="mining-check-result"></div><section class="section-card mining-overview"><div class="mining-overview-grid">${calendarHtml}<div class="mining-report-list"><div class="section-title-row mining-report-title"><div><p class="eyebrow">按日管理</p><h2>每日挖掘状态</h2></div><div class="mining-status-filters">${[["all","全部"],["pending","待挖掘"],["completed","已完成"],["failed","失败"]].map(([value,label])=>`<button class="filter-chip ${miningUi.reportFilter===value?"active":""}" data-mining-filter="${value}">${label}</button>`).join("")}</div></div><div class="mining-report-actions"><select id="mining-mode" ${active?"disabled":""}><option value="subagent" ${miningUi.mode==="subagent"?"selected":""}>Subagent</option><option value="api" ${miningUi.mode==="api"?"selected":""}>API</option></select>${miningUi.mode==="api"?`<select id="mining-api-profile" ${active?"disabled":""}><option value="raw" ${miningUi.apiProfile==="raw"?"selected":""}>API（原始版）</option><option value="optimized" ${miningUi.apiProfile==="optimized"?"selected":""}>API（优化版）</option></select>`:""}<button class="ghost" id="check-mining" ${active||!miningUi.selectedDate?"disabled":""}>一键自检</button><button class="ghost" id="select-pending" ${active?"disabled":""}>全选未挖掘</button><button class="ghost" id="clear-dates" ${active?"disabled":""}>清空</button><span>已选 <strong id="selected-count">${miningUi.selected.size}</strong> 天</span><button class="primary" id="start-mining" ${active||!miningUi.selected.size?"disabled":""}>挖掘所选日期</button></div>${reportHtml}</div></div></section>${detailHtml}`;
    content.querySelector("#stop-mining")?.addEventListener("click",async event=>{event.currentTarget.disabled=true;event.currentTarget.textContent="正在停止…";try{await api(`/api/libraries/${encodeURIComponent(library.threadId)}/mining/stop`,{method:"POST"});showToast("已请求停止挖掘");renderMining(library,miningUi.page);}catch(error){showToast(error.message,"error");event.currentTarget.disabled=false;}});
    content.querySelectorAll("[data-mining-date],[data-report-date]").forEach(button=>button.onclick=()=>{miningUi.selectedDate=button.dataset.miningDate||button.dataset.reportDate;renderMining(library,miningUi.page);});
    content.querySelectorAll(".mining-chunk-report").forEach(details=>details.onclick=event=>event.stopPropagation());
    bindPagination(content.querySelector(".mining-report-list"),miningUi.reportPage,reportTotalPages,next=>{miningUi.reportPage=next;renderMining(library,miningUi.page);});
    content.querySelector("#mining-newer")?.addEventListener("click",()=>{miningUi.monthPage=calendar.page-1;renderMining(library,miningUi.page);});content.querySelector("#mining-older")?.addEventListener("click",()=>{miningUi.monthPage=calendar.page+1;renderMining(library,miningUi.page);});
    content.querySelector("#open-targeted")?.addEventListener("click",()=>renderTargetedMining(library,miningUi.selectedDate));
    if(miningUi.selectedDate)bindFeelingCards(content,library,detail.feelings,content.querySelector("#feeling-editor"),()=>renderMining(library,miningUi.page));
    const reportList=content.querySelector(".mining-report-list");
    const updateCount=()=>{reportList.querySelector("#selected-count").textContent=miningUi.selected.size;reportList.querySelector("#start-mining").disabled=active||!miningUi.selected.size;};
    reportList.querySelectorAll('.mining-report-check input').forEach(input=>input.onchange=()=>{input.checked?miningUi.selected.add(input.value):miningUi.selected.delete(input.value);updateCount();});
    reportList.querySelectorAll("[data-mining-filter]").forEach(button=>button.onclick=()=>{miningUi.reportFilter=button.dataset.miningFilter;miningUi.reportPage=1;renderMining(library,miningUi.page);});
    reportList.querySelector("#mining-mode").onchange=e=>{miningUi.mode=e.target.value;renderMining(library,miningUi.page);};
    reportList.querySelector("#mining-api-profile")?.addEventListener("change",e=>{miningUi.apiProfile=e.target.value;});
    reportList.querySelector("#check-mining").onclick=async event=>{
      const button=event.currentTarget,target=content.querySelector("#mining-check-result");button.disabled=true;button.textContent="正在自检…";
      target.innerHTML='<section class="section-card"><div class="empty">正在使用正式提示词和当天对话测试上游响应…</div></section>';
      try{
        const result=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/mining/check`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({date:miningUi.selectedDate,mode:miningUi.mode,apiProfile:miningUi.apiProfile})});
        const input=result.input||{},actual=result.actualResponse||{};
        target.innerHTML=`<section class="section-card mining-check ${result.ok?"":"has-errors"}"><div class="section-title-row"><div><p class="eyebrow">挖掘自检 · ${escapeHtml(miningUi.selectedDate)}</p><h2>${result.ok?"自检通过":"自检发现问题"} · ${escapeHtml(result.code||"UNKNOWN")}</h2></div><span class="badge">${escapeHtml(miningUi.mode==="api"?"API":"Subagent")}</span></div><p>${escapeHtml(result.reason||"")}</p><dl class="mining-check-grid"><div><dt>用途 / 提示词</dt><dd>${escapeHtml(input.scenario||input.purpose||"—")} · ${escapeHtml(input.promptSource||"—")}</dd></div><div><dt>分块输入</dt><dd>共 ${input.messageCount||0} 条 · ${input.chunkCount||0} 块${input.checkedChunk?` · 检查第 ${input.checkedChunk} 块 (${input.chunkBytes?.[input.checkedChunk-1]||0} bytes)`:""}</dd></div><div><dt>HTTP 状态</dt><dd>${actual.httpStatus||"—"} ${escapeHtml(actual.statusText||"")}</dd></div><div><dt>解析条数</dt><dd>${result.parsedCount??"—"}</dd></div></dl><details><summary>查看实际提示词与对话拼接</summary><h4>System prompt</h4><pre>${escapeHtml(input.systemPromptPreview||"")}</pre><h4>Conversation</h4><pre>${escapeHtml(input.conversationPreview||"")}</pre></details><details open><summary>查看上游实际返回内容</summary><pre>${escapeHtml(actual.content??actual.body??"（上游没有返回内容）")}</pre>${actual.body&&actual.content!==actual.body?`<details><summary>完整 HTTP 响应体</summary><pre>${escapeHtml(actual.body)}</pre></details>`:""}</details></section>`;
      }catch(error){target.innerHTML=`<section class="section-card"><div class="empty">${escapeHtml(error.message)}</div></section>`;}
      button.disabled=false;button.textContent="一键自检";
    };
    reportList.querySelector("#select-pending").onclick=()=>{data.dates.filter(row=>!["completed","completed_empty"].includes(row.status)).forEach(row=>miningUi.selected.add(row.date));renderMining(library,miningUi.page);};
    reportList.querySelector("#clear-dates").onclick=()=>{miningUi.selected.clear();renderMining(library,miningUi.page);};
    reportList.querySelector("#start-mining").onclick=async()=>{const button=reportList.querySelector("#start-mining"),dates=[...miningUi.selected],statusByDate=new Map(data.dates.map(row=>[row.date,row.status])),forceDates=dates.filter(date=>["completed","completed_empty"].includes(statusByDate.get(date)));if(forceDates.length&&!confirm(`${forceDates.length===1?formatChineseDate(forceDates[0]):`选中的 ${forceDates.length} 天`}已经挖掘过。是否重新挖掘？\\n\\n重挖成功后会覆盖对应日期原有的摘要与特征；包含锚点、手动编辑或压缩状态的日期不会被覆盖。`))return;button.disabled=true;try{await api(`/api/libraries/${encodeURIComponent(library.threadId)}/mining/start`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mode:miningUi.mode,apiProfile:miningUi.apiProfile,dates,forceDates})});miningUi.selected.clear();showToast("记忆挖掘已开始");renderMining(library,1);}catch(error){showToast(error.message,"error");button.disabled=false;}};
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
      target.innerHTML=data.matchCount?`<div class="targeted-summary">命中 ${data.matchCount} 条；请选择需要交给模型的完整对话范围。</div><div class="targeted-message-list">${data.rows.map((row,index)=>`<label class="select-row targeted-message ${row.matched?"matched":""}" data-targeted-index="${index}"><input type="checkbox" value="${escapeHtml(row.timestamp)}"><time>${escapeHtml(formatBeijingTime(row.timestamp))}</time><span class="role">${escapeHtml(conversationRole(row.role,library))}</span><span class="context">${escapeHtml(row.text)}</span></label>`).join("")}</div><div class="targeted-footer"><span>已选择 <strong id="targeted-count">0</strong> 条对话</span><div><select id="targeted-mode"><option value="subagent" ${miningUi.mode==="subagent"?"selected":""}>Subagent</option><option value="api" ${miningUi.mode==="api"?"selected":""}>API</option></select><select id="targeted-api-profile" class="${miningUi.mode==="api"?"":"hidden"}"><option value="raw" ${miningUi.apiProfile==="raw"?"selected":""}>API（原始版）</option><option value="optimized" ${miningUi.apiProfile==="optimized"?"selected":""}>API（优化版）</option></select><button class="primary" id="run-targeted" disabled>补挖所选对话</button></div></div>`:'<div class="empty">当天没有命中这个关键词。</div>';
      if(!data.matchCount)return;
      const inputs=[...target.querySelectorAll('.targeted-message input')],count=target.querySelector("#targeted-count"),run=target.querySelector("#run-targeted");
      target.querySelector("#targeted-mode").onchange=e=>{miningUi.mode=e.target.value;target.querySelector("#targeted-api-profile").classList.toggle("hidden",miningUi.mode!=="api");};
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
          await api(`/api/libraries/${encodeURIComponent(library.threadId)}/mining/targeted`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({date,mode:target.querySelector("#targeted-mode").value,apiProfile:target.querySelector("#targeted-api-profile")?.value||miningUi.apiProfile,timestamps:[...miningUi.targetedSelected]})});
          showToast("精准补挖完成，摘要已追加");await renderMining(library,miningUi.page);
        }catch(error){showToast(error.message,"error");run.disabled=false;run.textContent="补挖所选对话";}
      };
    }catch(error){target.innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`;}
  };
}

async function renderRebuild(library) {
  activateWorkspaceTab("context");
  const main = document.querySelector("#workspace-main");
  main.innerHTML = `<section class="context-management-grid"><article class="section-card context-status-card"><div class="section-title-row"><div><p class="eyebrow">Current context</p><h2>当前上下文</h2></div><span class="badge" id="context-runtime">正在读取</span></div><div id="context-binding-picker"></div><p class="context-thread-id" id="context-thread-id">正在读取当前线程…</p><div class="context-usage"><div class="context-usage-head"><strong>窗口占用</strong><small id="context-usage-label">正在读取…</small></div><div class="context-usage-track" role="progressbar" aria-label="当前窗口上下文占用" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="context-usage-bar" style="width:0%"></i></div></div><dl class="context-status-list"><div><dt>最近观测</dt><dd id="context-observed">暂无记录</dd></div><div><dt>上次重建</dt><dd id="context-rebuilt">暂无记录</dd></div><div><dt>线程文件</dt><dd id="context-thread-file">正在检查</dd></div></dl></article><article class="section-card context-injection-card"><div class="section-title-row"><div><p class="eyebrow">Current injection</p><h2>当前注入</h2></div><span class="badge" id="context-retention-mode">暂无记录</span></div><div class="context-injection-counts"><div><strong id="context-rules">0</strong><span>人设 / 规则</span></div><div><strong id="context-feelings">0</strong><span>摘要</span></div><div><strong id="context-messages">0</strong><span>近期与锚点原文</span></div><div><strong id="context-tools">0</strong><span>工具链</span></div></div><p class="context-injection-note" id="context-injection-note">生成第一次线程重建后，这里会显示实际注入构成。</p></article></section><section class="section-card rebuild-command-center context-operation-card"><div class="section-title-row"><div><p class="eyebrow">Context actions</p><h2>线程重建</h2><small>先预览将写入当前线程的内容，确认后才会应用。</small></div></div><div id="rebuild-target-slot"></div><div class="rebuild-primary-actions"><button class="primary rebuild-main-button" id="preview-rebuild"><strong>生成重建预览</strong><span>查看摘要、原文与工具链的预计结果</span></button><button class="secondary rebuild-main-button" id="check-thread"><strong>检查线程</strong><span>发现结构异常后再确认修复</span></button></div><div id="integrity"></div><details class="injection-settings"><summary><span class="settings-gear" aria-hidden="true">⚙</span><span><strong>高级注入设置</strong><small>调整摘要范围、近期上下文和工具链数量</small></span><i>⌄</i></summary><div class="injection-settings-body"><section><h3>摘要保留形式</h3><div class="choice-row"><label><input type="radio" name="summary-mode" value="default" ${rebuildState.summaryMode==="default"?"checked":""}><span><strong>默认</strong><small>注入全部非hidden历史摘要</small></span></label><label><input type="radio" name="summary-mode" value="limited" ${rebuildState.summaryMode==="limited"?"checked":""}><span><strong>特殊设置</strong><small>限定摘要数量和最低importance</small></span></label></div><div id="summary-limit-fields" class="inline-settings"><span>保留最近</span><input id="summary-limit" type="number" min="1" value="${rebuildState.summaryLimit||200}"><span>条 importance ≥</span><select id="min-importance">${[0,1,2,3,4,5].map(value=>`<option value="${value}" ${rebuildState.minImportance===value?"selected":""}>${value}</option>`).join("")}</select><span>的摘要</span></div><label id="mcp-default-row" class="rebuild-watermark-option compact-option"><input id="mcp-summary-default" type="checkbox" ${rebuildState.mcpDefault?"checked":""}><span><strong>MCP调用rebuild时默认使用这一摘要范围</strong><small>Agent显式传参时只覆盖当次调用。</small></span></label><p class="tool-memory-note"><span aria-hidden="true">●</span> 默认保护低importance的原文锚点与事件锚点；锚点占摘要名额，hidden不纳入计算。</p></section><section><h3>上下文保留形式</h3><div class="choice-row"><label><input type="radio" name="context-mode" value="days" ${rebuildState.watermark?"":"checked"}><span><strong>默认</strong><small>按最近发生过对话的活跃日保留原文</small></span></label><label><input type="radio" name="context-mode" value="watermark" ${rebuildState.watermark?"checked":""}><span><strong>特殊设置：水位线模式</strong><small>已挖掘出摘要的历史原文不再重复注入</small></span></label></div><div id="active-days-fields" class="inline-settings"><span>保留活跃对话日</span><input id="window-days" type="number" min="1" max="365" value="${rebuildState.windowDays}"><span>天，保留工具调用</span><input id="tool-pairs" type="number" min="0" max="500" value="${rebuildState.toolPairs}"><span>组</span></div><div id="watermark-fields" class="watermark-description"><p>已挖掘出摘要的历史原文不再进入近期注入范围；从最后一条摘要对应的原文开始保留。工具调用仍使用上方的统一设置。</p></div><p class="tool-memory-note"><span aria-hidden="true">●</span> 如果不保留工具链，Agent重建后会失去近期工具调用及其结果的上下文记忆。</p></section></div></details><div id="rebuild-dry-run"></div></section><section class="section-card context-trim-card"><div><p class="eyebrow">Danger zone</p><h2>永久裁剪</h2><p>选择要从活动线程、archive 和 full 中永久移除的对话或工具链。执行前仍会生成预览。</p></div><button class="danger-button" id="open-trim">裁剪对话 / 工具链</button></section>`;
  const operationCard=main.querySelector(".context-operation-card");
  const injectionSettings=operationCard.querySelector(".injection-settings");
  const dryRun=operationCard.querySelector("#rebuild-dry-run");
  const settingsParking=document.createElement("div");
  settingsParking.hidden=true;
  operationCard.after(dryRun,settingsParking);
  settingsParking.append(injectionSettings);
  operationCard.classList.remove("section-card","rebuild-command-center");
  operationCard.classList.add("context-action-strip");
  operationCard.querySelector(".rebuild-primary-actions").insertAdjacentHTML("beforeend",`<button class="secondary rebuild-main-button" id="open-injection-settings"><strong>注入策略</strong><span>设置摘要、原文和工具链范围</span></button>`);
  injectionSettings.open=true;
  injectionSettings.querySelector("summary strong").textContent="注入策略";
  injectionSettings.querySelector("summary small").textContent="设置下一次重建保留哪些摘要、原文和工具链";
  dryRun.hidden=true;
  main.insertAdjacentHTML("afterbegin",managementNav("context"));
  bindManagementNav(library);
  let contextOverview=library;
  const paintContext=(binding=null,{primary=false}={})=>{
    const legacyUsage=contextOverview.contextUsage||null,legacyRebuild=contextOverview.rebuild||null;
    const shownUsage=binding?(contextOverview.contextUsageByBinding?.[binding.id]||(primary?legacyUsage:null)):legacyUsage;
    const shownRebuild=binding?(contextOverview.rebuildByBinding?.[binding.id]||(primary?legacyRebuild:null)):legacyRebuild;
    const percent=shownUsage&&Number.isFinite(shownUsage.percent)?Math.max(0,Math.min(100,shownUsage.percent)):0;
    document.querySelector("#context-runtime").textContent=binding?.provider||contextOverview.runtime||"未接入平台";
    document.querySelector("#context-thread-id").textContent=binding?.externalThreadId||contextOverview.externalThreadId||"尚未绑定窗口";
    document.querySelector("#context-usage-label").textContent=contextUsageHint(shownUsage,contextOverview.automaticFullMining);
    document.querySelector("#context-usage-bar").style.width=`${percent.toFixed(1)}%`;
    document.querySelector(".context-usage-track").setAttribute("aria-valuenow",String(Math.round(percent)));
    document.querySelector("#context-observed").textContent=(shownUsage?.observedAt||shownUsage?.updatedAt)?formatBeijingTime(shownUsage.observedAt||shownUsage.updatedAt):"暂无记录";
    document.querySelector("#context-rebuilt").textContent=shownRebuild?.completedAt?formatBeijingTime(shownRebuild.completedAt):"该窗口暂无记录";
    document.querySelector("#context-thread-file").textContent=binding?(binding.resolvedThreadFile||binding.threadFile?"已定位":"等待定位"):(contextOverview.threadFileFound?"已定位":"未找到");
    document.querySelector("#context-rules").textContent=shownRebuild?.injectedRules||0;
    document.querySelector("#context-feelings").textContent=shownRebuild?.injectedFeelings||0;
    document.querySelector("#context-messages").textContent=(shownRebuild?.recentMessages||0)+(shownRebuild?.retainedMessages||0);
    document.querySelector("#context-tools").textContent=shownRebuild?.preservedToolPairs||0;
    document.querySelector("#context-retention-mode").textContent=shownRebuild?(shownRebuild.retentionMode==="watermark"?"水位线模式":"活跃日模式"):"暂无记录";
    document.querySelector("#context-injection-note").textContent=shownRebuild?`上次重建注入 ${shownRebuild.retainAnchors||0} 个原文锚点；高级设置只影响下一次重建。`:"这个窗口还没有可显示的线程重建记录。";
  };
  try {
    const [config,overview]=await Promise.all([
      api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`),
      api(`/api/libraries/${encodeURIComponent(library.threadId)}/overview`),
    ]);
    rebuildState.windowDays=config.windowDays;rebuildState.toolPairs=config.keepToolPairs;
    rebuildState.mcpDefault=config.mcpRebuildDefaultsEnabled===true;
    if(rebuildState.mcpDefault){
      rebuildState.summaryLimit=Math.max(0,Number(config.mcpSummaryLimit)||0);
      rebuildState.minImportance=Math.max(0,Number(config.mcpMinImportance)||0);
      rebuildState.summaryMode=rebuildState.summaryLimit||rebuildState.minImportance?"limited":"default";
    }
    document.querySelector("#window-days").value=rebuildState.windowDays;
    document.querySelector("#tool-pairs").value=rebuildState.toolPairs;
    document.querySelector("#summary-limit").value=rebuildState.summaryLimit||200;
    document.querySelector("#min-importance").value=String(rebuildState.minImportance);
    document.querySelector("#mcp-summary-default").checked=rebuildState.mcpDefault;
    document.querySelectorAll('input[name="summary-mode"]').forEach(input=>{input.checked=input.value===rebuildState.summaryMode;});
    contextOverview=overview;paintContext();
  } catch(error){showToast(error.message,"error");}
  try {
    const bindingStatus = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/bindings`);
    const bindingRows = (bindingStatus.bindings || []).filter(row => row.source !== "legacy-config" && row.mode !== "import_only");
    const previousTarget = rebuildState.bindingMemoryId === library.threadId ? rebuildState.bindingId : null;
    rebuildState.bindingId = bindingRows.some(row => row.id === previousTarget)
      ? previousTarget
      : bindingRows.some(row => row.id === bindingStatus.primaryBindingId)
        ? bindingStatus.primaryBindingId
        : bindingRows[0]?.id || null;
    rebuildState.bindingMemoryId = library.threadId;
    const slot = document.querySelector("#rebuild-target-slot"),picker=document.querySelector("#context-binding-picker");
    const selectBinding=id=>{
      const selected=bindingRows.find(row=>row.id===id)||bindingRows[0];if(!selected)return;
      rebuildState.bindingId=selected.id;
      rebuildState.bindingRuntime=selected.provider||null;
      if(picker?.querySelector("select"))picker.querySelector("select").value=selected.id;
      slot.innerHTML=`<div class="context-operation-target"><span>操作目标</span><strong>${escapeHtml(selected.provider||"未知平台")} · ${escapeHtml(String(selected.externalThreadId||"").slice(0,8))}</strong></div>`;
      paintContext(selected,{primary:selected.id===bindingStatus.primaryBindingId});
      document.querySelector("#rebuild-dry-run").innerHTML="";
      showIntegrity(library,false);
    };
    if(bindingRows.length>1){
      picker.innerHTML=`<label class="context-binding-select"><span>查看窗口</span><select>${bindingRows.map(row=>`<option value="${escapeHtml(row.id)}">${escapeHtml(row.provider||"未知平台")} · ${escapeHtml(String(row.externalThreadId||"").slice(0,8))}${row.id===bindingStatus.primaryBindingId?" · 主窗口":""}${row.enabled===false?" · 未监听":""}</option>`).join("")}</select></label>`;
      picker.querySelector("select").onchange=event=>selectBinding(event.target.value);
    }
    if(bindingRows.length)selectBinding(rebuildState.bindingId);
  } catch { /* Binding 列表读取失败时退回默认窗口重建 */ }
  const syncInjectionControls=()=>{
    const limited=rebuildState.summaryMode==="limited";
    document.querySelector("#summary-limit-fields").hidden=!limited;
    document.querySelector("#mcp-default-row").hidden=!limited;
    const windowInput=document.querySelector("#window-days");
    windowInput.disabled=rebuildState.watermark;
    windowInput.closest(".inline-settings")?.classList.toggle("is-watermark",rebuildState.watermark);
    document.querySelector("#watermark-fields").hidden=!rebuildState.watermark;
  };
  document.querySelectorAll('input[name="summary-mode"]').forEach(input=>input.onchange=event=>{rebuildState.summaryMode=event.target.value;if(rebuildState.summaryMode==="limited"&&!rebuildState.summaryLimit)rebuildState.summaryLimit=200;if(rebuildState.summaryMode==="default"){rebuildState.mcpDefault=false;document.querySelector("#mcp-summary-default").checked=false;}syncInjectionControls();});
  document.querySelectorAll('input[name="context-mode"]').forEach(input=>input.onchange=event=>{rebuildState.watermark=event.target.value==="watermark";syncInjectionControls();});
  document.querySelector("#window-days").onchange=event=>{rebuildState.windowDays=Math.max(1,Number(event.target.value)||1);};
  const syncTools=value=>{rebuildState.toolPairs=Math.max(0,Number(value)||0);document.querySelector("#tool-pairs").value=rebuildState.toolPairs;};
  document.querySelector("#tool-pairs").onchange=event=>syncTools(event.target.value);
  document.querySelector("#summary-limit").onchange=event=>{rebuildState.summaryLimit=Math.max(1,Number(event.target.value)||200);};
  document.querySelector("#min-importance").onchange=event=>{rebuildState.minImportance=Math.max(0,Math.min(5,Number(event.target.value)||0));};
  document.querySelector("#mcp-summary-default").onchange=event=>{rebuildState.mcpDefault=event.target.checked;};
  syncInjectionControls();
  const closeSettings=overlay=>{settingsParking.append(injectionSettings);overlay.remove();};
  document.querySelector("#open-injection-settings").onclick=()=>{
    const snapshot={summaryMode:rebuildState.summaryMode,summaryLimit:rebuildState.summaryLimit,minImportance:rebuildState.minImportance,mcpDefault:rebuildState.mcpDefault,watermark:rebuildState.watermark,windowDays:rebuildState.windowDays,toolPairs:rebuildState.toolPairs};
    const overlay=document.createElement("div");overlay.className="editor-overlay context-settings-overlay";
    overlay.innerHTML=`<section class="editor-panel context-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="context-settings-title"><button class="editor-close ghost" type="button" aria-label="关闭">×</button><div class="context-settings-dialog-head"><p class="eyebrow">REBUILD POLICY</p><h2 id="context-settings-title">注入策略</h2><p>设置以后线程重建默认保留的摘要、原文和工具链范围。</p></div><div class="context-settings-dialog-body"></div><div class="wizard-actions"><button class="ghost" id="cancel-injection-settings">取消</button><button class="primary" id="save-injection-settings">保存设置</button></div></section>`;
    overlay.querySelector(".context-settings-dialog-body").append(injectionSettings);document.body.append(overlay);
    const cancel=()=>{Object.assign(rebuildState,snapshot);closeSettings(overlay);renderRebuild(library);};
    overlay.querySelector(".editor-close").onclick=cancel;overlay.querySelector("#cancel-injection-settings").onclick=cancel;
    overlay.addEventListener("click",event=>{if(event.target===overlay)cancel();});
    overlay.querySelector("#save-injection-settings").onclick=async event=>{const button=event.currentTarget;button.disabled=true;button.textContent="正在保存…";try{const summaryLimit=rebuildState.summaryMode==="limited"?rebuildState.summaryLimit:0,minImportance=rebuildState.summaryMode==="limited"?rebuildState.minImportance:0;await api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({windowDays:rebuildState.windowDays,keepToolPairs:rebuildState.toolPairs,mcpRebuildDefaultsEnabled:rebuildState.mcpDefault,mcpSummaryLimit:summaryLimit,mcpMinImportance:minImportance})});closeSettings(overlay);showToast("注入策略已保存");}catch(error){showToast(error.message,"error");button.disabled=false;button.textContent="保存设置";}};
  };
  document.querySelector("#preview-rebuild").onclick = () => {
    const overlay=document.createElement("div");overlay.className="editor-overlay rebuild-preview-overlay";
    overlay.innerHTML=`<section class="editor-panel rebuild-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="rebuild-preview-title"><button class="editor-close ghost" type="button" aria-label="关闭">×</button><h2 id="rebuild-preview-title">线程重建预览</h2><div id="rebuild-preview-modal-content"></div></section>`;
    document.body.append(overlay);const close=()=>overlay.remove();overlay.querySelector(".editor-close").onclick=close;overlay.addEventListener("click",event=>{if(event.target===overlay)close();});
    previewIntegratedRebuild(library,{target:"#rebuild-preview-modal-content",button:"#preview-rebuild"});
  };
  document.querySelector("#check-thread").onclick = () => checkAndRepair(library);
  document.querySelector("#open-trim").onclick = () => renderTrimWorkbench(library);
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
  const windowInput=document.querySelector("#window-days"),toolInput=document.querySelector("#tool-pairs"),summaryLimitInput=document.querySelector("#summary-limit"),minImportanceInput=document.querySelector("#min-importance");
  if(windowInput)rebuildState.windowDays=Math.max(1,Number(windowInput.value)||1);
  if(toolInput)rebuildState.toolPairs=Math.max(0,Number(toolInput.value)||0);
  if(summaryLimitInput)rebuildState.summaryLimit=Math.max(1,Number(summaryLimitInput.value)||200);
  if(minImportanceInput)rebuildState.minImportance=Math.max(0,Math.min(5,Number(minImportanceInput.value)||0));
  const summaryLimit=rebuildState.summaryMode==="limited"?rebuildState.summaryLimit:0,minImportance=rebuildState.summaryMode==="limited"?rebuildState.minImportance:0;
  const button=document.querySelector(options.button||"#preview-rebuild"),target=document.querySelector(options.target||"#rebuild-dry-run");
  button.disabled=true;target.innerHTML='<div class="empty">正在生成线程重建预览…</div>';
  try {
    const request={summary:{mode:rebuildState.summaryMode,limit:summaryLimit,minImportance},context:{mode:rebuildState.watermark?"watermark":"active_days",windowDays:rebuildState.windowDays,toolPairs:rebuildState.toolPairs},trim:{excludedMessages:options.excludedMessages||[],excludedTools:options.excludedTools||[]},trigger:"web",bindingId:rebuildState.bindingMemoryId===library.threadId?rebuildState.bindingId:null};
    const preview=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rebuild/dry-run`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request)}),show=value=>value===null||value===undefined?"—":value;
    const retentionLabel=preview.retentionMode==="watermark"?`水位线模式，自 ${escapeHtml(preview.watermarkCutoff||"—")} 起`:preview.watermarkFallback?`活跃日模式（水位线定位失败，已回退）`:`活跃日模式`;
    target.innerHTML=`<div class="rebuild-preview"><div class="section-title-row"><div><p class="eyebrow">正式 Dry-run</p><h3>确认线程重建结果</h3></div><span class="badge">${preview.runtime==="codex"?"Codex":"Claude"}</span></div><div class="rebuild-preview-groups"><section><h4>数据来源</h4><dl><div><dt>full 原始消息</dt><dd>${show(preview.fullMessages??preview.originalMessages)} 条</dd></div><div><dt>full 总体积</dt><dd>${formatBytes(preview.fullArchiveBytes)}</dd></div><div><dt>保留方式</dt><dd>${retentionLabel}</dd></div><div><dt>活跃日设置</dt><dd>${show(preview.windowDays)} 天（普通模式或水位线回退时使用）</dd></div></dl></section><section><h4>摘要去向</h4><dl><div><dt>摘要总数</dt><dd>${show(preview.injectableFeelings)} 条（hidden 已排除）</dd></div><div><dt>历史候选</dt><dd>${show(preview.summaryCandidates)} 条 → 本次选择 ${show(preview.selectedSummaries)} 条</dd></div><div><dt>锚点保护</dt><dd>${show(preview.protectedSummaries)} 条${preview.protectedOverflow?`，超过限制 ${preview.protectedOverflow} 条`:""}</dd></div><div><dt>近期窗口内</dt><dd>${show(preview.inWindowFeelings)} 条，由近期原文承载</dd></div><div><dt>原文锚点替代</dt><dd>${show(preview.retainAnchors)} 条，覆盖 ${show(preview.retainDates)} 个日期</dd></div><div><dt>注入记忆块</dt><dd>${show(preview.memoryFeelings)} 条摘要</dd></div><div><dt>人设 / 规则</dt><dd>${show(preview.injectedRules)} 份</dd></div><div><dt>记忆块</dt><dd>${show(preview.memoryBlocks)} 个</dd></div></dl></section><section><h4>近期上下文</h4><dl><div><dt>近期原文</dt><dd>${show(preview.windowMessages)} 条</dd></div><div><dt>工具链</dt><dd>${show(preview.toolPairs)} 组${preview.toolIds==null?"":`，${preview.toolIds} 个工具 ID`}</dd></div>${preview.functionCalls==null?"":`<div><dt>函数调用</dt><dd>${preview.functionCalls} 条</dd></div>`}<div><dt>移除系统记录</dt><dd>${show(preview.systemDropped)} 条</dd></div></dl></section><section class="rebuild-result-group"><h4>预计结果</h4><dl><div><dt>线程文件大小</dt><dd>${formatBytes(preview.estimatedOutputBytes)}</dd></div><div><dt>重建后行数</dt><dd>${show(preview.outputLines)} 行</dd></div><div><dt>预计压缩率</dt><dd class="rebuild-reduction">${preview.reductionPercent==null?"—":`${preview.reductionPercent}%`}</dd></div></dl></section></div><details class="rebuild-raw-output"><summary>查看原始 dry-run 输出</summary><pre>${escapeHtml(preview.raw)}</pre></details><div class="wizard-actions"><button class="ghost" id="cancel-rebuild-preview">取消</button><button class="primary" id="apply-previewed-rebuild">确认应用线程重建</button></div></div>`;
    target.querySelector("#cancel-rebuild-preview").onclick=()=>{const overlay=target.closest(".editor-overlay");if(overlay)overlay.remove();else target.innerHTML="";};
    target.querySelector("#apply-previewed-rebuild").onclick=()=>applyIntegratedRebuild(library,{excludedMessages:options.excludedMessages||[],excludedTools:options.excludedTools||[]});
    const feelingSummary=document.querySelector("#rebuild-feeling-summary");
    const feelingDetail=document.querySelector("#rebuild-feeling-detail");
    if(feelingSummary&&preview.memoryFeelings!=null){
      feelingSummary.textContent=`本次预计注入 ${preview.memoryFeelings} 条摘要`;
    }
    if(feelingDetail){
      const selected=show(preview.selectedSummaries);
      const candidates=show(preview.summaryCandidates);
      const inWindow=show(preview.inWindowFeelings);
      const retained=show(preview.retainAnchors);
      const retainedLines=show(preview.retainedMessages);
      feelingDetail.textContent=`历史候选 ${candidates} 条，本次选择 ${selected} 条；其中 ${show(preview.memoryFeelings)} 条以摘要形式注入、${retained} 条原文锚点以原文形式注入（共占 ${retainedLines} 行）。近期窗口内另有 ${inWindow} 条摘要，由近期原文承载，不重复注入。`;
    }
  }catch(error){target.innerHTML=`<div class="integrity warning">${escapeHtml(error.message)}</div>`;}
  button.disabled=false;
}

async function applyIntegratedRebuild(library,{excludedMessages=[],excludedTools=[]}={}) {
  const button=document.querySelector("#apply-previewed-rebuild"),previewOverlay=button?.closest(".rebuild-preview-overlay"),isCodex=(rebuildState.bindingRuntime||library.runtime)==="codex";button.disabled=true;button.textContent=isCodex?"正在应用线程重建…":"正在排队线程重建…";
  try{
    const summaryLimit=rebuildState.summaryMode==="limited"?rebuildState.summaryLimit:0,minImportance=rebuildState.summaryMode==="limited"?rebuildState.minImportance:0;
    await api(`/api/libraries/${encodeURIComponent(library.threadId)}/settings`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({mcpRebuildDefaultsEnabled:rebuildState.mcpDefault,mcpSummaryLimit:summaryLimit,mcpMinImportance:minImportance})});
    const request={summary:{mode:rebuildState.summaryMode,limit:summaryLimit,minImportance},context:{mode:rebuildState.watermark?"watermark":"active_days",windowDays:rebuildState.windowDays,toolPairs:rebuildState.toolPairs},trim:{excludedMessages,excludedTools},trigger:"web",bindingId:rebuildState.bindingMemoryId===library.threadId?rebuildState.bindingId:null};
    const result=await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rebuild/${isCodex?"apply":"queue"}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request)});
    const trimmed=excludedMessages.length||excludedTools.length;
    previewOverlay?.remove();
    await renderRebuild(library);
    showRebuildCompletion({...library,runtime:rebuildState.bindingRuntime||library.runtime},{trimmed,queued:result.queued===true});
  }catch(error){showToast(error.message,"error");button.disabled=false;button.textContent="确认应用线程重建";}
}

function showRebuildCompletion(library,{trimmed=false,queued=false}={}) {
  document.querySelector("#rebuild-completion-overlay")?.remove();
  const isCodex=library.runtime==="codex";
  const overlay=document.createElement("div");
  overlay.id="rebuild-completion-overlay";
  overlay.className="editor-overlay rebuild-completion-overlay";
  const title=queued?(trimmed?"裁剪与线程重建已排队":"线程重建已排队"):(trimmed?"裁剪与线程重建已完成":"线程文件重建成功");
  const lead=queued
    ?`任务已写入安全队列，当前活动线程没有被改写。Claude Code 重启进程，或切换线程后重新载入 MCP 时会自动执行。`
    :`新的线程文件已经写入。${isCodex?"请不要继续发送消息，必须立刻完全重启 Codex/app-server，否则后续对话可能写入旧文件并丢失。":"还需要让 Claude Code 重新载入它，新的上下文才会正式生效。"}`;
  overlay.innerHTML=`<section class="editor-panel rebuild-completion-panel" role="dialog" aria-modal="true" aria-labelledby="rebuild-completion-title">
    <button class="editor-close ghost" type="button" aria-label="关闭">×</button>
    <div class="rebuild-completion-mark" aria-hidden="true">✓</div>
    <p class="eyebrow">${queued?"THREAD REBUILD QUEUED":"THREAD FILE REBUILT"}</p>
    <h2 id="rebuild-completion-title">${title}</h2>
    <p class="rebuild-completion-lead">${lead}</p>
    ${queued?`<div class="rebuild-reload-card claude"><strong>任务将在重新载入 MCP 时执行</strong><p>Claude Code 可重启进程，或切换到其他线程后再切回。</p></div>`:isCodex?`<div class="rebuild-reload-card codex"><strong>现在必须立即重启 Codex</strong><p>不要在当前会话继续发送消息。请完全退出 Codex / app-server，再使用原线程 ID 重新 Resume；否则后续内容可能写入旧文件描述符并丢失。</p><code>codex resume ${escapeHtml(library.threadId)}</code></div>`:`<div class="rebuild-reload-card claude"><strong>Claude Code 用户请选择一种重新载入方式</strong><ol><li>完全退出并重新启动 Claude Code；或</li><li>切换到其他线程，再切回当前线程。</li></ol><p>重新进入后可检查上下文状态，确认重建结果已经生效。</p></div>`}
    <div class="wizard-actions"><button class="primary rebuild-completion-close" type="button">我知道了</button></div>
  </section>`;
  const close=()=>overlay.remove();
  overlay.querySelector(".editor-close").onclick=close;
  overlay.querySelector(".rebuild-completion-close").onclick=close;
  overlay.addEventListener("click",event=>{if(event.target===overlay)close();});
  document.body.append(overlay);
  overlay.querySelector(".rebuild-completion-close").focus();
}

async function loadRebuildPreview(library) {
  const target = document.querySelector("#selection-list"); if (!target) return;
  target.innerHTML = `<div class="empty">正在生成预览…</div>`;
  try {
    const bindingId = rebuildState.bindingMemoryId === library.threadId ? rebuildState.bindingId : null;
    const bindingQuery = bindingId ? `&binding=${encodeURIComponent(bindingId)}` : "";
    rebuildState.preview = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rebuild/preview?windowDays=${rebuildState.windowDays}&toolPairs=${rebuildState.toolPairs}&page=${rebuildState.page}&toolPage=${rebuildState.toolPage}${bindingQuery}`);
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
    const bindingId = rebuildState.bindingMemoryId === library.threadId ? rebuildState.bindingId : null;
    const query = bindingId ? `?binding=${encodeURIComponent(bindingId)}` : "";
    const result = await api(`/api/libraries/${encodeURIComponent(library.threadId)}/rebuild/${repair ? "repair" : "check"}${repair ? "" : query}`, repair ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bindingId }) } : { method: "GET" });
    const report = repair ? result.after : result;
    target.className = `integrity ${report.healthy ? "" : "warning"}`;
    target.textContent = repair ? result.message : (report.healthy ? "活动线程结构完整。" : `发现 ${report.issues} 项结构问题，可以尝试自动修复。`);
    return result;
  } catch (error) { target.className = "integrity warning"; target.textContent = error.message; }
}

async function checkAndRepair(library) {
  const check = await showIntegrity(library, false); if (!check || check.healthy) { showToast("线程结构完整"); return; }
  const button = document.querySelector("#check-thread, #overview-repair");
  if (!button) return;
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = button.id === "check-thread" ? `<strong>正在备份并修复…</strong><span>修复后会自动重新检查。</span>` : "正在备份并修复…";
  await showIntegrity(library, true);
  button.disabled = false;
  button.innerHTML = original;
}

preparePwa();
bootstrapStoneMemory().catch(error => { app.innerHTML = `<section class="welcome"><div class="welcome-content"><h1>Stone Memory</h1><p class="lead">本地服务暂时无法读取记忆体。</p><button class="primary" onclick="location.reload()">重新加载</button></div></section>`; showToast(error.message, "error"); });
