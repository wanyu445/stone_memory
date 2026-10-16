(() => {
  "use strict";
  const api = window.StoneDeveloperModule;
  const readerTools = window.StoneNotebookReader;
  const memoryId = api?.memoryId || "";
  const base = `/api/libraries/${encodeURIComponent(memoryId)}/notebooks`;
  const $ = selector => document.querySelector(selector);
  const bookshelf = $("#bookshelf");
  const shelfStage = $(".shelf-stage");
  const libraryHeading = $(".library-heading");
  const toolbar = $(".toolbar");
  const workspace = $("#workspace");
  const reader = $("#reader");
  const paper = $("#paper");
  const entries = $("#entries");
  const notice = $("#notice");
  const topicDialog = $("#topic-dialog");
  const noteDialog = $("#note-dialog");
  let state = {
    topics: [], currentTopic: null, currentNote: null, currentEntries: [],
    readingBlocks: [], readingPages: [], readingPage: 0, visibleEntries: [], currentNoteIndex: -1,
  };
  const paperStyleSelect = $("#paper-style");
  const readingModeSelect = $("#reading-mode");
  const PAPER_STYLES = new Set(["blank", "lined", "grid"]);
  const PAPER_STYLE_KEY = "stone:notebook:paper-style:v1";
  const READING_MODES = new Set(["paged", "continuous"]);
  const READING_MODE_KEY = "stone:notebook:reading-mode:v1";

  const pageShell = document.querySelector("stone-module-page");
  if (pageShell?.shadowRoot) {
    const shellStyle = document.createElement("style");
    shellStyle.textContent = `:host([data-sentence-reading]) header{display:none!important}:host([data-sentence-reading]) main{padding-top:0!important}main{width:min(1160px,calc(100% - 32px))!important;padding-top:18px!important}header{padding:10px 6px 22px!important}.eyebrow{margin-top:18px!important}h1{font-size:clamp(38px,5vw,50px)!important}.description{margin-top:11px!important}.meta{margin-top:8px!important}@media(max-width:680px){main{width:min(100% - 20px,1160px)!important}.eyebrow{margin-top:14px!important}h1{font-size:34px!important}}`;
    pageShell.shadowRoot.append(shellStyle);
  }

  const sentenceViews = new Map();
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const formatDate = value => value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value)) : "还没有内容";
  const formatCatalogDate = value => value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)).replace("/", ".") : "--.--";
  const formatLongDate = value => value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(new Date(value)) : "日期未记载";
  function message(text, kind = "") { notice.textContent = text; notice.dataset.kind = kind; }
  function formError(form, text = "") {
    const target = form.querySelector(".form-error");
    target.textContent = text;
    target.hidden = !text;
  }
  function resetImageAttachment() {
    $("#note-image").value = "";
    $("#note-image-alt").value = "";
    const status = $("#image-upload-status");
    status.textContent = "";
    status.dataset.kind = "";
    $("#upload-note-image").disabled = false;
  }

  function insertAtCursor(textarea, value) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const prefix = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
    const suffix = after && !after.startsWith("\n\n") ? (after.startsWith("\n") ? "\n" : "\n\n") : "";
    const insertion = `${prefix}${value}${suffix}`;
    textarea.setRangeText(insertion, start, end, "end");
    textarea.focus();
  }
  const coverClass = topic => String(topic.coverPath || "preset:forest").replace("preset:", "cover-");

  function applyPaperStyle(value, persist = true) {
    const style = PAPER_STYLES.has(value) ? value : "blank";
    paper.dataset.paperStyle = style;
    paperStyleSelect.value = style;
    if (persist) {
      try { localStorage.setItem(PAPER_STYLE_KEY, style); } catch {}
    }
  }
  try { applyPaperStyle(localStorage.getItem(PAPER_STYLE_KEY) || "blank", false); } catch { applyPaperStyle("blank", false); }
  paperStyleSelect.addEventListener("change", event => applyPaperStyle(event.currentTarget.value));

  function applyReadingMode(value, persist = true) {
    const mode = READING_MODES.has(value) ? value : "paged";
    paper.dataset.readingMode = mode;
    readingModeSelect.value = mode;
    if (persist) {
      try { localStorage.setItem(READING_MODE_KEY, mode); } catch {}
    }
    if (state.currentNote) {
      state.readingPage = 0;
      buildReadingPages();
      renderReadingPage();
    }
  }
  try { applyReadingMode(localStorage.getItem(READING_MODE_KEY) || "paged", false); } catch { applyReadingMode("paged", false); }
  readingModeSelect.addEventListener("change", event => applyReadingMode(event.currentTarget.value));

  async function loadStatus() {
    if (!memoryId) throw new Error("缺少当前记忆体，请返回插件工坊重新进入");
    const data = await api.api(base);
    state.topics = data.topics || [];
    $("#topic-count").textContent = `/ ${data.topicCount}`;
    renderBookshelf();
    renderSearchTopics();
    message(`${data.topicCount} 本主题笔记 · ${data.entryCount} 篇 Markdown`);
  }

  function renderSearchTopics() {
    const select = $("#search-topic"), selected = select.value;
    select.innerHTML = `<option value="">全部主题</option>${state.topics.map(topic => `<option value="${escapeHtml(topic.id)}">${escapeHtml(topic.name)}${topic.isDefault ? "（默认）" : ""}</option>`).join("")}`;
    if (state.topics.some(topic => topic.id === selected)) select.value = selected;
  }

  function renderBookshelf() {
    bookshelf.classList.remove("search-mode");
    if (!state.topics.length) {
      bookshelf.innerHTML = `<div class="empty"><strong>书架还是空的</strong><p>先创建一本主题笔记，旅行、论坛、游戏或随笔都可以。</p></div>`;
      return;
    }
    bookshelf.innerHTML = state.topics.map((topic, index) => {
      const sealed = topic.visibility === "sealed";
      const unavailable = sealed || topic.isArchived;
      const status = [sealed ? "封存中" : "主题笔记", topic.isDefault ? "默认写入" : "", topic.isArchived ? "已归档" : ""].filter(Boolean).join(" · ");
      const latest = topic.latestEntry ? `<aside class="latest-note"><strong>${escapeHtml(topic.latestEntry.title)}</strong><span>${topic.latestEntry.visibility === "sealed" ? "最近一篇已封存" : escapeHtml(topic.latestEntry.summary || "暂无摘要")}</span></aside>` : "";
      const volume = String(index + 1).padStart(2, "0");
      const coverImage = topic.kind === "sentence-book" && topic.presentation?.coverPath ? sentenceImage(topic.presentation.coverPath, topic.id) : "";
      return `<article class="book ${topic.kind === "sentence-book" ? "sentence-book" : ""} ${sealed ? "sealed" : ""} ${topic.isArchived ? "archived" : ""} ${coverClass(topic)}" style="--book-index:${index % 6}">
        <div class="notebook-cover"${coverImage ? ` style="background-image:url('${escapeHtml(coverImage)}');background-size:cover;background-position:center"` : ""}>
          <span class="book-spine" aria-hidden="true"></span>
          <span class="cover-flower" aria-hidden="true"></span>
          ${topic.kind === "sentence-book" ? `<div class="sentence-cover-label"><span class="sentence-cover-category">句子册 <i aria-hidden="true">·</i> ${volume}</span><h2><button type="button" class="cover-rename" data-rename-topic="${escapeHtml(topic.id)}" aria-label="修改书名：${escapeHtml(topic.name)}" title="点击修改书名">${escapeHtml(topic.name)}</button></h2></div>` : `<p>${escapeHtml(status)}</p><h2>${escapeHtml(topic.name)}</h2><span class="cover-description">${escapeHtml(topic.description || "随手收藏")}</span><b class="volume-number">${volume}</b>`}
          ${sealed ? `<span class="seal">由小机封存中</span>` : ""}
          ${unavailable ? "" : `<button type="button" class="open-book" data-topic="${escapeHtml(topic.id)}" aria-label="翻开主题：${escapeHtml(topic.name)}"><span>翻开笔记</span></button>`}
        </div>
        <div class="book-copy">${topic.kind === "sentence-book" ? `<p class="sentence-book-status">${escapeHtml(status)}</p><p class="sentence-book-description">${escapeHtml(topic.description || "随手收藏")}</p>` : ""}<footer><strong>${topic.entryCount} 篇笔记</strong><span>${formatDate(topic.latestEntryAt)}</span></footer>${latest}</div>
        <div class="book-actions"><button type="button" class="quiet-manage" data-manage-topic="${escapeHtml(topic.id)}" aria-label="管理主题：${escapeHtml(topic.name)}">管理主题</button></div>
      </article>`;
    }).join("");
    bookshelf.querySelectorAll("[data-rename-topic]").forEach(button => button.onclick = () => renameBook(button.dataset.renameTopic));
    bookshelf.querySelectorAll("[data-topic]").forEach(button => button.onclick = () => openTopic(button.dataset.topic));
    bookshelf.querySelectorAll("[data-manage-topic]").forEach(button => button.onclick = () => openTopicForm(button.dataset.manageTopic));
  }

  function renameBook(topicId) {
    const topic = state.topics.find(item => item.id === topicId);
    if (!topic) return;
    const dialog = document.createElement("dialog");
    dialog.className = "book-name-dialog";
    dialog.innerHTML = `<form><h2>给这本册子取个名字</h2><label>书名<input name="name" required maxlength="80" value="${escapeHtml(topic.name)}" autocomplete="off"></label><p class="form-error" role="alert" hidden></p><div class="actions"><button type="button" data-cancel>取消</button><button type="submit" class="primary">保存</button></div></form>`;
    document.body.append(dialog);
    const form = dialog.querySelector("form"), input = form.elements.name;
    let saving = false;
    dialog.addEventListener("cancel", event => { if(saving) event.preventDefault(); });
    dialog.addEventListener("close", () => { dialog.remove(); bookshelf.querySelector(`[data-rename-topic="${topicId}"]`)?.focus(); });
    dialog.querySelector("[data-cancel]").onclick = () => dialog.close();
    form.onsubmit = async event => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) { formError(form,"书名还没有写好哦。请填一个名字。"); input.focus(); return; }
      saving = true;
      form.querySelectorAll("button,input").forEach(el => el.disabled = true);
      formError(form);
      try {
        await api.api(`${base}/topics/${encodeURIComponent(topicId)}`, {method:"PATCH",body:JSON.stringify({name})});
        topic.name = name;
        renderBookshelf(); renderSearchTopics();
        dialog.close(); message("书名已保存");
      } catch(error) { formError(form,error.message || "没有保存成功，请再试一次。"); }
      finally { saving = false; form.querySelectorAll("button,input").forEach(el => el.disabled = false); }
    };
    dialog.showModal(); input.focus(); input.select();
  }

  async function openTopic(topicId) {
    const topic = state.topics.find(item => item.id === topicId);
    if (!topic || topic.visibility === "sealed") return;
    state.currentTopic = topic;
    workspace.dataset.notebookKind = topic.kind || "standard";
    const rows = await api.api(`${base}/topics/${encodeURIComponent(topicId)}/entries`);
    state.currentEntries = rows;
    if(topic.kind === "sentence-book") { await renderSentenceBook(null); return; }
    $("#topic-kicker").textContent = `${rows.length} 篇 Markdown`;
    $("#topic-title").textContent = topic.name;
    $("#topic-description").textContent = topic.description || "这本笔记还没有说明。";
    workspace.dataset.stamp = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(new Date()).toUpperCase();
    $("#new-note").hidden = false;
    renderDirectory(rows, { emptyTitle: "还没有写下第一页", emptyDescription: "可以由你写，也可以让小机通过 MCP 保存。", allowUnseal: true });
    shelfStage.hidden = true;
    libraryHeading.hidden = true;
    toolbar.hidden = true;
    notice.hidden = true;
    reader.hidden = true;
    workspace.hidden = false;
    $("#new-note").focus();
  }

  function renderDirectory(rows, { includeTopic = false, allowUnseal = false, emptyTitle = "没有找到", emptyDescription = "换一个关键词试试看。" } = {}) {
    entries.innerHTML = rows.length ? rows.map((note, index) => {
      const tags = (note.tags || []).map(tag => `#${escapeHtml(tag)}`).join("  ");
      const topic = includeTopic && note.topicName ? escapeHtml(note.topicName) : "";
      const meta = [topic, tags || (!includeTopic ? "随笔" : "")].filter(Boolean).join(" · ");
      return note.visibility === "sealed"
        ? `<article class="entry sealed-entry"><time>${formatCatalogDate(note.updatedAt)}</time><div class="entry-copy"><h3>${escapeHtml(note.title)}</h3><span>${topic ? `${topic} · ` : ""}此篇由小机封存中</span></div><span class="dot-leader" aria-hidden="true"></span><b>${String(index + 1).padStart(2, "0")}</b>${allowUnseal ? `<button type="button" data-unseal-note="${escapeHtml(note.id)}">解除封存</button>` : ""}</article>`
        : `<button class="entry" type="button" data-note="${escapeHtml(note.id)}"><time>${formatCatalogDate(note.updatedAt)}</time><div class="entry-copy"><h3>${escapeHtml(note.title)}</h3><span>${meta || "主题笔记"}</span></div><span class="dot-leader" aria-hidden="true"></span><b>${String(index + 1).padStart(2, "0")}</b></button>`;
    }).join("") : `<div class="empty"><strong>${escapeHtml(emptyTitle)}</strong><p>${escapeHtml(emptyDescription)}</p></div>`;
    entries.querySelectorAll("[data-note]").forEach(button => button.onclick = () => readNote(button.dataset.note));
    entries.querySelectorAll("[data-unseal-note]").forEach(button => button.onclick = () => unsealNote(button.dataset.unsealNote));
  }

  async function readNote(noteId) {
    const note = await api.api(`${base}/entries/${encodeURIComponent(noteId)}`);
    if (note.visibility === "sealed") return;
    if (state.currentTopic?.kind === "sentence-book") {
      await renderSentenceBook(note);
      return;
    }
    state.currentNote = note;
    state.currentTopic = state.topics.find(topic => topic.id === note.topicId) || state.currentTopic;
    const visibleEntries = state.currentEntries.filter(item => item.visibility !== "sealed");
    const currentIndex = visibleEntries.findIndex(item => item.id === note.id);
    state.visibleEntries = visibleEntries;
    state.currentNoteIndex = currentIndex;
    state.readingPage = 0;
    const date = new Date(note.updatedAt || note.createdAt || Date.now());
    const month = new Intl.DateTimeFormat("en-US", { month: "short" }).format(date).toUpperCase();
    const day = String(date.getDate()).padStart(2, "0");
    paper.id="paper"; paper.className=""; $(".reader-actions").hidden=false; $(".reader-nav").hidden=false;
    paper.innerHTML = `<span class="paper-ribbon" aria-hidden="true"></span><div class="book-page book-page-title"><header><div class="date-badge"><small>${month}</small><strong>${day}</strong></div><p>${formatLongDate(date)}<span class="leaf-divider" aria-hidden="true"></span>${escapeHtml(note.topicName)} · 第 ${note.revision} 版</p><h2>${escapeHtml(note.title)}</h2><div>${(note.tags || []).map(tag => `<span>#${escapeHtml(tag)}</span>`).join("")}</div></header></div><div class="book-page book-page-body"><div id="reading-content" aria-live="polite"></div><nav id="body-pagination" class="body-pagination" aria-label="当前笔记正文分页"><button id="previous-page" type="button">← 上一页</button><span id="page-status"></span><button id="next-page" type="button">下一页 →</button></nav></div><footer><span>${String(Math.max(0, currentIndex) + 1).padStart(2, "0")}</span><i>/</i><span>${String(visibleEntries.length).padStart(2, "0")}</span></footer>`;
    paper.classList.toggle("sentence-reader", state.currentTopic?.kind === "sentence-book");
    reader.classList.toggle("sentence-mode", state.currentTopic?.kind === "sentence-book");
    let dressButton = $("#dress-reader");
    if (dressButton) dressButton.hidden = state.currentTopic?.kind !== "sentence-book";
    if (state.currentTopic?.kind === "sentence-book") {
      const meta = note.metadata || {};
      const header = paper.querySelector(".book-page-title header");
      header.querySelector(".date-badge")?.remove();
      header.insertAdjacentHTML("afterbegin", '<div class="sentence-art" data-art="header"><img alt="页头花饰"><button type="button" hidden>更换页头图片</button></div><small class="sentence-caption">字 里 · 行 间</small>');
      const body = paper.querySelector(".book-page-body");
      body.insertAdjacentHTML("beforeend", `<div class="sentence-speaker">${escapeHtml(meta.speaker || "")}</div>${meta.note ? `<section class="sentence-ripple"><span>涟漪</span><div><strong>${escapeHtml(meta.note_author || meta.collector || "")}</strong><p>${escapeHtml(meta.note)}</p></div></section>` : ""}<div class="sentence-collected">${meta.collector ? `收藏者 · ${escapeHtml(meta.collector)}` : ""}</div>`);
      paper.querySelector("footer").insertAdjacentHTML("beforebegin", '<div class="sentence-art" data-art="footer"><img alt="页尾花饰"><button type="button" hidden>更换页尾图片</button></div>');
      if (!dressButton) { dressButton = document.createElement("button"); dressButton.id = "dress-reader"; dressButton.type = "button"; dressButton.textContent = "装扮"; $(".reader-tools").prepend(dressButton); }
      dressButton.hidden = false;
      dressButton.onclick = () => enableInlineDress(state.currentTopic);
      applySentencePresentation(state.currentTopic.presentation || {});
    }
    buildReadingPages();
    renderReadingPage();
    const previous = $("#previous-note"), next = $("#next-note");
    previous.disabled = currentIndex <= 0;
    next.disabled = currentIndex < 0 || currentIndex >= visibleEntries.length - 1;
    previous.dataset.note = currentIndex > 0 ? visibleEntries[currentIndex - 1].id : "";
    next.dataset.note = currentIndex >= 0 && currentIndex < visibleEntries.length - 1 ? visibleEntries[currentIndex + 1].id : "";
    workspace.hidden = true;
    reader.hidden = false;
    $("#reader-back").focus();
  }

  async function renderSentenceBook(firstNote) {
    const rows = state.currentEntries.filter(item => item.visibility !== "sealed");
    const allNotes = new Array(rows.length);let nextRead=0;
    await Promise.all(Array.from({length:Math.min(8,rows.length)},async()=>{while(nextRead<rows.length){const index=nextRead++;allNotes[index]=await api.api(`${base}/entries/${encodeURIComponent(rows[index].id)}`);}}));
    const notes = allNotes.filter(item => !item.metadata?.sentenceRemoved);
    const removed = allNotes.filter(item => item.metadata?.sentenceRemoved);
    state.currentNote = firstNote || notes[0] || null;
    state.visibleEntries = rows;
    const topic=state.currentTopic, esc=escapeHtml;
    paper.id="sentence-paper"; paper.className="cq-page cq-book";
    reader.classList.add("sentence-mode");
    const ornament=`<svg viewBox="0 0 160 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width=".8"><path d="M0 12h48m64 0h48M39 15h15m52 0h15M54 12c12 0 13-7 22-7m-22 7c12 0 13 7 22 7m8-14c9 0 10 7 22 7m-22 7c9 0 10-7 22-7"/><path d="M80 12c-13-3-9-14-3-9 2 2 3 6 3 9Zm0 0c13-3 9-14 3-9-2 2-3 6-3 9Zm0 0c-11 1-10 9-4 8 3-1 4-5 4-8Zm0 0c11 1 10 9 4 8-3-1-4-5-4-8Z"/><circle cx="80" cy="12" r="2"/></g><path fill="currentColor" opacity=".5" d="M58 11q3-9 10-7-2 7-10 7m44 0q-3-9-10-7 2 7 10 7"/></svg>`;
    const card=(item,index)=>{const meta=item.metadata||{};return `<article class="cq-row" data-sentence-text="${esc([item.body,item.title,meta.speaker,meta.collector,meta.note,meta.conversation_title].join(" "))}"><div class="cq-slip"><div class="cq-slip-head"><span class="cq-row-number">${String(index+1).padStart(2,"0")}</span><span class="cq-slip-flower">${ornament}</span></div><blockquote>${esc(item.body)}</blockquote><div class="cq-attribution"><span>${esc(meta.speaker||"")}</span></div>${meta.note?`<section class="cq-ripple"><h3>涟漪</h3><div class="cq-ripple-body"><div class="cq-ripple-author">${esc(meta.note_author||meta.collector||"")}</div><p>${esc(meta.note)}</p></div></section>`:""}<div class="cq-slip-meta">${meta.collector?`<p class="cq-origin">收藏者 · ${esc(meta.collector)}</p>`:""}<time>${formatDate(meta.originalCreatedAt||item.createdAt)}</time></div><div class="cq-slip-tail">${ornament}</div></div><footer><button type="button" data-expand-sentence="${esc(item.id)}">展开</button><button type="button" class="cq-remove" data-remove-sentence="${esc(item.id)}" aria-label="移除第${index+1}句">移除</button></footer></article>`;};
    paper.innerHTML=`<header class="cq-header"><button type="button" data-sentence-back>‹ 返回书架</button><span>${esc(topic.name)}</span></header><div class="cq-paper"><div class="cq-hero" data-art="header"><img class="cq-blossom" alt="页头花饰"><div class="cq-heading"><small>字 里 · 行 间</small><h1>句子册</h1><p>${esc(topic.description||"只收舍不得忘的话。")}</p><span class="cq-seal" aria-hidden="true">珍<br>藏</span></div><button type="button" class="cq-image-change" hidden>更换页头图片</button></div><div class="cq-book-body"><div class="cq-actions"><button type="button" data-sentence-new>收好一句话</button><button type="button" data-sentence-import>导入收藏</button><button type="button" data-sentence-dress>装扮</button><button type="button" data-sentence-reload>重新读取</button></div><label class="cq-search">寻一句话<input type="search" placeholder="搜索句子、说话者、来源或涟漪" aria-label="寻找收藏句子"></label><div class="cq-meta" tabindex="-1" data-list-top><span data-sentence-count>共 ${notes.length} 句珍藏</span>${removed.length?`<button type="button" data-removed>已移除 · ${removed.length}</button>`:""}</div><div data-sentence-list>${notes.map(card).join("")}</div><nav class="cq-pagination" aria-label="句子册翻页" data-pagination></nav><p role="status" data-book-status></p></div><footer class="cq-tail" data-art="footer"><p>一字一句，来日重读。</p><img alt="页尾花饰"><button type="button" class="cq-image-change" hidden>更换页尾图片</button></footer></div>`;
    paper.querySelector("[data-sentence-back]").onclick=showLibrary;
    paper.querySelector("[data-sentence-new]").onclick=()=>$("#new-note").click();
    paper.querySelector("[data-sentence-dress]").onclick=()=>enableInlineDress(topic);
    paper.querySelector("[data-sentence-reload]").onclick=async event=>{const button=event.currentTarget;button.disabled=true;const status=paper.querySelector("[data-book-status]");status.textContent="正在重新读取…";try{await openTopic(topic.id);}catch(error){status.textContent=`暂未读到最新内容：${error.message}。可以重新读取。`;}finally{button.disabled=false;}};
    paper.querySelectorAll("[data-expand-sentence]").forEach(button=>button.onclick=()=>{
      const item=notes.find(note=>note.id===button.dataset.expandSentence), meta=item.metadata||{};
      const wrapper=document.createElement("div");wrapper.innerHTML=card(item,notes.indexOf(item));
      const slip=wrapper.querySelector(".cq-slip");
      slip.querySelector(".cq-row-number").className="cq-slip-caption";
      slip.querySelector(".cq-slip-caption").textContent="字 里 藏 心";
      slip.querySelector(".cq-ripple")?.classList.add("is-full");
      const modal=sentenceModal("这一句，细细读",`<article class="cq-full">${slip.outerHTML}<details><summary>收藏信息</summary><p>收藏人：${esc(meta.collector||"原记录未注明")}</p><p>收藏于 ${esc(formatLongDate(meta.originalCreatedAt||item.createdAt))}</p>${meta.conversation_title?`<p>来自：${esc(meta.conversation_title)}</p>`:""}${meta.source_id?`<p>原记录：${esc(meta.source_id)}</p>`:""}</details></article><footer><button type="button" data-edit>整理这句话</button><button type="button" data-close>收好，回到句子册</button></footer>`,button);
      modal.querySelector("[data-edit]").onclick=()=>{modal.close();state.currentNote=item;$("#edit-note").click();};
    });
    const changeRemoved=async(item,value)=>{
      await api.api(`${base}/entries/${encodeURIComponent(item.id)}`,{method:"PATCH",body:JSON.stringify({topicId:item.topicId,title:item.title,body:item.body,tags:item.tags,visibility:item.visibility,expectedRevision:item.revision,metadata:{...item.metadata,sentenceRemoved:value}})});
    };
    paper.querySelectorAll("[data-remove-sentence]").forEach(button=>button.onclick=()=>{
      const item=notes.find(note=>note.id===button.dataset.removeSentence);
      const modal=sentenceModal("移除这句收藏？",`<blockquote>${esc(item.body)}</blockquote><p>移到「已移除」里，随时可以放回句子册。</p><p role="alert" data-error></p><footer><button type="button" data-close>取消</button><button type="button" data-confirm>确认移除</button></footer>`,button);
      modal.querySelector("[data-confirm]").onclick=async()=>{
        modal.dataset.busy="true";modal.querySelectorAll("button").forEach(b=>b.disabled=true);
        try{await changeRemoved(item,true);modal.close();await openTopic(topic.id);}catch(error){modal.querySelector("[data-error]").textContent=error.message;}
        finally{delete modal.dataset.busy;modal.querySelectorAll("button").forEach(b=>b.disabled=false);}
      };
    });
    const removedButton=paper.querySelector("[data-removed]");
    if(removedButton)removedButton.onclick=()=>{
      const modal=sentenceModal("已移除的句子",removed.map(item=>`<section class="cq-removed-item"><blockquote>${esc(item.body)}</blockquote><button type="button" data-restore="${esc(item.id)}">放回句子册</button></section>`).join("")+`<p role="alert" data-error></p><footer><button type="button" data-close>返回句子册</button></footer>`,removedButton);
      modal.querySelectorAll("[data-restore]").forEach(button=>button.onclick=async()=>{
        modal.dataset.busy="true";modal.querySelectorAll("button").forEach(b=>b.disabled=true);
        try{await changeRemoved(removed.find(item=>item.id===button.dataset.restore),false);modal.close();await openTopic(topic.id);}catch(error){modal.querySelector("[data-error]").textContent=error.message;}
        finally{delete modal.dataset.busy;modal.querySelectorAll("button").forEach(b=>b.disabled=false);}
      });
    };
    let persistedView=null;try{persistedView=JSON.parse(sessionStorage.getItem(`sentence-view:${memoryId}:${topic.id}`));}catch{}
    const view=sentenceViews.get(topic.id)||{page:Math.max(1,Number(persistedView?.page)||1),q:String(persistedView?.q||"")};sentenceViews.set(topic.id,view);
    const search=paper.querySelector("input[type=search]"),list=paper.querySelector("[data-sentence-list]"),navigation=paper.querySelector("[data-pagination]");
    search.value=view.q;
    const empty=document.createElement("div");empty.className="cq-empty";list.append(empty);
    const paintPage=(moveFocus=false)=>{
      const q=view.q.trim().toLocaleLowerCase(),cards=Array.from(list.querySelectorAll("[data-sentence-text]"));
      const filtered=cards.filter(row=>row.dataset.sentenceText.toLocaleLowerCase().includes(q));
      const pages=Math.max(1,Math.ceil(filtered.length/12));view.page=Math.max(1,Math.min(pages,view.page));
      cards.forEach(row=>row.hidden=true);filtered.forEach((row,index)=>{row.querySelector(".cq-row-number").textContent=String(index+1).padStart(2,"0");row.querySelector("[data-remove-sentence]").setAttribute("aria-label",`移除第${index+1}句`);});filtered.slice((view.page-1)*12,view.page*12).forEach(row=>row.hidden=false);
      paper.querySelector("[data-sentence-count]").textContent=`${q?"找到":"共"} ${filtered.length} 句${q?"":"珍藏"}${filtered.length?` · ${(view.page-1)*12+1}—${Math.min(view.page*12,filtered.length)} · 第 ${view.page} / ${pages} 页`:""}`;
      empty.hidden=filtered.length>0;
      empty.innerHTML=notes.length?'<p>没有找到这句话，换个词再试试。</p><button type="button" data-clear-search>查看全部</button>':'<p>这一册还没有句子，收好第一句吧。</p><button type="button" data-first-note>收好第一句话</button>';
      empty.querySelector("[data-clear-search]")?.addEventListener("click",()=>{view.q="";view.page=1;search.value="";paintPage();search.focus();});
      empty.querySelector("[data-first-note]")?.addEventListener("click",()=>$("#new-note").click());
      navigation.hidden=!filtered.length;
      navigation.innerHTML=`<button type="button" data-prev ${view.page===1?"disabled":""}>‹ 上一页</button><label>第 <select aria-label="跳到指定页">${Array.from({length:pages},(_,i)=>`<option value="${i+1}" ${i+1===view.page?"selected":""}>${i+1}</option>`).join("")}</select> / ${pages} 页</label><button type="button" data-next ${view.page===pages?"disabled":""}>下一页 ›</button>`;
      navigation.querySelector("[data-prev]").onclick=()=>{view.page--;paintPage(true);};
      navigation.querySelector("[data-next]").onclick=()=>{view.page++;paintPage(true);};
      navigation.querySelector("select").onchange=event=>{view.page=Number(event.target.value);paintPage(true);};
      try{sessionStorage.setItem(`sentence-view:${memoryId}:${topic.id}`,JSON.stringify(view));}catch{}
      if(moveFocus){const top=paper.querySelector("[data-list-top]");top.focus({preventScroll:true});top.scrollIntoView({block:"start"});}
    };
    search.oninput=()=>{view.q=search.value;view.page=1;paintPage();};paintPage();
    paper.querySelector("[data-sentence-import]").onclick=()=>window.StoneSentenceImport.open({api,base,topic,notes:allNotes,modal:sentenceModal,onComplete:()=>openTopic(topic.id)});
    applySentencePresentation(topic.presentation||{});
    pageShell?.setAttribute("data-sentence-reading", "");notice.hidden=true;
    workspace.hidden=true;reader.hidden=false;shelfStage.hidden=true;libraryHeading.hidden=true;toolbar.hidden=true;
    $(".reader-actions").hidden=true;$(".reader-nav").hidden=true;
    paper.scrollIntoView({block:"start"});
  }

  function sentenceModal(title,body,opener) {
    const modal=document.createElement("dialog");modal.className="cq-page sentence-detail-dialog";
    modal.setAttribute("aria-label",title);
    for(const name of ["paper","ink","accent","muted","line","tint","gold","flower","rule"]) modal.style.setProperty(`--cq-${name}`,getComputedStyle(paper).getPropertyValue(`--cq-${name}`));
    modal.innerHTML=`<section class="cq-dialog" data-cq-layer="read:sentence"><header><h2>${escapeHtml(title)}</h2><button type="button" data-close aria-label="关闭详情">×</button></header><div class="home-input-body">${body}</div></section>`;
    document.body.append(modal);
    modal.querySelectorAll("[data-close]").forEach(button=>button.onclick=()=>modal.close());
    modal.addEventListener("cancel",event=>{if(modal.dataset.busy)event.preventDefault();});
    modal.addEventListener("close",()=>{modal.remove();if(opener?.isConnected)opener.focus();});
    modal.showModal();return modal;
  }

  function readingBudget() {
    return window.matchMedia("(max-width: 800px)").matches ? 320 : 420;
  }

  function buildReadingPages() {
    const note = state.currentNote;
    if (!note || !readerTools) return;
    state.readingBlocks = readerTools.renderMarkdownBlocks(note.body, {
      resolveImageUrl: source => readerTools.resolveImageUrl(source, { base, topicId: note.topicId }),
    });
    state.readingPages = readerTools.paginateBlocks(state.readingBlocks, readingBudget());
    state.readingPage = Math.min(state.readingPage, Math.max(0, state.readingPages.length - 1));
  }

  function renderReadingPage() {
    const content = $("#reading-content"), controls = $("#body-pagination");
    if (!content || !controls) return;
    const continuous = readingModeSelect.value === "continuous";
    const blocks = continuous ? state.readingBlocks : (state.readingPages[state.readingPage] || []);
    content.innerHTML = `<div class="markdown">${blocks.map(block => block.html).join("")}</div>`;
    controls.hidden = continuous || state.readingPages.length <= 1;
    if (!controls.hidden) {
      const previous = $("#previous-page"), next = $("#next-page");
      previous.disabled = state.readingPage <= 0;
      next.disabled = state.readingPage >= state.readingPages.length - 1;
      $("#page-status").textContent = `正文 ${state.readingPage + 1} / ${state.readingPages.length}`;
      previous.onclick = () => changeReadingPage(-1);
      next.onclick = () => changeReadingPage(1);
    }
  }

  function changeReadingPage(offset) {
    const next = Math.max(0, Math.min(state.readingPages.length - 1, state.readingPage + offset));
    if (next === state.readingPage) return;
    state.readingPage = next;
    renderReadingPage();
    paper.scrollIntoView({ block: "start", behavior: "auto" });
  }

  function openTopicForm(topicId = "") {
    const form = $("#topic-form"), topic = state.topics.find(item => item.id === topicId) || null;
    if (!form.elements.kind) {
      const label = document.createElement("label");
      label.innerHTML = '笔记类型<select name="kind"><option value="standard">普通主题</option><option value="sentence-book">句子册</option></select>';
      form.querySelector('label[for="coverPath"]')?.before(label) || form.querySelector('select[name="coverPath"]')?.closest("label")?.before(label);
    }
    form.reset(); formError(form);
    form.elements.topicId.value = topic?.id || "";
    form.elements.name.value = topic?.name || "";
    form.elements.kind.value = topic?.kind || "standard";
    form.elements.description.value = topic?.description || "";
    form.elements.coverPath.value = topic?.coverPath === "preset:forest" ? "" : topic?.coverPath || "";
    form.elements.isDefault.checked = Boolean(topic?.isDefault);
    form.elements.sealed.checked = topic?.visibility === "sealed";
    form.elements.archived.checked = Boolean(topic?.isArchived);
    form.querySelector("h2").textContent = topic ? "管理主题笔记" : "新建一本主题笔记";
    form.elements.save.textContent = topic ? "保存主题设置" : "创建";
    form.querySelector(".edit-only").hidden = !topic;
    topicDialog.showModal();
    form.elements.name.focus();
  }
  $("#new-topic").onclick = () => openTopicForm();
  $("#new-note").onclick = () => {
    const form = $("#note-form");
    if(state.currentTopic?.kind==="sentence-book"){
      let pending;try{pending=JSON.parse(localStorage.getItem(`sentence-pending:${memoryId}:${state.currentTopic.id}`)||"null");}catch{}
      if(pending){
        form.reset();ensureSentenceFields(form);form.elements.topicId.value=state.currentTopic.id;form.elements.noteId.value="";
        for(const key of ["title","body"])form.elements[key].value=pending[key]||"";
        for(const key of ["speaker","collector","note","note_author","conversation_title"])form.elements[key].value=pending.metadata?.[key]||"";
        form.elements.tags.value=(pending.tags||[]).join(",");form.elements.sealed.checked=pending.visibility==="sealed";
        form.dataset.sourceToken=pending.metadata.source_id;form.dataset.pendingWrite="true";
        form.elements.save.textContent="重新读取核对";form.querySelector("h2").textContent="核对上次收藏";
        noteDialog.classList.add("cq-page");noteDialog.showModal();formError(form,"上次保存尚未确认，请先点击重新读取核对，避免重复收藏。");return;
      }
    }
    delete form.dataset.pendingWrite;delete form.dataset.sourceToken;
    form.reset(); formError(form); resetImageAttachment();
    form.querySelector("h2").textContent = state.currentTopic?.kind === "sentence-book" ? "收好一句话" : "写一页";
    form.elements.save.textContent = state.currentTopic?.kind === "sentence-book" ? "收进句子册" : "保存 Markdown";
    form.elements.topicId.value = state.currentTopic.id;
    form.elements.noteId.value = "";
    form.elements.expectedRevision.value = "";
    ensureSentenceFields(form);
    if(state.currentTopic?.kind==="sentence-book"){
      try{const draft=JSON.parse(sessionStorage.getItem(`sentence-draft:${memoryId}:${state.currentTopic.id}`)||"null");if(draft)for(const [key,value] of Object.entries(draft))if(form.elements[key])form.elements[key].value=value;}catch{}
    }
    noteDialog.classList.toggle("cq-page",state.currentTopic?.kind === "sentence-book");
    noteDialog.showModal();
  };
  $("#edit-note").onclick = () => {
    const note = state.currentNote;
    if (!note || note.visibility === "sealed") return;
    const form = $("#note-form");
    form.reset(); formError(form); resetImageAttachment();
    form.querySelector("h2").textContent = "编辑这一页";
    form.elements.save.textContent = "保存修改";
    form.elements.topicId.value = note.topicId;
    form.elements.noteId.value = note.id;
    form.elements.expectedRevision.value = String(note.revision);
    form.elements.title.value = note.title;
    form.elements.tags.value = note.tags.join("，");
    form.elements.body.value = note.body;
    ensureSentenceFields(form);
    for (const key of ["speaker", "collector", "note", "note_author", "conversation_title"]) if (form.elements[key]) form.elements[key].value = note.metadata?.[key] || "";
    form.elements.sealed.checked = false;
    noteDialog.classList.toggle("cq-page",state.currentTopic?.kind === "sentence-book");
    noteDialog.showModal();
  };
  function ensureSentenceFields(form) {
    const isSentence=state.currentTopic?.kind === "sentence-book";
    form.elements.title.required=!isSentence;
    form.elements.title.closest("label").hidden=isSentence;
    const existing = form.querySelector(".sentence-fields");
    if (existing) { existing.hidden = state.currentTopic?.kind !== "sentence-book"; return; }
    if (state.currentTopic?.kind !== "sentence-book") return;
    const anchor = form.elements.tags.closest("label");
    const wrap = document.createElement("fieldset");
    wrap.className = "sentence-fields";
    wrap.innerHTML = '<legend>句子册信息（可选）</legend><label>说话者<input name="speaker" maxlength="80"></label><label>收藏者<input name="collector" maxlength="80"></label><label>涟漪留言<textarea name="note" rows="3"></textarea></label><label>留言署名<input name="note_author" maxlength="80"></label><label>来自哪段对话<input name="conversation_title" maxlength="300"></label>';
    anchor?.after(wrap);
  }

  const sentenceDefaults = {paper:"#f6faf3", ink:"#345846", accent:"#70977d"};
  function sentenceImage(path, topicId) {
    const source = /^topics\/[^/]+\/assets\/[^/]+$/.test(path || "") ? "assets/" + path.split("/").pop() : path;
    return (source && readerTools.resolveImageUrl(source, {base, topicId})) || "./assets/blossom-v1.png";
  }
  function applySentencePresentation(presentation, temporary = {}) {
    const palette = {...sentenceDefaults, ...presentation.palette};
    for (const key of ["paper", "ink", "accent"]) paper.style.setProperty(`--sentence-${key}`, /^#[0-9a-f]{6}$/i.test(palette[key]) ? palette[key] : sentenceDefaults[key]);
    paper.style.setProperty("--cq-paper",palette.paper);paper.style.setProperty("--cq-ink",palette.ink);paper.style.setProperty("--cq-accent",palette.accent);
    paper.style.setProperty("--cq-muted",palette.ink);
    for(const name of ["gold","flower"]) paper.style.setProperty(`--cq-${name}`,palette.accent);
    paper.style.setProperty("--cq-line",`color-mix(in srgb, ${palette.accent} 42%, ${palette.paper})`);
    paper.style.setProperty("--cq-tint",`color-mix(in srgb, ${palette.accent} 10%, ${palette.paper})`);
    paper.style.setProperty("--cq-rule",`color-mix(in srgb, ${palette.ink} 18%, transparent)`);
    for(const target of [noteDialog]){
      target.classList.toggle("cq-page",state.currentTopic?.kind==="sentence-book");
      for(const name of ["paper","ink","accent","muted","line","tint","gold","flower","rule"]) target.style.setProperty(`--cq-${name}`,paper.style.getPropertyValue(`--cq-${name}`));
    }
    for (const key of ["header", "footer", "cover"]) {
      const img = paper.querySelector(`[data-art="${key}"] img`);
      if (img) img.src = temporary[key] || sentenceImage(presentation[`${key}Path`], state.currentTopic.id);
    }
  }
  function enableInlineDress(topic) {
    if (paper.querySelector(".inline-dress")) return;
    let draft = structuredClone(topic.presentation || {});
    const original = structuredClone(draft), files = {}, temporary = {};
    let busy = false;
    const cover = document.createElement("div"); cover.className="sentence-cover-preview sentence-art"; cover.dataset.art="cover";
    cover.innerHTML='<img alt="封面预览"><button type="button">更换封面图片</button>';
    paper.prepend(cover);
    const bar=document.createElement("form"); bar.className="inline-dress";
    bar.innerHTML='<strong>装扮这本句子册</strong><div class="dress-colors">'+[ ["paper","纸面"],["ink","文字"],["accent","点缀"] ].map(([key,label])=>`<label>${label}<input type="color" name="${key}" value="${sentenceDefaults[key]}"></label>`).join("")+'</div><p class="dress-status" role="status">点花图即可换图，保存后生效。</p><div class="dress-actions"><button type="button" data-default>恢复默认</button><button type="button" data-cancel>取消</button><button type="submit" class="primary">保存</button></div>';
    paper.append(bar); paper.classList.add("is-dressing");
    const status=bar.querySelector(".dress-status");
    const revoke=key=>{if(temporary[key]) URL.revokeObjectURL(temporary[key]); delete temporary[key];};
    const paint=()=>{const palette={...sentenceDefaults,...draft.palette};for(const key of Object.keys(sentenceDefaults))bar.elements[key].value=palette[key];applySentencePresentation(draft,temporary);};
    for(const key of ["cover","header","footer"]){
      const art=paper.querySelector(`[data-art="${key}"]`), button=art.querySelector("button"), input=document.createElement("input");
      input.type="file";input.accept="image/png,image/jpeg,image/webp,image/gif,image/avif";input.hidden=true;input.setAttribute("aria-label",button.textContent); art.append(input);button.hidden=false;button.onclick=()=>input.click();
      input.onchange=()=>{const file=input.files[0];if(!file)return;if(file.size>20*1024*1024){status.textContent="图片超过20MB，请换一张。";return;}openCropper(file,key,{onApply(blob){revoke(key);files[key]=new File([blob],`${key}.png`,{type:"image/png"});temporary[key]=URL.createObjectURL(blob);paint();status.textContent="已裁剪预览，尚未保存。";},onCancel(){input.value="";}});};
    }
    for(const key of Object.keys(sentenceDefaults))bar.elements[key].oninput=()=>{draft.palette={...sentenceDefaults,...draft.palette,[key]:bar.elements[key].value};applySentencePresentation(draft,temporary);};
    const finish=()=>{for(const key of Object.keys(temporary))revoke(key);cover.remove();bar.remove();paper.classList.remove("is-dressing");paper.querySelectorAll("[data-art] input").forEach(el=>el.remove());paper.querySelectorAll("[data-art] button").forEach(el=>{el.hidden=true;el.onclick=null;});applySentencePresentation(topic.presentation||{});};
    bar.querySelector("[data-default]").onclick=()=>{draft={};for(const key of Object.keys(files))delete files[key];for(const key of Object.keys(temporary))revoke(key);paint();status.textContent="已预览默认装扮，保存后生效。";};
    bar.querySelector("[data-cancel]").onclick=()=>{if(!busy){topic.presentation=original;finish();}};
    bar.onsubmit=async event=>{event.preventDefault();if(busy)return;busy=true;bar.querySelectorAll("button,input").forEach(el=>el.disabled=true);paper.querySelectorAll("[data-art] button").forEach(el=>el.disabled=true);status.textContent="正在保存…";
      try{
        for(const [key,file] of Object.entries(files)){
          const response=await fetch(`${base}/assets/${encodeURIComponent(topic.id)}`,{method:"POST",headers:{"content-type":"application/octet-stream","x-file-name":encodeURIComponent(file.name),"x-alt-text":encodeURIComponent("句子册装饰")},body:file});
          const result=await response.json();if(!response.ok)throw new Error(result.error||"图片上传失败");draft[`${key}Path`]="assets/"+result.filename;
        }
        await api.api(`${base}/topics/${encodeURIComponent(topic.id)}`,{method:"PATCH",body:JSON.stringify({presentation:draft})});
        topic.presentation=structuredClone(draft);finish();renderBookshelf();message("句子册装扮已保存");
      }catch(error){status.textContent=error.message||"保存失败，预览已保留，可以重试或取消。";}
      finally{busy=false;bar.querySelectorAll("button,input").forEach(el=>el.disabled=false);paper.querySelectorAll("[data-art] button").forEach(el=>el.disabled=false);}
    };
    paint();
  }

  function openCropper(file, key, {onApply, onCancel}) {
    const url=URL.createObjectURL(file),dialog=document.createElement("dialog");dialog.className="sentence-crop-dialog";
    const ratio=key==="cover"?.72:key==="footer"?2.8:1.5;
    dialog.innerHTML=`<form method="dialog"><h3>调整${key==="cover"?"封面":key==="header"?"页头花图":"页尾花图"}</h3><p>框内就是保留的画面。拖动图片、调整缩放，再应用到书页预览。</p><div class="crop-stage" style="aspect-ratio:${ratio}"><img alt="待裁剪图片" draggable="false"><div class="crop-window"></div></div><label>缩放<input type="range" min="1" max="3" step=".01" value="1"></label><p role="status" class="crop-status">正在读取图片…</p><div class="crop-actions"><button value="cancel">取消</button><button class="primary" value="apply" disabled>应用裁剪</button></div></form>`;
    document.body.append(dialog);dialog.showModal();
    const img=dialog.querySelector("img"),stage=dialog.querySelector(".crop-stage"),range=dialog.querySelector("input"),status=dialog.querySelector(".crop-status"),apply=dialog.querySelector('[value="apply"]');
    let zoom=1,x=0,y=0,drag=false,last=[0,0],settled=false,ready=false,fit=1;
    const repaint=()=>{if(!ready)return;const w=stage.clientWidth,h=stage.clientHeight;fit=Math.max(w/img.naturalWidth,h/img.naturalHeight);const dw=img.naturalWidth*fit*zoom,dh=img.naturalHeight*fit*zoom;x=Math.max(-(dw-w)/2,Math.min((dw-w)/2,x));y=Math.max(-(dh-h)/2,Math.min((dh-h)/2,y));img.style.width=dw+"px";img.style.height=dh+"px";img.style.transform=`translate(calc(-50% + ${x}px),calc(-50% + ${y}px))`;};
    img.onload=()=>{if(img.naturalWidth*img.naturalHeight>60000000){status.textContent="图片尺寸过大，请缩小后再试。";return;}ready=true;apply.disabled=false;status.textContent="应用裁剪只改变预览，书页保存后才生效。";repaint();};
    img.onerror=()=>{status.textContent="这张图片无法读取，请取消后换一张。";};img.src=url;
    range.oninput=()=>{zoom=Number(range.value);repaint();};
    stage.onpointerdown=e=>{if(!ready)return;e.preventDefault();drag=true;last=[e.clientX,e.clientY];stage.setPointerCapture(e.pointerId);};
    stage.onpointermove=e=>{if(!drag)return;x+=e.clientX-last[0];y+=e.clientY-last[1];last=[e.clientX,e.clientY];repaint();};
    stage.onpointerup=stage.onpointercancel=()=>{drag=false;};
    const observer=new ResizeObserver(repaint);observer.observe(stage);
    dialog.querySelector("form").onsubmit=e=>{e.preventDefault();if(e.submitter?.value==="cancel"){dialog.close();return;}if(!ready)return;apply.disabled=true;repaint();const canvas=document.createElement("canvas");canvas.width=key==="cover"?720:1200;canvas.height=Math.round(canvas.width/ratio);const ctx=canvas.getContext("2d"),scale=fit*zoom,w=stage.clientWidth,h=stage.clientHeight,sx=(img.naturalWidth*scale-w)/2-x,sy=(img.naturalHeight*scale-h)/2-y;
      ctx.drawImage(img,sx/scale,sy/scale,w/scale,h/scale,0,0,canvas.width,canvas.height);
      canvas.toBlob(blob=>{if(!blob){status.textContent="裁剪失败，请重试。";apply.disabled=false;return;}settled=true;dialog.close();onApply(blob);},"image/png");
    };
    dialog.addEventListener("close",()=>{observer.disconnect();URL.revokeObjectURL(url);dialog.remove();if(!settled)onCancel();},{once:true});
  }

  $("#upload-note-image").addEventListener("click", async event => {
    const button = event.currentTarget;
    const form = $("#note-form");
    const file = $("#note-image").files[0];
    const status = $("#image-upload-status");
    status.dataset.kind = "";
    if (!file) {
      status.textContent = "请先选择一张图片。";
      status.dataset.kind = "error";
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      status.textContent = "这张图片超过 20 MB，请压缩后再试。";
      status.dataset.kind = "error";
      return;
    }
    const topicId = form.elements.topicId.value;
    if (!topicId) {
      status.textContent = "还没有确定图片所属主题，请重新打开这一页。";
      status.dataset.kind = "error";
      return;
    }
    button.disabled = true;
    status.textContent = "正在把图片放入当前主题……";
    try {
      const response = await fetch(`${base}/assets/${encodeURIComponent(topicId)}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-alt-text": encodeURIComponent($("#note-image-alt").value.trim() || "笔记图片"),
        },
        body: file,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "图片上传失败");
      insertAtCursor(form.elements.body, result.markdown);
      $("#note-image").value = "";
      status.textContent = result.deduplicated ? "这张图片已在主题中，已插入正文。" : "图片已放入当前主题，并插入正文；保存笔记后显示。";
    } catch (error) {
      status.textContent = error.message;
      status.dataset.kind = "error";
    } finally {
      button.disabled = false;
    }
  });
  document.querySelectorAll("[data-close-dialog]").forEach(button => {
    button.addEventListener("click", () => { const dialog = button.closest("dialog"); if (dialog) { formError(dialog.querySelector("form")); dialog.close(); } });
  });
  async function showLibrary() {
    pageShell?.removeAttribute("data-sentence-reading");
    workspace.hidden = true; reader.hidden = true; shelfStage.hidden = false; libraryHeading.hidden = false; toolbar.hidden = false; notice.hidden = false; state.currentTopic = null; state.currentNote = null;
    await loadStatus();
    $("#new-topic").focus();
  }
  $("#back").onclick = showLibrary;
  $("#reader-back").onclick = () => { reader.hidden = true; workspace.hidden = false; };
  $("#reader-index").onclick = () => { reader.hidden = true; workspace.hidden = false; };
  $("#previous-note").onclick = event => event.currentTarget.dataset.note && readNote(event.currentTarget.dataset.note);
  $("#next-note").onclick = event => event.currentTarget.dataset.note && readNote(event.currentTarget.dataset.note);
  let previousReadingBudget = readingBudget();
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nextBudget = readingBudget();
      if (!state.currentNote || nextBudget === previousReadingBudget) return;
      previousReadingBudget = nextBudget;
      state.readingPage = 0;
      buildReadingPages();
      renderReadingPage();
    }, 120);
  });

  $("#topic-form").addEventListener("submit", async event => {
    event.preventDefault();
    const target = event.currentTarget, form = new FormData(target), topicId = String(form.get("topicId") || "");
    formError(target);
    try {
      await api.api(topicId ? `${base}/topics/${encodeURIComponent(topicId)}` : `${base}/topics`, { method: topicId ? "PATCH" : "POST", body: JSON.stringify({ name: form.get("name"), description: form.get("description"), kind: form.get("kind") || "standard", coverPath: form.get("coverPath"), isDefault: Boolean(form.get("isDefault")), visibility: form.get("sealed") ? "sealed" : "visible", ...(topicId ? { archived: Boolean(form.get("archived")) } : {}) }) });
      topicDialog.close(); await loadStatus(); message(topicId ? "主题设置已保存" : "主题已创建");
    } catch (error) { formError(target, error.message); }
  });

  $("#note-form").addEventListener("input",event=>{
    const form=event.currentTarget;if(state.currentTopic?.kind!=="sentence-book"||form.elements.noteId.value)return;
    const draft={};for(const key of ["body","speaker","collector","note","note_author","conversation_title","tags"])draft[key]=form.elements[key]?.value||"";
    try{sessionStorage.setItem(`sentence-draft:${memoryId}:${state.currentTopic.id}`,JSON.stringify(draft));}catch{}
  });
  noteDialog.addEventListener("cancel",event=>{if($("#note-form").dataset.busy)event.preventDefault();});
  $("#note-form").addEventListener("submit", async event => {
    event.preventDefault();
    const target = event.currentTarget, form = new FormData(target), topicId = form.get("topicId"), noteId = String(form.get("noteId") || "");
    formError(target);
    if(target.dataset.busy) return;
    target.dataset.busy="true";
    target.querySelectorAll("button").forEach(button=>button.disabled=true);
    try {
      const metadata = state.currentTopic?.kind === "sentence-book" ? { ...(noteId ? state.currentNote?.metadata || {} : {}) } : undefined;
      if(metadata&&!noteId){target.dataset.sourceToken ||= `sentence:${crypto.randomUUID()}`;metadata.source_id=target.dataset.sourceToken;}
      if (metadata) for (const key of ["speaker", "collector", "note", "note_author", "conversation_title"]) metadata[key] = String(form.get(key) ?? "");
      const payload = { topicId, title: metadata ? String(form.get("conversation_title") || form.get("body") || "句子收藏").trim().slice(0,80) : form.get("title"), body: form.get("body"), ...(metadata ? { metadata } : {}), tags: String(form.get("tags") || "").split(/[，,]/).map(value => value.trim()).filter(Boolean), visibility: form.get("sealed") ? "sealed" : "visible" };
      if (noteId) payload.expectedRevision = Number(form.get("expectedRevision"));
      let saved;
      if(metadata&&!noteId&&target.dataset.pendingWrite){
        const rows=await api.api(`${base}/topics/${encodeURIComponent(topicId)}/entries`);
        const match=rows.find(row=>row.metadata?.source_id===target.dataset.sourceToken);
        if(!match)throw Error("上次保存结果仍未确认，已暂停重复写入。请稍后再次点击核对。");
        saved=await api.api(`${base}/entries/${encodeURIComponent(match.id)}`);
      }else{
        if(metadata&&!noteId)localStorage.setItem(`sentence-pending:${memoryId}:${topicId}`,JSON.stringify(payload));
        try{saved=await api.api(noteId ? `${base}/entries/${encodeURIComponent(noteId)}` : `${base}/entries`, { method: noteId ? "PATCH" : "POST", body: JSON.stringify(payload) });}
        catch(error){if(metadata&&!noteId){target.dataset.pendingWrite="true";target.elements.save.textContent="重新读取核对";}throw error;}
      }
      if(metadata&&!noteId)localStorage.removeItem(`sentence-pending:${memoryId}:${topicId}`);
      delete target.dataset.pendingWrite;delete target.dataset.sourceToken;
      if(metadata&&!noteId){try{sessionStorage.removeItem(`sentence-draft:${memoryId}:${topicId}`);}catch{}const view=sentenceViews.get(topicId);if(view){view.q="";view.page=1;}}
      noteDialog.close(); await loadStatus(); await openTopic(topicId);
      if (saved.visibility === "visible") await readNote(saved.id);
    } catch (error) { formError(target, error.message); }
    finally { delete target.dataset.busy;target.querySelectorAll("button").forEach(button=>button.disabled=false); }
  });

  async function unsealNote(noteId) {
    try {
      const saved = await api.api(`${base}/entries/${encodeURIComponent(noteId)}/visibility`, { method: "PATCH", body: JSON.stringify({ visibility: "visible" }) });
      await loadStatus(); await openTopic(saved.topicId); message(`《${saved.title}》已解除封存`);
    } catch (error) { message(error.message, "error"); }
  }

  $("#search-form").addEventListener("submit", async event => {
    event.preventDefault();
    const query = $("#search").value.trim(), topicId = $("#search-topic").value, tags = $("#search-tags").value.trim();
    if (!query && !tags) return loadStatus();
    try {
      const params = new URLSearchParams({ q: query, tags });
      if (topicId) params.set("topicId", topicId);
      const data = await api.api(`${base}/search?${params}`);
      state.currentTopic = null;
      state.currentEntries = data.matches || [];
      const description = [query && `“${query}”`, tags && `标签 ${tags}`, topicId && "当前主题"].filter(Boolean).join(" · ");
      $("#topic-kicker").textContent = `${data.matchCount} 条匹配 · 跨主题目录`;
      $("#topic-title").textContent = "检索目录";
      $("#topic-description").textContent = `${description || "全部主题"} · 找到 ${data.matchCount} 篇`;
      workspace.dataset.stamp = `SEARCH · ${data.matchCount}`;
      $("#new-note").hidden = true;
      renderDirectory(state.currentEntries, { includeTopic: true });
      shelfStage.hidden = true; libraryHeading.hidden = true; toolbar.hidden = true; notice.hidden = true; reader.hidden = true; workspace.hidden = false;
      $("#back").focus();
    } catch (error) { message(error.message, "error"); }
  });

  loadStatus().catch(error => message(error.message, "error"));
})();
